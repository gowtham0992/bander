import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  GmailReplyAdapter,
  buildPinnedReply,
  type GmailBoundary,
  type ResolvedInboundEmail,
} from "./gmail.js";

const inbound: ResolvedInboundEmail = {
  messageId: "gmail-private-message",
  threadId: "gmail-private-thread",
  latestThreadMessageId: "gmail-private-message",
  rfcMessageId: "<inbound@example.test>",
  references: ["<older@example.test>"],
  replyRecipient: "ruth@example.test",
  subject: "Lunch",
};

function effect() {
  return buildPinnedReply({ source: inbound, body: "Tuesday at noon works.", stableMessageId: "<bander-fixed@example.invalid>" });
}

class Boundary implements GmailBoundary {
  sends = 0;
  latest = inbound.latestThreadMessageId;
  sentMatches: unknown[] = [];
  async resolveInbound() { return inbound; }
  async latestThreadMessageId() { return this.latest; }
  async sendReply() { this.sends += 1; return { accepted: true as const }; }
  async findSentByReconciliationToken() { return this.sentMatches as any; }
}

describe("exact Gmail reply", () => {
  it("pins_recipient_body_and_stable_message_id_before_approval", () => {
    const reply = effect();
    expect(reply.recipient).toBe("ruth@example.test");
    expect(reply.body).toBe("Tuesday at noon works.");
    expect(reply.rfcMessageId).toBe("<bander-fixed@example.invalid>");
    expect(reply.reconciliationToken).toMatch(/^[a-f0-9]{64}$/);
    expect(reply.mimeDigest).toBe(createHash("sha256").update(Buffer.from(reply.rawMimeBase64Url, "base64url")).digest("hex"));
  });

  it("newer_thread_message_refuses_before_send", async () => {
    const boundary = new Boundary();
    boundary.latest = "newer-private-message";
    const adapter = new GmailReplyAdapter(boundary);
    await expect(adapter.execute("operation-1", effect())).rejects.toMatchObject({ code: "thread_changed" });
    expect(boundary.sends).toBe(0);
  });

  it("lost_response_never_sends_twice_and_reconciles_by_stable_message_id", async () => {
    const boundary = new Boundary();
    boundary.sendReply = async () => { boundary.sends += 1; throw Object.assign(new Error("lost"), { ambiguous: true }); };
    boundary.sentMatches = [{ recipient: "ruth@example.test", threadId: inbound.threadId, subject: "Re: Lunch", body: "Tuesday at noon works.", rfcMessageId: "<gmail-rewritten@example.test>", reconciliationToken: effect().reconciliationToken }];
    const adapter = new GmailReplyAdapter(boundary);
    const first = await adapter.execute("operation-2", effect());
    const replay = await adapter.execute("operation-2", effect());
    expect(first.status).toBe("observed_target");
    expect(replay).toEqual(first);
    expect(boundary.sends).toBe(1);
  });

  it("reply_all_cc_bcc_and_header_injection_are_impossible", () => {
    expect(() => buildPinnedReply({ source: { ...inbound, replyRecipient: "a@example.test, b@example.test" }, body: "ok", stableMessageId: "<bander-fixed@example.invalid>" })).toThrow();
    expect(() => buildPinnedReply({ source: { ...inbound, subject: "Lunch\r\nBcc: x@example.test" }, body: "ok", stableMessageId: "<bander-fixed@example.invalid>" })).toThrow();
  });

  it("ambiguous_transport_without_one_exact_sent_match_is_terminal_and_not_retried", async () => {
    const boundary = new Boundary();
    boundary.sendReply = async () => { boundary.sends += 1; throw Object.assign(new Error("lost"), { ambiguous: true }); };
    const adapter = new GmailReplyAdapter(boundary);
    await expect(adapter.execute("operation-ambiguous", effect())).rejects.toMatchObject({ code: "send_ambiguous" });
    await expect(adapter.execute("operation-ambiguous", effect())).rejects.toMatchObject({ code: "send_ambiguous" });
    expect(boundary.sends).toBe(1);
  });

  it("operation_identity_rejects_changed_body_or_regenerated_message_id", async () => {
    const boundary = new Boundary();
    const adapter = new GmailReplyAdapter(boundary);
    await adapter.execute("operation-stable", effect());
    const changedBody = buildPinnedReply({ source: inbound, body: "Different words", stableMessageId: "<bander-fixed@example.invalid>" });
    const changedId = buildPinnedReply({ source: inbound, body: "Tuesday at noon works.", stableMessageId: "<regenerated@example.invalid>" });
    await expect(adapter.execute("operation-stable", changedBody)).rejects.toMatchObject({ code: "invalid_reply" });
    await expect(adapter.execute("operation-stable", changedId)).rejects.toMatchObject({ code: "invalid_reply" });
    expect(boundary.sends).toBe(1);
  });

  it("rejects_mutated_approved_mime_bytes", async () => {
    const boundary = new Boundary();
    const adapter = new GmailReplyAdapter(boundary);
    await expect(adapter.execute("operation-mutated", { ...effect(), rawMimeBase64Url: Buffer.from("changed").toString("base64url") })).rejects.toMatchObject({ code: "invalid_reply" });
    expect(boundary.sends).toBe(0);
  });
});
