import { createHash } from "node:crypto";
import type { EmailReplyEffect } from "@bander/contracts";

export type ResolvedInboundEmail = {
  messageId: string;
  threadId: string;
  latestThreadMessageId: string;
  rfcMessageId: string;
  references: string[];
  replyRecipient: string;
  subject: string;
};

export type SentReplyObservation = {
  recipient: string;
  threadId: string;
  subject: string;
  body: string;
  rfcMessageId: string;
  reconciliationToken: string;
};

export interface GmailBoundary {
  resolveInbound(input: { senderHint: string | null; subjectHint: string | null; startLocalDate: string; endLocalDateExclusive: string }): Promise<ResolvedInboundEmail[]> | Promise<ResolvedInboundEmail>;
  latestThreadMessageId(threadId: string): Promise<string>;
  sendReply(input: { threadId: string; rawMimeBase64Url: string }): Promise<{ accepted: true }>;
  findSentByReconciliationToken(reconciliationToken: string): Promise<SentReplyObservation[]>;
}

export class GmailReplyError extends Error {
  constructor(readonly code: "thread_changed" | "send_ambiguous" | "send_rejected" | "invalid_reply", message: string) {
    super(message);
    this.name = "GmailReplyError";
  }
}

function cleanHeader(value: string, maximum: number): string {
  if (/[\r\n]/.test(value)) throw new GmailReplyError("invalid_reply", "Email headers cannot contain line breaks");
  const safe = value.normalize("NFKC").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();
  if (!safe || safe.length > maximum) throw new GmailReplyError("invalid_reply", "Email header is invalid");
  return safe;
}

function address(value: string): string {
  const safe = cleanHeader(value, 254).toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(safe)) {
    throw new GmailReplyError("invalid_reply", "Email reply recipient must be one address");
  }
  if (/(?:^|[._-])(?:no-?reply|do-?not-?reply)(?:[._+-]|@)/i.test(safe)) {
    throw new GmailReplyError("invalid_reply", "This sender does not accept replies");
  }
  return safe;
}

function messageId(value: string): string {
  const safe = cleanHeader(value, 250);
  if (!/^<[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[A-Za-z0-9.-]+>$/.test(safe)) {
    throw new GmailReplyError("invalid_reply", "Email Message-ID is invalid");
  }
  return safe;
}

function body(value: string): string {
  const safe = value.normalize("NFKC").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  if (!safe || safe.length > 2000) throw new GmailReplyError("invalid_reply", "Email reply must be between 1 and 2000 characters");
  return safe;
}

function encodedSubject(value: string): string {
  return /^[\x20-\x7e]+$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function buildPinnedReply(input: {
  source: ResolvedInboundEmail;
  body: string;
  stableMessageId: string;
}): EmailReplyEffect {
  const recipient = address(input.source.replyRecipient);
  const subjectSource = cleanHeader(input.source.subject, 200);
  const subject = /^re:/i.test(subjectSource) ? subjectSource : `Re: ${subjectSource}`;
  const inReplyTo = messageId(input.source.rfcMessageId);
  const references = [...input.source.references, inReplyTo].map(messageId).slice(-20);
  const rfcMessageId = messageId(input.stableMessageId);
  const reconciliationToken = createHash("sha256").update(rfcMessageId, "utf8").digest("hex");
  const replyBody = body(input.body);
  const raw = [
    `To: ${recipient}`,
    `Subject: ${encodedSubject(subject)}`,
    `Message-ID: ${rfcMessageId}`,
    `X-Bander-Operation: ${reconciliationToken}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${references.join(" ")}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    replyBody.replace(/\n/g, "\r\n"),
    "",
  ].join("\r\n");
  const bytes = Buffer.from(raw, "utf8");
  return {
    type: "email.reply",
    sourceMessageId: cleanHeader(input.source.messageId, 200),
    threadId: cleanHeader(input.source.threadId, 200),
    latestThreadMessageId: cleanHeader(input.source.latestThreadMessageId, 200),
    recipient,
    subject,
    inReplyTo,
    references,
    body: replyBody,
    rfcMessageId,
    reconciliationToken,
    rawMimeBase64Url: bytes.toString("base64url"),
    mimeDigest: createHash("sha256").update(bytes).digest("hex"),
  };
}

type Operation = {
  digest: string;
  status: "dispatching" | "committed" | "observed_target" | "ambiguous" | "rejected";
};

function effectDigest(effect: EmailReplyEffect): string {
  return createHash("sha256").update(JSON.stringify(effect), "utf8").digest("hex");
}

function exactObservation(effect: EmailReplyEffect, matches: SentReplyObservation[]): boolean {
  return matches.length === 1 &&
    matches[0]!.recipient.toLowerCase() === effect.recipient &&
    matches[0]!.threadId === effect.threadId &&
    matches[0]!.subject === effect.subject &&
    matches[0]!.body === effect.body &&
    matches[0]!.reconciliationToken === effect.reconciliationToken;
}

export class GmailReplyAdapter {
  readonly #operations = new Map<string, Operation>();
  constructor(readonly boundary: GmailBoundary) {}

  async execute(operationId: string, effect: EmailReplyEffect): Promise<{ status: "committed" | "observed_target" }> {
    const digest = effectDigest(effect);
    const existing = this.#operations.get(operationId);
    if (existing) {
      if (existing.digest !== digest) throw new GmailReplyError("invalid_reply", "Email operation identity was reused with different content");
      if (existing.status === "committed" || existing.status === "observed_target") return { status: existing.status };
      if (existing.status === "rejected") {
        throw new GmailReplyError("send_rejected", "The email service rejected the approved reply");
      }
      throw new GmailReplyError("send_ambiguous", "Bander could not confirm whether the email reply was sent");
    }
    if (createHash("sha256").update(Buffer.from(effect.rawMimeBase64Url, "base64url")).digest("hex") !== effect.mimeDigest) {
      throw new GmailReplyError("invalid_reply", "The approved email bytes changed");
    }
    if (await this.boundary.latestThreadMessageId(effect.threadId) !== effect.latestThreadMessageId) {
      throw new GmailReplyError("thread_changed", "The email thread changed since the reply was prepared");
    }
    this.#operations.set(operationId, { digest, status: "dispatching" });
    try {
      await this.boundary.sendReply({ threadId: effect.threadId, rawMimeBase64Url: effect.rawMimeBase64Url });
      this.#operations.set(operationId, { digest, status: "committed" });
      return { status: "committed" };
    } catch (error) {
      if (!error || typeof error !== "object" || Reflect.get(error, "ambiguous") !== true) {
        this.#operations.set(operationId, { digest, status: "rejected" });
        throw new GmailReplyError("send_rejected", "The email service rejected the approved reply");
      }
      try {
        const matches = await this.boundary.findSentByReconciliationToken(effect.reconciliationToken);
        if (exactObservation(effect, matches)) {
          this.#operations.set(operationId, { digest, status: "observed_target" });
          return { status: "observed_target" };
        }
      } catch {
        // Every unreadable reconciliation result remains ambiguous.
      }
      this.#operations.set(operationId, { digest, status: "ambiguous" });
      throw new GmailReplyError("send_ambiguous", "Bander could not confirm whether the email reply was sent");
    }
  }
}
