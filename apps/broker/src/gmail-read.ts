import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { InboxReadResult } from "@bander/contracts";

export const READ_GMAIL_MODEL = "gpt-5.6-sol" as const;
export const MAX_GMAIL_READ_DAYS = 31;
export const MAX_GMAIL_RESULTS = 10;
export const MAX_GMAIL_EXCERPT = 1200;

export const GmailReadIntentSchema = z.object({
  senderHint: z.string().trim().min(1).max(120).nullable(),
  subjectHint: z.string().trim().min(1).max(160).nullable(),
  startLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  endLocalDateExclusive: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  latestOnly: z.boolean(),
  needsClarification: z.boolean(),
  clarificationQuestion: z.string().trim().min(1).max(180).nullable(),
}).strict();

export type GmailReadIntent = z.infer<typeof GmailReadIntentSchema>;

export type InternalInboundEmail = {
  internalMessageId: string;
  internalThreadId: string;
  senderName: string;
  senderAddress: string;
  subject: string;
  receivedAt: string;
  plainText: string;
};

export interface GmailReadBackend {
  search(input: {
    senderHint: string | null;
    subjectHint: string | null;
    startLocalDate: string;
    endLocalDateExclusive: string;
    maxResults: number;
  }): Promise<InternalInboundEmail[]>;
}

export interface GmailReadIntentSelector {
  select(request: string, context: { todayLocalDate: string; timeZone: string }): Promise<unknown>;
}

export class GmailReadError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "GmailReadError";
  }
}

function day(value: string): number {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new GmailReadError("invalid_range", "Which date should I check?");
  }
  return parsed / 86_400_000;
}

export function sanitizeEmailText(value: string, maximum: number): string {
  return value
    .normalize("NFKC")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function safeQuestion(value: string | null): string {
  return sanitizeEmailText(value ?? "Which email should I look for?", 180) || "Which email should I look for?";
}

export function validateGmailReadIntent(
  raw: unknown,
  _context: { todayLocalDate: string },
): GmailReadIntent & { startLocalDate: string; endLocalDateExclusive: string } {
  const intent = GmailReadIntentSchema.parse(raw);
  if (intent.needsClarification) {
    throw new GmailReadError("clarification_required", safeQuestion(intent.clarificationQuestion));
  }
  if (!intent.startLocalDate || !intent.endLocalDateExclusive || intent.clarificationQuestion !== null) {
    throw new GmailReadError("invalid_model_output", "Which date should I check?");
  }
  const days = day(intent.endLocalDateExclusive) - day(intent.startLocalDate);
  if (days <= 0) throw new GmailReadError("invalid_range", "Please ask about one clear date range.");
  if (days > MAX_GMAIL_READ_DAYS) throw new GmailReadError("range_too_large", "Please ask about email from a period of 31 days or less.");
  if (!intent.senderHint && !intent.subjectHint) {
    throw new GmailReadError("clarification_required", "Who was the email from, or what was it about?");
  }
  return intent as GmailReadIntent & { startLocalDate: string; endLocalDateExclusive: string };
}

function localDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export class GmailReadService {
  constructor(readonly options: {
    selector: GmailReadIntentSelector;
    backend: GmailReadBackend;
    timeZone: string;
    now?: () => Date;
  }) {}

  async read(request: string): Promise<InboxReadResult | { status: "clarification_required"; question: string }> {
    const context = { timeZone: this.options.timeZone, todayLocalDate: localDate((this.options.now ?? (() => new Date()))(), this.options.timeZone) };
    let intent;
    try {
      intent = validateGmailReadIntent(await this.options.selector.select(request, context), context);
    } catch (error) {
      if (error instanceof GmailReadError && error.code === "clarification_required") {
        return { status: "clarification_required", question: error.message };
      }
      throw error;
    }
    let matches: InternalInboundEmail[];
    try {
      matches = await this.options.backend.search({
        senderHint: intent.senderHint,
        subjectHint: intent.subjectHint,
        startLocalDate: intent.startLocalDate,
        endLocalDateExclusive: intent.endLocalDateExclusive,
        maxResults: MAX_GMAIL_RESULTS + 1,
      });
    } catch {
      throw new GmailReadError("gmail_unavailable", "I can’t reach your inbox right now. Please try again shortly.");
    }
    const ordered = [...matches].sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
    if (ordered.length === 0) {
      return { requestedRange: { startLocalDate: intent.startLocalDate, endLocalDateExclusive: intent.endLocalDateExclusive }, messages: [], empty: true, truncated: false, maxMessages: MAX_GMAIL_RESULTS };
    }
    if (ordered.length > 1 && !intent.latestOnly) {
      return { status: "clarification_required", question: "I found more than one matching email. Which sender, subject, or date did you mean?" };
    }
    const selected = intent.latestOnly ? ordered.slice(0, 1) : ordered.slice(0, MAX_GMAIL_RESULTS);
    return {
      requestedRange: { startLocalDate: intent.startLocalDate, endLocalDateExclusive: intent.endLocalDateExclusive },
      messages: selected.map((message) => ({
        sender: `${sanitizeEmailText(message.senderName, 80) || "Unknown sender"} <${sanitizeEmailText(message.senderAddress, 160)}>`,
        subject: sanitizeEmailText(message.subject, 160) || "(no subject)",
        receivedAt: new Date(message.receivedAt).toISOString(),
        excerpt: sanitizeEmailText(message.plainText, MAX_GMAIL_EXCERPT),
      })),
      empty: false,
      truncated: !intent.latestOnly && ordered.length > MAX_GMAIL_RESULTS,
      maxMessages: MAX_GMAIL_RESULTS,
    };
  }
}

export class OpenAISolGmailReadIntentSelector implements GmailReadIntentSelector {
  readonly #client: OpenAI;
  constructor(apiKey: string) { this.#client = new OpenAI({ apiKey, timeout: 15_000, maxRetries: 1 }); }
  async select(request: string, context: { todayLocalDate: string; timeZone: string }): Promise<unknown> {
    try {
      const response = await this.#client.responses.parse({
        model: READ_GMAIL_MODEL,
        store: false,
        reasoning: { effort: "low" },
        max_output_tokens: 260,
        instructions: [
          "Extract only bounded hints for reading one person's connected Gmail inbox.",
          "Return sender hint, subject hint, an explicit local date range, whether the person explicitly asked for the latest matching email, and clarification state.",
          `Today is ${context.todayLocalDate} in ${context.timeZone}. Resolve only unambiguous dates in that timezone.`,
          "Never emit or author a Gmail query, label, account, message ID, thread ID, recipient, email body, attachment, execution parameter, effect, authority, approval, or credential.",
          "If neither sender nor subject/topic is supplied, ask one short clarification. Limit any range to what the person requested; never broaden it.",
        ].join(" "),
        input: request,
        text: { format: zodTextFormat(GmailReadIntentSchema, "bander_gmail_read_intent") },
      });
      if (!response.output_parsed) throw new Error("missing_output");
      return response.output_parsed;
    } catch {
      throw new GmailReadError("model_unavailable", "I can’t work out that inbox search right now. Please try again shortly.");
    }
  }
}
