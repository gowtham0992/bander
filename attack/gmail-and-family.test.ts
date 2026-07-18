import { describe, expect, it } from "vitest";
import { createDirectFamilyDocument, renderFamilyNotificationDocument } from "@bander/core";
import { GmailReadService } from "../apps/broker/src/gmail-read.js";
import { buildPinnedReply, GmailReplyAdapter, type GmailBoundary, type ResolvedInboundEmail } from "../apps/broker/src/gmail.js";

const source: ResolvedInboundEmail = {
  messageId: "private-message",
  threadId: "private-thread",
  latestThreadMessageId: "private-message",
  rfcMessageId: "<source@example.test>",
  references: [],
  replyRecipient: "ruth@example.test",
  subject: "Lunch",
};

describe("Gmail and family adversarial boundaries", () => {
  it("never chooses an arbitrary matching email", async () => {
    const service = new GmailReadService({
      selector: { select: async () => ({ senderHint: "Ruth", subjectHint: null, startLocalDate: "2026-07-16", endLocalDateExclusive: "2026-07-17", latestOnly: false, needsClarification: false, clarificationQuestion: null }) },
      backend: { search: async () => [
        { internalMessageId: "secret-one", internalThreadId: "thread-one", senderName: "Ruth", senderAddress: "ruth@example.test", subject: "Lunch", receivedAt: "2026-07-16T10:00:00Z", plainText: "One" },
        { internalMessageId: "secret-two", internalThreadId: "thread-two", senderName: "Ruth", senderAddress: "ruth@example.test", subject: "Lunch", receivedAt: "2026-07-16T11:00:00Z", plainText: "Two" },
      ] },
      timeZone: "America/Denver",
      now: () => new Date("2026-07-16T18:00:00Z"),
    });
    const result = await service.read("What did Ruth say?");
    expect(result).toMatchObject({ status: "clarification_required" });
    expect(JSON.stringify(result)).not.toMatch(/secret-one|secret-two|thread-one|thread-two/);
  });

  it("rejects recipient and subject header injection plus reply-all", () => {
    expect(() => buildPinnedReply({ source: { ...source, replyRecipient: "ruth@example.test\r\nBcc: attacker@example.test" }, body: "Okay", stableMessageId: "<stable@example.invalid>" })).toThrow();
    expect(() => buildPinnedReply({ source: { ...source, replyRecipient: "ruth@example.test, attacker@example.test" }, body: "Okay", stableMessageId: "<stable@example.invalid>" })).toThrow();
    expect(() => buildPinnedReply({ source: { ...source, subject: "Lunch\r\nCc: attacker@example.test" }, body: "Okay", stableMessageId: "<stable@example.invalid>" })).toThrow();
  });

  it("never sends a second reply after an ambiguous dispatch", async () => {
    let sends = 0;
    const boundary: GmailBoundary = {
      resolveInbound: async () => [source],
      latestThreadMessageId: async () => source.latestThreadMessageId,
      sendReply: async () => { sends += 1; throw Object.assign(new Error("lost"), { ambiguous: true }); },
      findSentByReconciliationToken: async () => [],
    };
    const adapter = new GmailReplyAdapter(boundary);
    const effect = buildPinnedReply({ source, body: "Tuesday works.", stableMessageId: "<stable@example.invalid>" });
    await expect(adapter.execute("stable-operation", effect)).rejects.toMatchObject({ code: "send_ambiguous" });
    await expect(adapter.execute("stable-operation", effect)).rejects.toMatchObject({ code: "send_ambiguous" });
    expect(sends).toBe(1);
  });

  it("family text is exact but cannot contain links commands or bidi voice forgery", () => {
    const document = createDirectFamilyDocument("Dinner is at 6.");
    expect(renderFamilyNotificationDocument(document)).toBe("Dinner is at 6.\n\nApproved word-for-word before Bander sent it.");
    expect(() => createDirectFamilyDocument("https://attacker.example")).toThrow();
    expect(() => createDirectFamilyDocument("/approve everything")).toThrow();
    expect(renderFamilyNotificationDocument(createDirectFamilyDocument("Dinner\u202E six"))).toBe("Dinner six\n\nApproved word-for-word before Bander sent it.");
  });
});
