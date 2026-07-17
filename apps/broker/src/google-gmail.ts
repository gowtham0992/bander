import { google, type gmail_v1 } from "googleapis";
import type { GmailReadBackend, InternalInboundEmail } from "./gmail-read.js";
import type { GmailBoundary, ResolvedInboundEmail, SentReplyObservation } from "./gmail.js";

type OAuthClient = InstanceType<typeof google.auth.OAuth2>;

export class GmailDispatchUnconfirmedError extends Error {
  readonly ambiguous = true;

  constructor() {
    super("gmail_send_result_unconfirmed");
    this.name = "GmailDispatchUnconfirmedError";
  }
}

function header(headers: gmail_v1.Schema$MessagePartHeader[] | null | undefined, name: string): string {
  return headers?.find((candidate) => candidate.name?.toLowerCase() === name.toLowerCase())?.value?.trim() ?? "";
}

function decodeBase64Url(value: string | null | undefined): string {
  if (!value) return "";
  try { return Buffer.from(value, "base64url").toString("utf8"); } catch { return ""; }
}

function bodyText(part: gmail_v1.Schema$MessagePart | null | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain") return decodeBase64Url(part.body?.data);
  const plain = (part.parts ?? []).map(bodyText).filter(Boolean).join("\n");
  if (plain) return plain;
  if (part.mimeType === "text/html") return decodeBase64Url(part.body?.data);
  return "";
}

function parseMailbox(value: string): { name: string; address: string } | undefined {
  if (!value || /[\r\n]/.test(value)) return undefined;
  const angle = value.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^<>\s,]+@[^<>\s,]+)>\s*$/);
  const bare = value.match(/^\s*([^<>\s,]+@[^<>\s,]+)\s*$/);
  const address = (angle?.[2] ?? bare?.[1] ?? "").toLowerCase();
  if (!address || value.includes(",")) return undefined;
  return { name: angle?.[1]?.trim() || address.split("@")[0] || "Sender", address };
}

export function localDateBoundaryEpochSeconds(value: string, timeZone: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("invalid_gmail_date");
  const [year, month, day] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(year!, month! - 1, day!, 12));
  const zone = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(probe)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = zone?.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  if (!match) throw new Error("invalid_gmail_timezone");
  const offsetMinutes = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === "+" ? 1 : -1);
  return Math.floor((Date.UTC(year!, month! - 1, day!) - offsetMinutes * 60_000) / 1000);
}

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

function rfcMessageId(value: string): string | undefined {
  const match = value.trim().match(/^<[^<>\s\r\n]+@[^<>\s\r\n]+>$/);
  return match?.[0];
}

function references(value: string): string[] {
  return [...value.matchAll(/<[^<>\s\r\n]+@[^<>\s\r\n]+>/g)].map((match) => match[0]).slice(-20);
}

export class GoogleGmailBoundary implements GmailReadBackend, GmailBoundary {
  readonly #gmail: gmail_v1.Gmail;
  #selfAddress?: string;
  #dropSuccessfulSendResponseOnce: boolean;

  constructor(
    auth: OAuthClient,
    readonly timeZone: string,
    options: { dropSuccessfulSendResponseOnce?: boolean } = {},
  ) {
    this.#gmail = google.gmail({ version: "v1", auth });
    this.#dropSuccessfulSendResponseOnce = options.dropSuccessfulSendResponseOnce === true;
  }

  async #profileAddress(): Promise<string> {
    if (this.#selfAddress) return this.#selfAddress;
    const response = await this.#gmail.users.getProfile({ userId: "me" });
    const address = response.data.emailAddress?.toLowerCase();
    if (!address) throw new Error("gmail_profile_unavailable");
    this.#selfAddress = address;
    return address;
  }

  async #messages(input: { startLocalDate: string; endLocalDateExclusive: string; maxResults: number }): Promise<gmail_v1.Schema$Message[]> {
    const response = await this.#gmail.users.messages.list({
      userId: "me",
      labelIds: ["INBOX"],
      includeSpamTrash: false,
      maxResults: Math.min(Math.max(input.maxResults, 1), 50),
      q: `after:${localDateBoundaryEpochSeconds(input.startLocalDate, this.timeZone) - 1} before:${localDateBoundaryEpochSeconds(input.endLocalDateExclusive, this.timeZone)} -in:spam -in:trash`,
    });
    return response.data.messages ?? [];
  }

  async #get(id: string): Promise<gmail_v1.Schema$Message> {
    const response = await this.#gmail.users.messages.get({ userId: "me", id, format: "full" });
    return response.data;
  }

  async search(input: { senderHint: string | null; subjectHint: string | null; startLocalDate: string; endLocalDateExclusive: string; maxResults: number }): Promise<InternalInboundEmail[]> {
    const listed = await this.#messages({ ...input, maxResults: Math.min(input.maxResults * 4, 50) });
    const resolved = await Promise.all(listed.flatMap((item) => item.id ? [this.#get(item.id)] : []));
    const senderHint = input.senderHint ? normalize(input.senderHint) : null;
    const subjectHint = input.subjectHint ? normalize(input.subjectHint) : null;
    return resolved.flatMap((message) => {
      const headers = message.payload?.headers;
      const sender = parseMailbox(header(headers, "From"));
      const subject = header(headers, "Subject");
      if (!sender || !message.id || !message.threadId || !message.internalDate) return [];
      if (senderHint && !normalize(`${sender.name} ${sender.address}`).includes(senderHint)) return [];
      if (subjectHint && !normalize(subject).includes(subjectHint)) return [];
      return [{
        internalMessageId: message.id,
        internalThreadId: message.threadId,
        senderName: sender.name,
        senderAddress: sender.address,
        subject,
        receivedAt: new Date(Number(message.internalDate)).toISOString(),
        plainText: bodyText(message.payload),
      }];
    }).sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt)).slice(0, input.maxResults);
  }

  async resolveInbound(input: { senderHint: string | null; subjectHint: string | null; startLocalDate: string; endLocalDateExclusive: string }): Promise<ResolvedInboundEmail[]> {
    const matches = await this.search({ ...input, maxResults: 11 });
    const self = await this.#profileAddress();
    return await Promise.all(matches.map(async (match) => {
      const message = await this.#get(match.internalMessageId);
      const headers = message.payload?.headers;
      const replyToValue = header(headers, "Reply-To");
      const precedence = header(headers, "Precedence").toLowerCase();
      if (header(headers, "List-Id") || header(headers, "List-Unsubscribe") || ["bulk", "list", "junk"].includes(precedence)) {
        throw new Error("mailing_list_reply_unsupported");
      }
      const recipient = parseMailbox(replyToValue || header(headers, "From"));
      const sourceRfc = rfcMessageId(header(headers, "Message-ID"));
      if (!recipient || recipient.address === self || !sourceRfc || !message.id || !message.threadId) throw new Error("unsupported_reply_headers");
      return {
        messageId: message.id,
        threadId: message.threadId,
        latestThreadMessageId: await this.latestThreadMessageId(message.threadId),
        rfcMessageId: sourceRfc,
        references: references(header(headers, "References")),
        replyRecipient: recipient.address,
        subject: header(headers, "Subject"),
      };
    }));
  }

  async latestThreadMessageId(threadId: string): Promise<string> {
    const response = await this.#gmail.users.threads.get({ userId: "me", id: threadId, format: "minimal" });
    const messages = response.data.messages ?? [];
    const latest = [...messages].sort((a, b) => Number(b.internalDate ?? 0) - Number(a.internalDate ?? 0))[0];
    if (!latest?.id) throw new Error("gmail_thread_unreadable");
    return latest.id;
  }

  async sendReply(input: { threadId: string; rawMimeBase64Url: string }): Promise<{ accepted: true }> {
    try {
      await this.#gmail.users.messages.send({ userId: "me", requestBody: { threadId: input.threadId, raw: input.rawMimeBase64Url } });
      if (this.#dropSuccessfulSendResponseOnce) {
        this.#dropSuccessfulSendResponseOnce = false;
        throw new GmailDispatchUnconfirmedError();
      }
      return { accepted: true };
    } catch (error) {
      if (error instanceof GmailDispatchUnconfirmedError) throw error;
      // Once dispatch begins, a transport/auth/rate/server error cannot prove that
      // Gmail rejected the message before accepting it. The caller may reconcile by
      // the pre-approved RFC Message-ID, but must never blindly send again.
      throw new GmailDispatchUnconfirmedError();
    }
  }

  async findSentByReconciliationToken(token: string): Promise<SentReplyObservation[]> {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("invalid_reconciliation_token");
    const listed = await this.#gmail.users.messages.list({ userId: "me", labelIds: ["SENT"], maxResults: 25, q: "newer_than:1d" });
    const messages = await Promise.all((listed.data.messages ?? []).flatMap((item) => item.id ? [this.#get(item.id)] : []));
    return messages.flatMap((message) => {
      const headers = message.payload?.headers;
      const recipient = parseMailbox(header(headers, "To"));
      const messageId = rfcMessageId(header(headers, "Message-ID"));
      const observedToken = header(headers, "X-Bander-Operation");
      if (!recipient || !message.threadId || !messageId || observedToken !== token) return [];
      return [{ recipient: recipient.address, threadId: message.threadId, subject: header(headers, "Subject"), body: bodyText(message.payload).replace(/\r\n?/g, "\n").trim(), rfcMessageId: messageId, reconciliationToken: observedToken }];
    });
  }
}
