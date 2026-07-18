import { randomBytes } from "node:crypto";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { DraftFixture } from "@bander/core";
import { createDirectFamilyDocument } from "@bander/core";
import type { DraftCompiler, FamilyContactResolver } from "./compiler.js";
import { CompilerError } from "./compiler.js";
import { buildPinnedReply, type GmailBoundary } from "./gmail.js";

export const ProductRouteSchema = z.object({
  actionKind: z.enum(["calendar", "email_reply", "direct_family", "unsupported"]),
  senderHint: z.string().trim().min(1).max(120).nullable(),
  subjectHint: z.string().trim().min(1).max(160).nullable(),
  sourceStartLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  sourceEndLocalDateExclusive: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  replyBody: z.string().trim().min(1).max(2000).nullable(),
  familyContactAlias: z.string().trim().min(1).max(80).nullable(),
  familyMessageBody: z.string().trim().min(1).max(500).nullable(),
  needsClarification: z.boolean(),
  clarification: z.string().trim().min(1).max(200).nullable(),
}).strict();

type ProductRoute = z.infer<typeof ProductRouteSchema>;

export interface ProductIntentRouter { select(request: string): Promise<unknown>; }

export function localDateInTimeZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export class OpenAISolProductIntentRouter implements ProductIntentRouter {
  readonly #client: OpenAI;
  constructor(
    apiKey: string,
    readonly timeZone: string,
    readonly now: () => Date = () => new Date(),
  ) { this.#client = new OpenAI({ apiKey, timeout: 15_000, maxRetries: 1 }); }
  async select(request: string): Promise<unknown> {
    try {
      const response = await this.#client.responses.parse({
        model: "gpt-5.6-sol",
        store: false,
        reasoning: { effort: "low" },
        max_output_tokens: 350,
        instructions: [
          "Classify one consequential Bander request as calendar, email_reply, direct_family, or unsupported.",
          "Calendar means add, move, or remove one Calendar event and may include the existing appointment-bound family update; do not extract Calendar details here.",
          "Email reply means reply in plain text to exactly one identifiable inbound email. Extract only sender hint, subject hint, bounded source local date range, and the exact reply words requested by the person.",
          "Direct family means send one plain-text message to the one connected family alias. Extract only the human alias used and the exact message content requested by the person.",
          "Never emit a Gmail query, account, message ID, thread ID, recipient address, Telegram ID, chat ID, destination, MIME, headers, Message-ID, effect, execution parameter, authority, approval, permit, receipt, or idempotency value.",
          "Reply-all, forwarding, new outbound email, CC, BCC, attachments, HTML, multiple recipients, arbitrary links, commands, reservations, purchases, payments, and mixed unrelated effects are unsupported.",
          "Pronoun-only or missing family recipients and missing email identity/body/date require one short clarification.",
          `Today is ${localDateInTimeZone(this.now(), this.timeZone)} in ${this.timeZone}. Resolve relative dates only from that explicit local date.`,
        ].join(" "),
        input: request,
        text: { format: zodTextFormat(ProductRouteSchema, "bander_product_action_route") },
      });
      if (!response.output_parsed) throw new Error("missing_output");
      return response.output_parsed;
    } catch {
      throw new CompilerError("model_unavailable", "GPT-5.6 Sol is temporarily unavailable.");
    }
  }
}

function safe(value: string): string {
  return value.normalize("NFKC").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 180);
}

export class RealProductDraftCompiler implements DraftCompiler {
  constructor(readonly options: {
    router: ProductIntentRouter;
    calendar: DraftCompiler;
    gmail: GmailBoundary;
    familyContacts: FamilyContactResolver;
    createMessageId?: () => string;
  }) {}

  async compile(request: string): Promise<DraftFixture> {
    let route: ProductRoute;
    try { route = ProductRouteSchema.parse(await this.options.router.select(request)); }
    catch (error) {
      if (error instanceof CompilerError) throw error;
      throw new CompilerError("invalid_model_output", "The model did not return one bounded product action.");
    }
    if (route.actionKind === "calendar") return this.options.calendar.compile(request);
    if (route.needsClarification) {
      const human = safe(route.clarification ?? "What should I clarify?") || "What should I clarify?";
      throw new CompilerError("clarification_required", human, `${human}\nBander didn’t do anything.`);
    }
    if (route.actionKind === "unsupported") {
      const human = safe(route.clarification ?? "I can’t prepare that action safely.") || "I can’t prepare that action safely.";
      throw new CompilerError("unsupported_request", human, `${human}\nBander didn’t do anything.`);
    }
    if (route.actionKind === "direct_family") {
      if (!route.familyContactAlias || !route.familyMessageBody || route.senderHint || route.subjectHint || route.replyBody) {
        throw new CompilerError("invalid_model_output", "The family message intent was malformed.");
      }
      const binding = this.options.familyContacts.resolve(route.familyContactAlias);
      if (!binding) {
        const label = this.options.familyContacts.activeDisplayLabel?.();
        const human = label
          ? `I can’t message ${safe(route.familyContactAlias)} yet. Right now Bander can only message ${safe(label)}.`
          : "I can’t message family yet. Ask the person who set up Bander to connect someone first.";
        throw new CompilerError("clarification_required", human, `${human}\nBander didn’t do anything.`);
      }
      let document;
      try { document = createDirectFamilyDocument(route.familyMessageBody); }
      catch { throw new CompilerError("unsupported_request", "That family message contains something Bander can’t send safely.", "That family message contains something Bander can’t send safely.\nBander didn’t do anything."); }
      return { id: "real-direct-family", claimedUserRequest: request, familyNotification: { ...binding, document } };
    }
    if (!route.senderHint && !route.subjectHint) {
      throw new CompilerError("clarification_required", "Which email should I reply to?", "Which email should I reply to?\nBander didn’t do anything.");
    }
    if (!route.sourceStartLocalDate || !route.sourceEndLocalDateExclusive || !route.replyBody || route.familyContactAlias || route.familyMessageBody) {
      throw new CompilerError("clarification_required", "Which email and exact reply should I use?", "Which email and exact reply should I use?\nBander didn’t do anything.");
    }
    let matches;
    try {
      matches = await this.options.gmail.resolveInbound({ senderHint: route.senderHint, subjectHint: route.subjectHint, startLocalDate: route.sourceStartLocalDate, endLocalDateExclusive: route.sourceEndLocalDateExclusive });
    } catch {
      throw new CompilerError("unsupported_request", "I couldn’t safely resolve reply details for that email.", "I couldn’t safely resolve reply details for that email.\nBander didn’t do anything.");
    }
    const candidates = Array.isArray(matches) ? matches : [matches];
    if (candidates.length === 0) throw new CompilerError("clarification_required", "I couldn’t find that email. Which sender, subject, or date should I use?", "I couldn’t find that email. Which sender, subject, or date should I use?\nBander didn’t do anything.");
    if (candidates.length !== 1) throw new CompilerError("clarification_required", "I found more than one matching email. Which one should I reply to?", "I found more than one matching email. Which one should I reply to?\nBander didn’t do anything.");
    const stableMessageId = this.options.createMessageId?.() ?? `<bander.${randomBytes(16).toString("hex")}@bander.invalid>`;
    let reply;
    try { reply = buildPinnedReply({ source: candidates[0]!, body: route.replyBody, stableMessageId }); }
    catch { throw new CompilerError("unsupported_request", "That email can’t receive Bander’s narrow one-person reply.", "That email can’t receive Bander’s narrow one-person reply.\nBander didn’t do anything."); }
    return { id: "real-gmail-reply", claimedUserRequest: request, emailReply: reply };
  }
}
