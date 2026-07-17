import { describe, expect, it, vi } from "vitest";
import type { DraftCompiler, FamilyContactResolver } from "./compiler.js";
import type { GmailBoundary, ResolvedInboundEmail } from "./gmail.js";
import { RealProductDraftCompiler, localDateInTimeZone, type ProductIntentRouter } from "./product-compiler.js";

const inbound: ResolvedInboundEmail = {
  messageId: "private-source-id",
  threadId: "private-thread-id",
  latestThreadMessageId: "private-source-id",
  rfcMessageId: "<clinic-1@example.test>",
  references: [],
  replyRecipient: "ruth@example.test",
  subject: "Lunch next week",
};

const family: FamilyContactResolver = {
  resolve: (alias) => alias.toLowerCase() === "gil" || alias.toLowerCase() === "my son"
    ? { installationId: "install-private", contactId: "contact-private", pairingRevision: "revision-private", displayLabel: "Gil" }
    : undefined,
  activeDisplayLabel: () => "Gil",
};

function compiler(route: unknown, overrides: Partial<{ gmail: GmailBoundary; familyContacts: FamilyContactResolver }> = {}) {
  const router: ProductIntentRouter = { select: vi.fn(async () => route) };
  const calendar: DraftCompiler = { compile: vi.fn(async () => ({ id: "calendar", claimedUserRequest: "calendar" })) };
  const gmail: GmailBoundary = overrides.gmail ?? {
    resolveInbound: vi.fn(async () => [inbound]),
    latestThreadMessageId: vi.fn(async () => inbound.latestThreadMessageId),
    sendReply: vi.fn(async () => ({ accepted: true as const })),
    findSentByReconciliationToken: vi.fn(async () => []),
  };
  return new RealProductDraftCompiler({
    router,
    calendar,
    gmail,
    familyContacts: overrides.familyContacts ?? family,
    createMessageId: () => "<bander-stable@example.invalid>",
  });
}

const replyRoute = {
  actionKind: "email_reply",
  senderHint: "Ruth",
  subjectHint: "lunch",
  sourceStartLocalDate: "2026-07-16",
  sourceEndLocalDateExclusive: "2026-07-24",
  replyBody: "Tuesday at noon works for me.",
  familyContactAlias: null,
  familyMessageBody: null,
  needsClarification: false,
  clarification: null,
} as const;

describe("real product compiler boundaries", () => {
  it("resolves relative-date context in the configured timezone", () => {
    expect(localDateInTimeZone(new Date("2026-07-17T05:30:00.000Z"), "America/Denver")).toBe("2026-07-16");
    expect(localDateInTimeZone(new Date("2026-07-17T06:30:00.000Z"), "America/Denver")).toBe("2026-07-17");
  });

  it("pins_one_resolved_email_recipient_and_exact_body_before_approval", async () => {
    const fixture = await compiler(replyRoute).compile("Reply to Ruth that Tuesday at noon works");
    expect(fixture.emailReply).toMatchObject({
      recipient: "ruth@example.test",
      body: "Tuesday at noon works for me.",
      rfcMessageId: "<bander-stable@example.invalid>",
      threadId: "private-thread-id",
    });
  });

  it("model_cannot_select_email_recipient_or_gmail_identity", async () => {
    await expect(compiler({ ...replyRoute, recipient: "attacker@example.test" }).compile("reply")).rejects.toMatchObject({ code: "invalid_model_output" });
    await expect(compiler({ ...replyRoute, threadId: "attacker" }).compile("reply")).rejects.toMatchObject({ code: "invalid_model_output" });
  });

  it("ambiguous_email_selection_creates_no_fixture", async () => {
    const gmail = {
      resolveInbound: vi.fn(async () => [inbound, { ...inbound, messageId: "other" }]),
      latestThreadMessageId: vi.fn(), sendReply: vi.fn(), findSentByReconciliationToken: vi.fn(),
    } as unknown as GmailBoundary;
    await expect(compiler(replyRoute, { gmail }).compile("reply")).rejects.toMatchObject({ code: "clarification_required" });
  });

  it("family_destination_is_resolved_only_by_bander", async () => {
    const fixture = await compiler({
      ...replyRoute,
      actionKind: "direct_family",
      senderHint: null,
      subjectHint: null,
      sourceStartLocalDate: null,
      sourceEndLocalDateExclusive: null,
      replyBody: null,
      familyContactAlias: "my son",
      familyMessageBody: "Dinner is at 6.",
    }).compile("Tell my son dinner is at 6");
    expect(fixture.familyNotification).toEqual({
      installationId: "install-private",
      contactId: "contact-private",
      pairingRevision: "revision-private",
      displayLabel: "Gil",
      document: { kind: "direct_message", body: "Dinner is at 6." },
    });
  });

  it("model_cannot_supply_family_routing", async () => {
    await expect(compiler({
      ...replyRoute,
      actionKind: "direct_family",
      senderHint: null,
      subjectHint: null,
      sourceStartLocalDate: null,
      sourceEndLocalDateExclusive: null,
      replyBody: null,
      familyContactAlias: "Gil",
      familyMessageBody: "Dinner is at 6.",
      chatId: "attacker",
    }).compile("tell Gil")).rejects.toMatchObject({ code: "invalid_model_output" });
  });

  it("revoked_or_unpaired_family_contact_clarifies_without_a_fixture", async () => {
    const disconnected: FamilyContactResolver = { resolve: () => undefined, activeDisplayLabel: () => undefined };
    await expect(compiler({
      ...replyRoute,
      actionKind: "direct_family",
      senderHint: null,
      subjectHint: null,
      sourceStartLocalDate: null,
      sourceEndLocalDateExclusive: null,
      replyBody: null,
      familyContactAlias: "Gil",
      familyMessageBody: "Dinner is at 6.",
    }, { familyContacts: disconnected }).compile("tell Gil")).rejects.toMatchObject({ code: "clarification_required" });
  });
});
