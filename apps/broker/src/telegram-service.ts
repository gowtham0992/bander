import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import type {
  AgentReceipt,
  ApprovalCard,
  FamilyTelegramNotificationEffect,
  HumanReceipt,
  StandingBandCard,
} from "@bander/contracts";
import {
  AuthorityEngine,
  AuthorityError,
  formatCalendarIntervalWithContext,
  KeyedLock,
} from "@bander/core";
import type { DraftFixture, StandingRunResult } from "@bander/core";
import {
  acceptFamilyContactChallenge,
  callbackMatchesHash,
  claimFamilyContactChallenge,
  createFamilyContactChallenge,
  FamilyContactError,
  isRevokedContactSurface,
  revokeActiveFamilyContact,
  tokenMatchesFamilyChallenge,
  validateFamilyContactState,
  type ActiveFamilyContact,
  type FamilyContactPairingChallenge,
  type ProtectedGroupMemberStatus,
  type RevokedFamilyContactAudit,
} from "./family-contact.js";
import {
  deliveryResult,
  notificationDigest,
  pairingRevision,
  parseFamilyNotificationDocument,
  renderFamilyNotification,
  sameFamilyBinding,
  type FamilyNotificationDocument,
  type FamilyNotificationOperation,
} from "./family-notification.js";

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  chat_shared?: { request_id: number; chat_id: number };
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramBotApi {
  getMe(): Promise<TelegramUser>;
  getChat(chatId: string): Promise<TelegramChat>;
  getChatMember(
    chatId: string,
    userId: string,
  ): Promise<{ status: ProtectedGroupMemberStatus }>;
  getUpdates(offset?: number, timeout?: number): Promise<TelegramUpdate[]>;
  sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: Record<string, unknown>,
  ): Promise<TelegramMessage>;
  answerCallback(
    callbackQueryId: string,
    text: string,
    showAlert?: boolean,
  ): Promise<boolean>;
}

export class TelegramHttpApi implements TelegramBotApi {
  readonly #token: string;

  constructor(token: string) {
    if (!token) throw new Error("Bander Telegram token is required");
    this.#token = token;
  }

  async #call<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.#token}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(method === "getUpdates" ? 35_000 : 20_000),
      },
    );
    const payload = (await response.json()) as {
      ok?: boolean;
      result?: T;
    };
    if (!response.ok || payload.ok !== true || payload.result === undefined) {
      throw new Error(`Telegram ${method} failed`);
    }
    return payload.result;
  }

  getMe(): Promise<TelegramUser> {
    return this.#call("getMe");
  }

  getChat(chatId: string): Promise<TelegramChat> {
    return this.#call("getChat", { chat_id: chatId });
  }

  getChatMember(
    chatId: string,
    userId: string,
  ): Promise<{ status: ProtectedGroupMemberStatus }> {
    const numericUserId = Number(userId);
    if (!Number.isSafeInteger(numericUserId) || numericUserId <= 0) {
      throw new Error("Telegram user ID is invalid");
    }
    return this.#call("getChatMember", {
      chat_id: chatId,
      user_id: numericUserId,
    });
  }

  getUpdates(offset?: number, timeout = 25): Promise<TelegramUpdate[]> {
    return this.#call("getUpdates", {
      ...(offset === undefined ? {} : { offset }),
      limit: 100,
      timeout,
      allowed_updates: ["message", "callback_query"],
    });
  }

  sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: Record<string, unknown>,
  ): Promise<TelegramMessage> {
    return this.#call("sendMessage", {
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  answerCallback(
    callbackQueryId: string,
    text: string,
    showAlert = true,
  ): Promise<boolean> {
    return this.#call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
      cache_time: 0,
    });
  }
}

export interface TelegramInstallation {
  id: string;
  ownerTelegramId: string;
  chatId: string;
  pairedAt: string;
}

export interface TelegramPairingChallenge {
  installationId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  ownerTelegramId?: string;
  ownerPrivateChatId?: string;
  chatRequestId?: number;
  consumedAt?: string;
}

export interface TelegramProposalBinding {
  installationId: string;
  ownerTelegramId: string;
  chatId: string;
  messageId: number;
  callbackValue: string;
  declineCallbackValue: string;
  draftId: string;
  draftHash: string;
  expiresAt: string;
  lifecycle: "pending" | "executed" | "declined" | "conflict" | "expired";
  receiptId?: string;
  receiptDeliveredAt?: string;
  declineDeliveredAt?: string;
  conflictMessage?: string;
  conflictDeliveredAt?: string;
}

export interface TelegramStandingBandBinding {
  installationId: string;
  ownerTelegramId: string;
  chatId: string;
  bandId: string;
  activatedAt: string;
}

export interface TelegramStandingCandidateBinding {
  installationId: string;
  ownerTelegramId: string;
  chatId: string;
  botTelegramId: string;
  messageId: number;
  approveCallbackValue: string;
  declineCallbackValue: string;
  candidateId: string;
  predicateHash: string;
  expiresAt: string;
  lifecycle: "pending" | "activated" | "declined" | "expired";
  bandId?: string;
  activationDeliveredAt?: string;
  declineDeliveredAt?: string;
  expiryDeliveredAt?: string;
}

export interface TelegramStandingOutcomeBinding {
  installationId: string;
  ownerTelegramId: string;
  chatId: string;
  bandId: string;
  requestId: string;
  draftId: string;
  receiptId: string;
  callbackValue: string;
  lifecycle: "pending_delivery" | "delivered" | "revoked";
  createdAt: string;
  messageId?: number;
  deliveredAt?: string;
  revokedAt?: string;
  revocationDeliveredAt?: string;
}

export interface TelegramServiceState {
  version: 1;
  nextUpdateId?: number;
  installation?: TelegramInstallation;
  pairing?: TelegramPairingChallenge;
  proposals: TelegramProposalBinding[];
  standingCandidates: TelegramStandingCandidateBinding[];
  standingBand?: TelegramStandingBandBinding;
  oneTimeReviewMode?: { detachedBandId: string; activatedAt: string };
  standingOutcomes: TelegramStandingOutcomeBinding[];
  familyPairing?: FamilyContactPairingChallenge;
  familyContact?: ActiveFamilyContact;
  familyContactAudit?: RevokedFamilyContactAudit;
  familyNotifications?: FamilyNotificationOperation[];
}

export interface TelegramServiceStore {
  read(): TelegramServiceState;
  write(state: TelegramServiceState): void;
}

function emptyState(): TelegramServiceState {
  return {
    version: 1,
    proposals: [],
    standingCandidates: [],
    standingOutcomes: [],
    familyNotifications: [],
  };
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryTelegramServiceStore implements TelegramServiceStore {
  #state = emptyState();

  read(): TelegramServiceState {
    return copy(this.#state);
  }

  write(state: TelegramServiceState): void {
    this.#state = copy(state);
  }
}

export class FileTelegramServiceStore implements TelegramServiceStore {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = path.resolve(filePath);
  }

  read(): TelegramServiceState {
    if (!fs.existsSync(this.#filePath)) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(this.#filePath, "utf8")) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { version?: unknown }).version !== 1 ||
      !Array.isArray((parsed as { proposals?: unknown }).proposals)
    ) {
      throw new Error("Unsupported Telegram service state");
    }
    const state = parsed as TelegramServiceState;
    if (
      !Array.isArray(state.standingCandidates ?? []) ||
      !Array.isArray(state.standingOutcomes ?? []) ||
      !Array.isArray(state.familyNotifications ?? [])
    ) {
      throw new Error("Unsupported Telegram service state");
    }
    validateFamilyContactState({
      ...(state.installation ? { installation: state.installation } : {}),
      ...(state.familyPairing ? { familyPairing: state.familyPairing } : {}),
      ...(state.familyContact ? { familyContact: state.familyContact } : {}),
      ...(state.familyContactAudit
        ? { familyContactAudit: state.familyContactAudit }
        : {}),
    });
    return copy({
      ...state,
      standingCandidates: state.standingCandidates ?? [],
      standingOutcomes: state.standingOutcomes ?? [],
      familyNotifications: state.familyNotifications ?? [],
    });
  }

  write(state: TelegramServiceState): void {
    const directory = path.dirname(this.#filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const temporary = `${this.#filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, this.#filePath);
    fs.chmodSync(this.#filePath, 0o600);
  }
}

type TelegramCopyMode = "verification" | "hero" | "real";

interface TelegramServiceOptions {
  api: TelegramBotApi;
  engine: AuthorityEngine;
  store: TelegramServiceStore;
  mode?: TelegramCopyMode;
  now?: () => Date;
  randomValue?: () => string;
  familyPairingPath?: string;
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function secretMatches(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(value), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function chatRequestId(tokenHash: string): number {
  return (Number.parseInt(tokenHash.slice(0, 8), 16) & 0x7fffffff) || 1;
}

function startToken(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = text.match(/^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{8,64})$/);
  return match?.[1];
}

function familyStartToken(value: string): string | undefined {
  const match = value.match(/^family_([A-Za-z0-9_-]{16,48})$/);
  return match?.[1];
}

function knownMemberStatus(
  value: string,
): ProtectedGroupMemberStatus {
  return [
    "creator",
    "administrator",
    "member",
    "restricted",
    "left",
    "kicked",
  ].includes(value)
    ? (value as ProtectedGroupMemberStatus)
    : "unknown";
}

function cardText(
  card: ApprovalCard,
  now: Date,
  mode: TelegramCopyMode,
): string {
  const effects = card.effectPreviews.flatMap((effect) => {
    if (effect.kind === "calendar.reschedule_event") {
      return [
        `• Move “${safeDisplayText(effect.eventTitle)}”`,
        `${safeDisplayText(effect.previousInterval)} → ${safeDisplayText(effect.resultingInterval)}`,
      ];
    }
    return effect.kind === "family.telegram_notification"
      ? [
          `• Send ${firstName(effect.recipientDisplayName)}:`,
          `“${safeMultilineDisplayText(effect.body)}”`,
        ]
      : [
          `• Send ${firstName(effect.recipientDisplayName)}:`,
          `“${safeDisplayText(effect.body)}”`,
        ];
  });
  const minutes = Math.max(
    1,
    Math.ceil((new Date(card.expiresAt).getTime() - now.getTime()) / 60_000),
  );
  if (mode === "hero") {
    const approvedBoundary =
      card.effectPreviews.length === 1
        ? "Only this change is approved."
        : card.effectPreviews.length === 2
          ? "Only these two changes are approved."
          : `Only these ${card.effectPreviews.length} changes are approved.`;
    const heroEffects = card.effectPreviews.flatMap((effect) => {
      if (effect.kind === "calendar.reschedule_event") {
        return [
          `📅 Move “${safeDisplayText(effect.eventTitle)}”`,
          `${safeDisplayText(effect.previousInterval)} → ${safeDisplayText(effect.resultingInterval)}`,
        ];
      }
      return effect.kind === "family.telegram_notification"
        ? [
            `💬 Send ${firstName(effect.recipientDisplayName)}:`,
            `“${safeMultilineDisplayText(effect.body)}”`,
          ]
        : [
            `💬 Send ${firstName(effect.recipientDisplayName)}:`,
            `“${safeDisplayText(effect.body)}”`,
          ];
    });
    return [
      "Ready to approve?",
      "",
      "OpenClaw asked Bander to:",
      ...heroEffects,
      "",
      approvedBoundary,
      `Closes in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
    ].join("\n");
  }
  return [
    "Nothing has happened yet. Is this right?",
    "",
    "OpenClaw says you asked:",
    `“${safeDisplayText(card.claimedUserRequest)}”`,
    "",
    "Through Bander, this will:",
    ...effects,
    "",
    ...(mode === "real"
      ? ["Nothing else will change."]
      : ["Not included:", "• Any other events, messages or payments"]),
    "",
    `Closes in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
  ].join("\n");
}

function compactReceiptInterval(
  interval: { startTime: string; endTime: string },
  timeZone: string,
): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
  const start = formatter.format(new Date(interval.startTime));
  const end = formatter.format(new Date(interval.endTime));
  const startMeridiem = start.match(/ (AM|PM)$/)?.[1];
  const endMeridiem = end.match(/ (AM|PM)$/)?.[1];
  return `${startMeridiem === endMeridiem ? start.replace(/ (AM|PM)$/, "") : start}–${end}`;
}

function receiptText(
  receipt: HumanReceipt,
  mode: TelegramCopyMode,
): string {
  if (mode === "hero") {
    return [
      "Done ✓",
      `📅 “${safeDisplayText(receipt.calendar.title)}” is now ${compactReceiptInterval(
        receipt.calendar.completed,
        receipt.calendar.timeZone,
      )}.`,
      ...(receipt.message
        ? [
            `💬 Sent ${firstName(receipt.message.recipientDisplayName)}:`,
            `“${safeDisplayText(receipt.message.body)}”`,
          ]
        : ["No one was messaged."]),
    ].join("\n");
  }
  if (receipt.familyNotification) {
    if (receipt.familyNotification.status === "ambiguous") {
      return [
        "Calendar updated ✓",
        `“${safeDisplayText(receipt.calendar.title)}” is now ${formatCalendarIntervalWithContext(
          receipt.calendar.completed.startTime,
          receipt.calendar.completed.endTime,
          receipt.calendar.timeZone,
        )}.`,
        `I couldn’t confirm whether ${firstName(receipt.familyNotification.recipientDisplayName)} received the update, so I won’t send it again automatically.`,
      ].join("\n");
    }
    if (receipt.familyNotification.status === "not_sent") {
      return [
        "Calendar updated ✓",
        `“${safeDisplayText(receipt.calendar.title)}” is now ${formatCalendarIntervalWithContext(
          receipt.calendar.completed.startTime,
          receipt.calendar.completed.endTime,
          receipt.calendar.timeZone,
        )}.`,
        `${firstName(receipt.familyNotification.recipientDisplayName)} was no longer connected, so no family update was sent.`,
      ].join("\n");
    }
    return [
      receipt.calendar.executionStatus === "observed_target"
        ? "Calendar confirmed at the approved time ✓"
        : "Done ✓",
      `“${safeDisplayText(receipt.calendar.title)}”`,
      `${formatCalendarIntervalWithContext(
        receipt.calendar.previous.startTime,
        receipt.calendar.previous.endTime,
        receipt.calendar.timeZone,
      )} → ${formatCalendarIntervalWithContext(
        receipt.calendar.completed.startTime,
        receipt.calendar.completed.endTime,
        receipt.calendar.timeZone,
      )}`,
      `Sent ${firstName(receipt.familyNotification.recipientDisplayName)} the approved update.`,
      "Nothing else changed through Bander.",
    ].join("\n");
  }
  return [
    "Done ✓",
    `“${safeDisplayText(receipt.calendar.title)}”`,
    `${formatCalendarIntervalWithContext(
      receipt.calendar.previous.startTime,
      receipt.calendar.previous.endTime,
      receipt.calendar.timeZone,
    )} → ${formatCalendarIntervalWithContext(
      receipt.calendar.completed.startTime,
      receipt.calendar.completed.endTime,
      receipt.calendar.timeZone,
    )}`,
    ...(receipt.message
      ? [
          `Sent ${firstName(receipt.message.recipientDisplayName)}:`,
          `“${safeDisplayText(receipt.message.body)}”`,
        ]
      : [
          mode === "real"
            ? "No one was messaged through Bander."
            : "No messages were sent.",
        ]),
    "Nothing else changed through Bander.",
  ].join("\n");
}

function safeDisplayText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeMultilineDisplayText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => safeDisplayText(line))
    .join("\n")
    .trim();
}

function firstName(value: string): string {
  return safeDisplayText(value).split(" ")[0] ?? "them";
}

function refusalText(
  code: string,
  card: ApprovalCard,
  mode: TelegramCopyMode,
): string {
  if (code === "draft_expired") {
    return mode === "hero"
      ? "That request timed out, so I did nothing.\nAsk OpenClaw again if you still want it."
      : "That request expired. Nothing happened.\nAsk OpenClaw to prepare it again.";
  }
  if (code !== "conflict") {
    return [
      "Stopped — nothing changed through Bander",
      "I couldn’t safely complete that request.",
      "Ask OpenClaw to prepare it again.",
    ].join("\n");
  }
  if (mode === "real") {
    const includesFamily = card.effectPreviews.some(
      (effect) => effect.kind === "family.telegram_notification",
    );
    return [
      "I stopped—your calendar changed since you asked.",
      includesFamily
        ? "Nothing was moved, and no family update was sent."
        : "Nothing was moved.",
      "Ask OpenClaw to check again.",
    ].join("\n");
  }
  const includesMessage = card.effectPreviews.some(
    (effect) => effect.kind === "messages.send",
  );
  return [
    "Stopped — your calendar changed",
    includesMessage
      ? "I didn’t move the event or send the message."
      : "I didn’t move the event.",
    "Ask OpenClaw to check again.",
  ].join("\n");
}

function declineText(mode: TelegramCopyMode): string {
  return mode === "hero"
    ? "Nothing changed."
    : "Nothing changed.\nAsk OpenClaw again if you want something different.";
}

function standingOutcomeText(
  receipt: HumanReceipt,
  actionsUsed: number,
  maxActions: number,
): string {
  return [
    "Handled automatically ✓",
    "",
    `“${receipt.calendar.title}”`,
    `${formatCalendarIntervalWithContext(
      receipt.calendar.previous.startTime,
      receipt.calendar.previous.endTime,
      receipt.calendar.timeZone,
    )} → ${formatCalendarIntervalWithContext(
      receipt.calendar.completed.startTime,
      receipt.calendar.completed.endTime,
      receipt.calendar.timeZone,
    )}`,
    "",
    "No one was messaged.",
    `${actionsUsed} of ${maxActions} automatic moves used today.`,
  ].join("\n");
}

const supportedStandingOptInRequests = new Set([
  "handle my focus time automatically",
  "let bander handle my focus time automatically",
]);

function normalizedNaturalRequest(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "")
    .toLocaleLowerCase("en-US");
}

function standingCandidateText(card: StandingBandCard): string {
  const ends = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "America/Denver",
  }).format(new Date(card.expiresAt));
  return [
    "Would you like me to handle this automatically?",
    "",
    "I would only:",
    ...card.clauses.map((clause) => `• ${clause}`),
    "",
    `Ends ${ends}. You can turn this off anytime.`,
  ].join("\n");
}

export class TelegramService {
  readonly #api: TelegramBotApi;
  readonly #engine: AuthorityEngine;
  readonly #store: TelegramServiceStore;
  readonly #now: () => Date;
  readonly #randomValue: () => string;
  readonly #mode: TelegramCopyMode;
  readonly #familyPairingPath: string | undefined;
  readonly #stateLock = new KeyedLock();
  readonly #stateLockContext = new AsyncLocalStorage<boolean>();
  readonly #callbackLock = new KeyedLock();
  readonly #standingRequestLock = new KeyedLock();
  #running = false;
  #loop: Promise<void> | undefined;

  constructor(options: TelegramServiceOptions) {
    this.#api = options.api;
    this.#engine = options.engine;
    this.#store = options.store;
    this.#mode = options.mode ?? "verification";
    this.#now = options.now ?? (() => new Date());
    this.#randomValue =
      options.randomValue ?? (() => randomBytes(24).toString("base64url"));
    this.#familyPairingPath = options.familyPairingPath
      ? path.resolve(options.familyPairingPath)
      : undefined;
  }

  async createPairing(ttlMinutes = 10): Promise<{ link: string; expiresAt: string }> {
    const state = this.#store.read();
    if (state.installation) throw new Error("Telegram installation is already paired");
    const bot = await this.#api.getMe();
    if (!bot.is_bot || !bot.username) throw new Error("Telegram bot username is unavailable");
    const token = this.#randomValue();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) {
      throw new Error("Pairing token generator returned an invalid value");
    }
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
    state.pairing = {
      installationId: this.#randomValue(),
      tokenHash: hashSecret(token),
      createdAt: now.toISOString(),
      expiresAt,
    };
    this.#store.write(state);
    return {
      link: `https://t.me/${bot.username}?start=${token}`,
      expiresAt,
    };
  }

  async createFamilyContactPairing(input: {
    displayLabel: string;
    aliases: readonly string[];
    ttlMinutes?: number;
  }): Promise<{ link: string; expiresAt: string }> {
    return this.#stateLock.run("telegram-state", async () => {
      const state = this.#store.read();
      const installation = state.installation;
      if (!installation) {
        throw new FamilyContactError(
          "installation_missing",
          "Pair the Bander owner and group before adding a family contact",
        );
      }
      if (state.familyContact) {
        throw new FamilyContactError(
          "family_contact_already_active",
          "Disconnect the current family contact before adding another",
        );
      }
      const now = this.#now();
      if (
        state.familyPairing &&
        now.getTime() < Date.parse(state.familyPairing.expiresAt)
      ) {
        throw new FamilyContactError(
          "family_pairing_already_pending",
          "A family contact pairing link is already pending",
        );
      }
      const token = this.#randomValue();
      const challengeId = this.#randomValue();
      const contactId = this.#randomValue();
      const ttlMinutes = input.ttlMinutes ?? 10;
      const challenge = createFamilyContactChallenge({
        installationId: installation.id,
        displayLabel: input.displayLabel,
        aliases: input.aliases,
        token,
        challengeId,
        contactId,
        now,
        ttlMs: ttlMinutes * 60_000,
      });
      const bot = await this.#api.getMe();
      if (!bot.is_bot || !bot.username) {
        throw new FamilyContactError(
          "telegram_bot_unavailable",
          "Bander could not establish its Telegram identity",
        );
      }
      state.familyPairing = challenge;
      this.#store.write(state);
      return {
        link: `https://t.me/${bot.username}?start=family_${token}`,
        expiresAt: challenge.expiresAt,
      };
    });
  }

  familyContactStatus():
    | { status: "not_connected" }
    | { status: "connected"; displayLabel: string }
    | { status: "revoked" } {
    const state = this.#store.read();
    if (state.familyContact) {
      return {
        status: "connected",
        displayLabel: state.familyContact.displayLabel,
      };
    }
    return state.familyContactAudit
      ? { status: "revoked" }
      : { status: "not_connected" };
  }

  resolveFamilyContactAlias(
    alias: string,
  ): FamilyTelegramNotificationEffect["binding"] | undefined {
    const normalized = safeDisplayText(alias).toLocaleLowerCase("en-US");
    const state = this.#store.read();
    const installation = state.installation;
    const contact = state.familyContact;
    if (
      !normalized ||
      !installation ||
      !contact ||
      contact.status !== "active" ||
      contact.installationId !== installation.id ||
      !contact.aliases.includes(normalized)
    ) {
      return undefined;
    }
    return {
      installationId: contact.installationId,
      contactId: contact.contactId,
      pairingRevision: pairingRevision(contact),
      displayLabel: contact.displayLabel,
    };
  }

  async prepareForStart(): Promise<void> {
    await this.#stateLock.run("telegram-state", async () => {
      const state = this.#store.read();
      for (const operation of state.familyNotifications ?? []) {
        if (operation.status === "dispatching") {
          operation.status = "ambiguous";
          operation.ambiguousAt = this.#now().toISOString();
          this.#store.write(state);
        }
      }
      const now = this.#now();
      if (!state.familyPairing) {
        this.#removeFamilyPairingLink();
      } else if (
        state.familyPairing &&
        now.getTime() >= Date.parse(state.familyPairing.expiresAt)
      ) {
        delete state.familyPairing;
        this.#removeFamilyPairingLink();
        this.#store.write(state);
      }
      const active = state.familyContact;
      const installation = state.installation;
      if (!active) return;
      if (!installation || active.installationId !== installation.id) {
        throw new FamilyContactError(
          "installation_mismatch",
          "The active family contact does not belong to this installation",
        );
      }
      const status = await this.#protectedGroupStatus(
        installation.chatId,
        active.telegramUserId,
      );
      if (status === "unknown") {
        throw new FamilyContactError(
          "protected_group_membership_unavailable",
          "Bander could not verify that the family contact is outside the protected owner group",
        );
      }
      if (status !== "left" && status !== "kicked") {
        this.#revokeFamilyContactInState(state, "system");
        return;
      }
      await this.#deliverFamilyContactConfirmations(state);
    });
  }

  async deliverFamilyNotification(input: { requestId: string; document: unknown }): Promise<{ status: "delivered" | "ambiguous" | "not_sent" }> {
    return this.#stateLock.run("telegram-state", async () => {
      const state = this.#store.read();
      const installation = state.installation;
      const contact = state.familyContact;
      if (!installation || !contact || contact.installationId !== installation.id || contact.status !== "active") throw new FamilyContactError("family_contact_unavailable", "No active family contact is available");
      return this.#deliverBoundFamilyNotificationLocked(state, {
        ...input,
        binding: {
          installationId: contact.installationId,
          contactId: contact.contactId,
          pairingRevision: pairingRevision(contact),
          displayLabel: contact.displayLabel,
        },
      });
    });
  }

  async deliverBoundFamilyNotification(input: {
    requestId: string;
    binding: FamilyTelegramNotificationEffect["binding"];
    document: unknown;
  }): Promise<{ status: "delivered" | "ambiguous" | "not_sent" }> {
    if (this.#stateLockContext.getStore() === true) {
      return this.#deliverBoundFamilyNotificationLocked(this.#store.read(), input);
    }
    return this.#stateLock.run("telegram-state", async () =>
      this.#deliverBoundFamilyNotificationLocked(this.#store.read(), input),
    );
  }

  async #deliverBoundFamilyNotificationLocked(
    state: TelegramServiceState,
    input: {
      requestId: string;
      binding: FamilyTelegramNotificationEffect["binding"];
      document: unknown;
    },
  ): Promise<{ status: "delivered" | "ambiguous" | "not_sent" }> {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId)) throw new FamilyContactError("invalid_delivery_request", "A valid delivery request ID is required");
    const document = parseFamilyNotificationDocument(input.document);
    const digest = notificationDigest(document);
    state.familyNotifications ??= [];
    const existing = state.familyNotifications.find((item) => item.requestId === input.requestId);
    if (existing) {
      if (existing.contentDigest !== digest || !sameFamilyBinding(existing, input.binding)) throw new FamilyContactError("delivery_request_content_mismatch", "This delivery request ID has different content or contact");
      if (existing.status === "dispatching") { existing.status = "ambiguous"; existing.ambiguousAt = this.#now().toISOString(); this.#store.write(state); }
      return deliveryResult(existing);
    }
    const contact = state.familyContact;
    const exactContact = contact && contact.status === "active" && contact.installationId === input.binding.installationId && contact.contactId === input.binding.contactId && pairingRevision(contact) === input.binding.pairingRevision;
    const operation: FamilyNotificationOperation = { requestId: input.requestId, installationId: input.binding.installationId, contactId: input.binding.contactId, pairingRevision: input.binding.pairingRevision, contentDigest: digest, document, status: exactContact ? "prepared" : "not_sent", createdAt: this.#now().toISOString() };
    state.familyNotifications.push(operation);
    this.#store.write(state);
    if (!exactContact) return deliveryResult(operation);
    operation.status = "dispatching";
    operation.dispatchStartedAt = this.#now().toISOString();
    this.#store.write(state);
    try {
      const sent = await this.#api.sendMessage(contact.privateChatId, renderFamilyNotification(document));
      operation.status = "delivered";
      operation.telegramMessageId = sent.message_id;
      operation.deliveredAt = this.#now().toISOString();
      this.#store.write(state);
    } catch {
      operation.status = "ambiguous";
      operation.ambiguousAt = this.#now().toISOString();
      this.#store.write(state);
    }
    return deliveryResult(operation);
  }

  async #protectedGroupStatus(
    chatId: string,
    userId: string,
  ): Promise<ProtectedGroupMemberStatus> {
    try {
      const result = await this.#api.getChatMember(chatId, userId);
      return knownMemberStatus(result.status);
    } catch {
      return "unknown";
    }
  }

  #removeFamilyPairingLink(): void {
    if (this.#familyPairingPath) {
      fs.rmSync(this.#familyPairingPath, { force: true });
    }
  }

  async #deliverFamilyContactConfirmations(
    state: TelegramServiceState,
  ): Promise<void> {
    let contact = state.familyContact;
    const installation = state.installation;
    if (!contact || !installation) return;
    if (!contact.contactConfirmationDeliveredAt) {
      const sent = await this.#api.sendMessage(
        contact.privateChatId,
        [
          `You’re connected as ${safeDisplayText(contact.displayLabel)}.`,
          "In a future update, Bander may send you a short update only after the person who invited you approves it.",
          "No notifications are enabled yet.",
          "You cannot approve anything or see their calendar or conversations.",
          "You can disconnect anytime.",
        ].join("\n"),
        {
          inline_keyboard: [
            [
              {
                text: "Disconnect",
                callback_data: contact.contactRevokeCallbackValue,
              },
            ],
          ],
        },
      );
      contact = {
        ...contact,
        contactConfirmationMessageId: sent.message_id,
        contactConfirmationDeliveredAt: this.#now().toISOString(),
      };
      state.familyContact = contact;
      this.#store.write(state);
    }
    if (!contact.ownerConfirmationDeliveredAt) {
      const sent = await this.#api.sendMessage(
        installation.chatId,
        [
          `${safeDisplayText(contact.displayLabel)} is connected.`,
          "No notifications are enabled yet.",
          "A future approved deal may include a short update to this contact.",
        ].join("\n"),
        {
          inline_keyboard: [
            [
              {
                text: `Disconnect ${safeDisplayText(contact.displayLabel)}`,
                callback_data: contact.ownerRevokeCallbackValue,
              },
            ],
          ],
        },
      );
      state.familyContact = {
        ...contact,
        ownerConfirmationMessageId: sent.message_id,
        ownerConfirmationDeliveredAt: this.#now().toISOString(),
      };
      this.#store.write(state);
    }
  }

  #revokeFamilyContactInState(
    state: TelegramServiceState,
    revokedBy: "owner" | "contact" | "system",
  ): ActiveFamilyContact | undefined {
    const contact = state.familyContact;
    if (!contact) return undefined;
    state.familyContactAudit = revokeActiveFamilyContact(contact, {
      now: this.#now(),
      revokedBy,
    });
    delete state.familyContact;
    delete state.familyPairing;
    this.#removeFamilyPairingLink();
    this.#store.write(state);
    return contact;
  }

  async deliverProposal(card: ApprovalCard): Promise<void> {
    await this.#stateLock.run("telegram-state", async () => {
      const state = this.#store.read();
      const installation = state.installation;
      if (!installation) throw new Error("Telegram installation is not paired");
      if (state.proposals.some((proposal) => proposal.draftId === card.draftId)) return;
      const callbackValue = `bander:${this.#randomValue()}`;
      const declineCallbackValue = `bander-no:${this.#randomValue()}`;
      if (
        Buffer.byteLength(callbackValue, "utf8") > 64 ||
        Buffer.byteLength(declineCallbackValue, "utf8") > 64
      ) {
        throw new Error("Telegram callback value exceeds 64 bytes");
      }
      const message = await this.#api.sendMessage(
        installation.chatId,
        cardText(card, this.#now(), this.#mode),
        {
          inline_keyboard: [
            [
              {
                text: this.#mode === "hero" ? "Yes, do this" : "Do exactly this",
                callback_data: callbackValue,
              },
              { text: "Not now", callback_data: declineCallbackValue },
            ],
          ],
        },
      );
      state.proposals.push({
        installationId: installation.id,
        ownerTelegramId: installation.ownerTelegramId,
        chatId: installation.chatId,
        messageId: message.message_id,
        callbackValue,
        declineCallbackValue,
        draftId: card.draftId,
        draftHash: card.draftHash,
        expiresAt: card.expiresAt,
        lifecycle: "pending",
      });
      this.#store.write(state);
    });
  }

  async deliverClarification(message: string): Promise<void> {
    await this.#stateLock.run("telegram-state", async () => {
      const installation = this.#store.read().installation;
      if (!installation) throw new Error("Telegram installation is not paired");
      const text = message
        .normalize("NFKC")
        .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
        .replace(/\r\n?/g, "\n")
        .trim()
        .slice(0, 800);
      if (!text) throw new Error("Bander clarification is empty");
      await this.#api.sendMessage(installation.chatId, text);
    });
  }

  async proposeStandingOptIn(
    request: string,
  ): Promise<{ status: "proposed" } | undefined> {
    if (!supportedStandingOptInRequests.has(normalizedNaturalRequest(request))) {
      return undefined;
    }
    return this.#stateLock.run("telegram-state", async () => {
      const state = this.#store.read();
      const installation = state.installation;
      if (!installation) throw new Error("Telegram installation is not paired");
      const existing = state.standingCandidates.find(
        (candidate) =>
          candidate.installationId === installation.id &&
          candidate.lifecycle === "pending" &&
          this.#now().getTime() < new Date(candidate.expiresAt).getTime(),
      );
      if (existing) return { status: "proposed" as const };

      const card = this.#engine.createStandingBandCandidate();
      const bot = await this.#api.getMe();
      if (!bot.is_bot) throw new Error("Bander Telegram identity is unavailable");
      const approveCallbackValue = `bander-auto:${this.#randomValue()}`;
      const declineCallbackValue = `bander-each:${this.#randomValue()}`;
      if (
        Buffer.byteLength(approveCallbackValue, "utf8") > 64 ||
        Buffer.byteLength(declineCallbackValue, "utf8") > 64
      ) {
        throw new Error("Telegram callback value exceeds 64 bytes");
      }
      const message = await this.#api.sendMessage(
        installation.chatId,
        standingCandidateText(card),
        {
          inline_keyboard: [
            [
              {
                text: "Turn on automatic",
                callback_data: approveCallbackValue,
              },
              {
                text: "Ask me each time",
                callback_data: declineCallbackValue,
              },
            ],
          ],
        },
      );
      state.standingCandidates.push({
        installationId: installation.id,
        ownerTelegramId: installation.ownerTelegramId,
        chatId: installation.chatId,
        botTelegramId: String(bot.id),
        messageId: message.message_id,
        approveCallbackValue,
        declineCallbackValue,
        candidateId: card.candidateId,
        predicateHash: card.predicateHash,
        expiresAt: card.expiresAt,
        lifecycle: "pending",
      });
      this.#store.write(state);
      return { status: "proposed" as const };
    });
  }

  async activateStandingBand(bandId: string): Promise<void> {
    await this.#stateLock.run("telegram-state", async () => {
      const state = this.#store.read();
      const installation = state.installation;
      if (!installation) throw new Error("Telegram installation is not paired");
      const summary = this.#engine.getStandingBandSummary(bandId);
      if (summary.status !== "active") {
        throw new AuthorityError(
          "standing_band_inactive",
          "This standing Band is not active",
          409,
        );
      }
      if (state.standingBand?.bandId === bandId) return;
      if (state.standingBand) {
        const existing = this.#engine.getStandingBandSummary(
          state.standingBand.bandId,
        );
        if (existing.status === "active") {
          throw new AuthorityError(
            "standing_band_already_active",
            "This installation already has an active standing Band",
            409,
          );
        }
      }
      state.standingBand = {
        installationId: installation.id,
        ownerTelegramId: installation.ownerTelegramId,
        chatId: installation.chatId,
        bandId,
        activatedAt: this.#now().toISOString(),
      };
      delete state.oneTimeReviewMode;
      this.#store.write(state);
    });
  }

  async runStandingAction(
    fixture: DraftFixture,
    requestId: string | undefined,
    agentId = "openclaw-reference",
  ): Promise<AgentReceipt | undefined> {
    const configured = this.#store.read().standingBand;
    if (!configured) return undefined;
    let summary: ReturnType<AuthorityEngine["getStandingBandSummary"]>;
    try {
      summary = this.#engine.getStandingBandSummary(configured.bandId);
    } catch (error) {
      if (
        error instanceof AuthorityError &&
        error.code === "standing_band_not_found"
      ) {
        await this.#detachStandingBand(configured.bandId);
        return undefined;
      }
      throw error;
    }
    if (summary.status !== "active") {
      await this.#detachStandingBand(configured.bandId);
      return undefined;
    }
    if (!requestId) {
      throw new AuthorityError(
        "invalid_standing_request_id",
        "A valid client request ID is required",
        400,
      );
    }
    return this.#standingRequestLock.run(
      `${configured.bandId}:${requestId}`,
      async () => {
        let result: StandingRunResult;
        try {
          result = await this.#engine.runStandingBand(
            configured.bandId,
            fixture,
            requestId,
            agentId,
          );
        } catch (error) {
          if (error instanceof AuthorityError) {
            if (
              error.code === "standing_band_inactive" ||
              error.code === "standing_band_not_found"
            ) {
              await this.#detachStandingBand(configured.bandId);
              return undefined;
            }
            const minimalStatus = this.#engine.getStandingAgentReceipt(
              configured.bandId,
              requestId,
            );
            if (minimalStatus?.status === "conflict") return minimalStatus;
          }
          throw error;
        }
        if (result.status === "review_required") {
          await this.deliverProposal(result.card);
          return this.#engine.getAgentReceipt(result.card.draftId);
        }

        summary = this.#engine.getStandingBandSummary(configured.bandId);
        let outcome = await this.#stateLock.run("telegram-state", async () => {
          const state = this.#store.read();
          const installation = state.installation;
          const active = state.standingBand;
          if (
            !installation ||
            !active ||
            active.bandId !== configured.bandId ||
            active.installationId !== installation.id
          ) {
            throw new AuthorityError(
              "standing_installation_changed",
              "The standing Telegram installation changed",
              409,
            );
          }
          const existing = state.standingOutcomes.find(
            (candidate) =>
              candidate.bandId === configured.bandId &&
              candidate.requestId === requestId,
          );
          if (existing) {
            if (
              existing.draftId !== result.receipt.draftId ||
              existing.receiptId !== result.receipt.id
            ) {
              throw new AuthorityError(
                "invalid_standing_outcome_state",
                "The stored standing Telegram outcome is inconsistent",
                409,
              );
            }
            return existing;
          }
          const callbackValue = `bander-off:${this.#randomValue()}`;
          if (Buffer.byteLength(callbackValue, "utf8") > 64) {
            throw new Error("Telegram callback value exceeds 64 bytes");
          }
          const created: TelegramStandingOutcomeBinding = {
            installationId: installation.id,
            ownerTelegramId: installation.ownerTelegramId,
            chatId: installation.chatId,
            bandId: configured.bandId,
            requestId,
            draftId: result.receipt.draftId,
            receiptId: result.receipt.id,
            callbackValue,
            lifecycle: "pending_delivery",
            createdAt: this.#now().toISOString(),
          };
          state.standingOutcomes.push(created);
          this.#store.write(state);
          return created;
        });

        if (!outcome.deliveredAt) {
          const message = await this.#api.sendMessage(
            outcome.chatId,
            standingOutcomeText(
              result.receipt,
              summary.actionsUsed,
              summary.maxActions,
            ),
            {
              inline_keyboard: [
                [{ text: "Turn off automatic", callback_data: outcome.callbackValue }],
              ],
            },
          );
          outcome = await this.#stateLock.run("telegram-state", async () => {
            const state = this.#store.read();
            const index = state.standingOutcomes.findIndex(
              (candidate) =>
                candidate.bandId === configured.bandId &&
                candidate.requestId === requestId,
            );
            const current = state.standingOutcomes[index];
            if (!current) {
              throw new AuthorityError(
                "invalid_standing_outcome_state",
                "The stored standing Telegram outcome is missing",
                409,
              );
            }
            if (!current.deliveredAt) {
              state.standingOutcomes[index] = {
                ...current,
                lifecycle: "delivered",
                messageId: message.message_id,
                deliveredAt: this.#now().toISOString(),
              };
              this.#store.write(state);
            }
            return state.standingOutcomes[index]!;
          });
        }
        return this.#engine.getAgentReceipt(outcome.draftId);
      },
    );
  }

  async handleAgentAction(
    fixture: DraftFixture,
    requestId: string | undefined,
    agentId = "openclaw-reference",
  ): Promise<AgentReceipt> {
    const standing = await this.runStandingAction(fixture, requestId, agentId);
    if (standing) return standing;
    const card = this.#store.read().oneTimeReviewMode
      ? await this.#engine.proposeFixtureForFreshReview(fixture, agentId)
      : await this.#engine.proposeFixture(fixture, agentId);
    await this.deliverProposal(card);
    return this.#engine.getAgentReceipt(card.draftId);
  }

  async #detachStandingBand(bandId: string): Promise<void> {
    await this.#stateLock.run("telegram-state", async () => {
      const state = this.#store.read();
      if (state.standingBand?.bandId !== bandId) return;
      delete state.standingBand;
      state.oneTimeReviewMode = {
        detachedBandId: bandId,
        activatedAt: this.#now().toISOString(),
      };
      this.#store.write(state);
    });
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    await this.#stateLock.run("telegram-state", async () => {
      await this.#stateLockContext.run(true, async () => {
        if (update.message) await this.#handleMessage(update.message);
        if (update.callback_query) await this.#handleCallback(update.callback_query);
        const state = this.#store.read();
        state.nextUpdateId = Math.max(state.nextUpdateId ?? 0, update.update_id + 1);
        this.#store.write(state);
      });
    });
  }

  async #handleMessage(message: TelegramMessage): Promise<void> {
    const from = message.from;
    if (!from || from.is_bot) return;
    const token = startToken(message.text);
    if (token) {
      const familyToken = familyStartToken(token);
      if (familyToken) {
        await this.#claimFamilyContact(message, familyToken);
        return;
      }
      await this.#claimPairing(message, token);
      return;
    }
    if (message.chat_shared) await this.#completePairing(message);
    if (message.chat.type === "private" && message.chat.id === from.id) {
      await this.#handleFamilyContactPrivateMessage(message);
    }
  }

  async #claimFamilyContact(
    message: TelegramMessage,
    token: string,
  ): Promise<void> {
    const from = message.from!;
    const state = this.#store.read();
    const challenge = state.familyPairing;
    const installation = state.installation;
    if (
      !challenge ||
      !installation ||
      !tokenMatchesFamilyChallenge(challenge, token)
    ) {
      await this.#api.sendMessage(
        String(message.chat.id),
        "That family contact link is invalid or expired.",
      );
      return;
    }
    const protectedGroupStatus = await this.#protectedGroupStatus(
      installation.chatId,
      String(from.id),
    );
    const acceptCallbackValue = `family-accept:${this.#randomValue()}`;
    const declineCallbackValue = `family-decline:${this.#randomValue()}`;
    try {
      const provisional = claimFamilyContactChallenge({
        challenge,
        installation,
        token,
        now: this.#now(),
        claimant: {
          userId: String(from.id),
          chatId: String(message.chat.id),
          chatType: message.chat.type,
          isBot: from.is_bot,
        },
        protectedGroupStatus,
        acceptCallbackValue,
        declineCallbackValue,
      });
      if (provisional.replayed && provisional.challenge.consentMessageId) {
        await this.#api.sendMessage(
          String(message.chat.id),
          "Use the buttons on the connection request Bander already sent.",
        );
        return;
      }
      if (!provisional.replayed) {
        state.familyPairing = provisional.challenge;
        this.#store.write(state);
      }
      const claimed = provisional.challenge;
      const sent = await this.#api.sendMessage(
        String(message.chat.id),
        [
          `Connect as ${safeDisplayText(challenge.displayLabel)}?`,
          "This is a limited family-contact role.",
          "No notifications are enabled yet.",
          "You will not be able to approve anything or see the person’s calendar or conversations.",
        ].join("\n"),
        {
          inline_keyboard: [
            [
              {
                text: "Accept limited role",
                callback_data: claimed.acceptCallbackValue!,
              },
              {
                text: "Not now",
                callback_data: claimed.declineCallbackValue!,
              },
            ],
          ],
        },
      );
      state.familyPairing = {
        ...claimed,
        consentMessageId: sent.message_id,
      };
      this.#store.write(state);
    } catch (error) {
      const text =
        error instanceof FamilyContactError &&
        error.code === "contact_in_protected_group"
          ? "Leave the protected owner group before connecting as a family contact. Nothing was connected."
          : error instanceof FamilyContactError &&
              error.code === "protected_group_membership_unavailable"
            ? "Bander couldn’t verify that this account is outside the protected owner group. Nothing was connected."
            : error instanceof FamilyContactError &&
                error.code === "family_pairing_already_claimed"
              ? "That family contact link has already been claimed."
              : "That family contact link is invalid or expired.";
      await this.#api.sendMessage(String(message.chat.id), text);
    }
  }

  async #handleFamilyContactPrivateMessage(
    message: TelegramMessage,
  ): Promise<void> {
    const from = message.from!;
    const state = this.#store.read();
    const contact = state.familyContact;
    if (
      contact &&
      contact.telegramUserId === String(from.id) &&
      contact.privateChatId === String(message.chat.id)
    ) {
      if (message.text?.trim().toLocaleLowerCase("en-US") === "/disconnect") {
        this.#revokeFamilyContactInState(state, "contact");
        await this.#api.sendMessage(
          String(message.chat.id),
          "You’re disconnected. Bander no longer has a destination it can use for you.",
        );
        return;
      }
      await this.#api.sendMessage(
        String(message.chat.id),
        [
          `You’re connected as ${safeDisplayText(contact.displayLabel)}.`,
          "No notifications are enabled yet.",
          "You cannot approve requests, see a calendar, or send requests to OpenClaw here.",
          "Use /disconnect if you want to disconnect.",
        ].join("\n"),
      );
      return;
    }
    const audit = state.familyContactAudit;
    if (
      audit &&
      isRevokedContactSurface(audit, {
        userId: String(from.id),
        chatId: String(message.chat.id),
      })
    ) {
      await this.#api.sendMessage(
        String(message.chat.id),
        "You’re already disconnected. Ask the person who invited you for a new link if needed.",
      );
    }
  }

  async #claimPairing(message: TelegramMessage, token: string): Promise<void> {
    const from = message.from!;
    const state = this.#store.read();
    const pairing = state.pairing;
    const privateChat = message.chat.type === "private" && message.chat.id === from.id;
    const active =
      pairing &&
      !pairing.consumedAt &&
      this.#now().getTime() < new Date(pairing.expiresAt).getTime();
    if (!privateChat || !active || !secretMatches(token, pairing.tokenHash)) {
      await this.#api.sendMessage(String(message.chat.id), "That pairing link is invalid or expired.");
      return;
    }
    if (
      pairing.ownerTelegramId &&
      (pairing.ownerTelegramId !== String(from.id) ||
        pairing.ownerPrivateChatId !== String(message.chat.id))
    ) {
      await this.#api.sendMessage(
        String(message.chat.id),
        "That pairing attempt is already claimed.",
      );
      return;
    }
    const requestId = chatRequestId(pairing.tokenHash);
    state.pairing = {
      ...pairing,
      ownerTelegramId: String(from.id),
      ownerPrivateChatId: String(message.chat.id),
      chatRequestId: requestId,
    };
    this.#store.write(state);
    await this.#api.sendMessage(
      String(message.chat.id),
      this.#mode === "hero"
        ? "You’re the person who approves Bander’s limits.\nChoose the Telegram group where you use OpenClaw."
        : "You’re connected. Choose the Telegram group where you use OpenClaw.",
      {
        keyboard: [
          [
            {
              text: "Choose your OpenClaw group",
              request_chat: {
                request_id: requestId,
                chat_is_channel: false,
                bot_is_member: true,
              },
            },
          ],
        ],
        resize_keyboard: true,
        one_time_keyboard: true,
        input_field_placeholder: "Choose your OpenClaw group",
      },
    );
  }

  async #completePairing(message: TelegramMessage): Promise<void> {
    const from = message.from!;
    const state = this.#store.read();
    const pairing = state.pairing;
    const shared = message.chat_shared!;
    const authorized =
      pairing &&
      !pairing.consumedAt &&
      pairing.ownerTelegramId === String(from.id) &&
      pairing.ownerPrivateChatId === String(message.chat.id) &&
      pairing.chatRequestId === shared.request_id &&
      message.chat.type === "private" &&
      this.#now().getTime() < new Date(pairing.expiresAt).getTime();
    if (!authorized) {
      await this.#api.sendMessage(String(message.chat.id), "That group selection is not authorized.");
      return;
    }
    const selected = await this.#api.getChat(String(shared.chat_id));
    if (selected.type !== "group" && selected.type !== "supergroup") {
      await this.#api.sendMessage(String(message.chat.id), "Choose a Telegram group, not a channel.");
      return;
    }
    const pairedAt = this.#now().toISOString();
    state.installation = {
      id: pairing.installationId,
      ownerTelegramId: String(from.id),
      chatId: String(selected.id),
      pairedAt,
    };
    state.pairing = { ...pairing, consumedAt: pairedAt };
    this.#store.write(state);
    await this.#api.sendMessage(
      String(message.chat.id),
      this.#mode === "hero"
        ? "Bander is ready.\nI only act here, and only within limits you approve."
        : [
            "Bander is ready. Only you can approve what I’m allowed to do.",
            "I only act here, and only within limits you approve.",
          ].join("\n"),
      { remove_keyboard: true },
    );
  }

  async #handleFamilyContactCallback(
    callback: TelegramCallbackQuery,
  ): Promise<boolean> {
    const data = callback.data;
    if (!data?.startsWith("family-")) return false;
    if (!callback.message || callback.from.is_bot) {
      await this.#api.answerCallback(
        callback.id,
        "That family contact control isn’t valid here.",
      );
      return true;
    }
    const state = this.#store.read();
    const installation = state.installation;
    const challenge = state.familyPairing;
    if (
      challenge?.status === "claimed" &&
      (data === challenge.acceptCallbackValue ||
        data === challenge.declineCallbackValue)
    ) {
      const exactSurface =
        installation &&
        callback.from.id === Number(challenge.claimedTelegramUserId) &&
        callback.message.chat.type === "private" &&
        callback.message.chat.id === callback.from.id &&
        callback.message.chat.id === Number(challenge.claimedPrivateChatId) &&
        callback.message.message_id === challenge.consentMessageId;
      if (!exactSurface) {
        await this.#api.answerCallback(
          callback.id,
          "That family contact control isn’t valid here.",
        );
        return true;
      }
      if (this.#now().getTime() >= Date.parse(challenge.expiresAt)) {
        delete state.familyPairing;
        this.#removeFamilyPairingLink();
        this.#store.write(state);
        await this.#api.answerCallback(
          callback.id,
          "That family contact link expired.",
        );
        return true;
      }
      if (data === challenge.declineCallbackValue) {
        delete state.familyPairing;
        this.#removeFamilyPairingLink();
        this.#store.write(state);
        await this.#api.sendMessage(
          String(callback.message.chat.id),
          "Nothing was connected.",
        );
        await this.#api.answerCallback(callback.id, "Nothing was connected.");
        return true;
      }
      const protectedGroupStatus = await this.#protectedGroupStatus(
        installation!.chatId,
        String(callback.from.id),
      );
      try {
        const contact = acceptFamilyContactChallenge({
          challenge,
          installation: installation!,
          now: this.#now(),
          protectedGroupStatus,
          callback: {
            fromUserId: String(callback.from.id),
            isBot: callback.from.is_bot,
            chatId: String(callback.message.chat.id),
            chatType: callback.message.chat.type,
            messageId: callback.message.message_id,
            data,
          },
          contactRevokeCallbackValue: `family-contact-off:${this.#randomValue()}`,
          ownerRevokeCallbackValue: `family-owner-off:${this.#randomValue()}`,
        });
        if (state.familyContact) {
          throw new FamilyContactError(
            "family_contact_already_active",
            "A family contact is already active",
          );
        }
        state.familyContact = contact;
        delete state.familyPairing;
        this.#removeFamilyPairingLink();
        this.#store.write(state);
        await this.#deliverFamilyContactConfirmations(state);
        await this.#api.answerCallback(callback.id, "You’re connected.");
      } catch (error) {
        if (state.familyContact) throw error;
        await this.#api.answerCallback(
          callback.id,
          error instanceof FamilyContactError &&
            error.code === "contact_in_protected_group"
            ? "Leave the protected owner group first. Nothing was connected."
            : "Bander could not safely connect this contact.",
        );
      }
      return true;
    }

    const contact = state.familyContact;
    if (contact) {
      if (
        data.startsWith("family-accept:") &&
        callbackMatchesHash(data, contact.pairingAcceptCallbackHash) &&
        callback.from.id === Number(contact.telegramUserId) &&
        callback.message.chat.type === "private" &&
        callback.message.chat.id === Number(contact.privateChatId) &&
        callback.message.message_id === contact.consentMessageId
      ) {
        await this.#deliverFamilyContactConfirmations(state);
        await this.#api.answerCallback(callback.id, "You’re connected.");
        return true;
      }
      const contactRevoke =
        data === contact.contactRevokeCallbackValue &&
        callback.from.id === Number(contact.telegramUserId) &&
        callback.message.chat.type === "private" &&
        callback.message.chat.id === Number(contact.privateChatId) &&
        callback.message.message_id === contact.contactConfirmationMessageId;
      const ownerRevoke =
        installation &&
        data === contact.ownerRevokeCallbackValue &&
        callback.from.id === Number(installation.ownerTelegramId) &&
        (callback.message.chat.type === "group" ||
          callback.message.chat.type === "supergroup") &&
        callback.message.chat.id === Number(installation.chatId) &&
        callback.message.message_id === contact.ownerConfirmationMessageId;
      if (contactRevoke || ownerRevoke) {
        this.#revokeFamilyContactInState(
          state,
          contactRevoke ? "contact" : "owner",
        );
        if (contactRevoke) {
          await this.#api.sendMessage(
            String(callback.message.chat.id),
            "You’re disconnected. Bander no longer has a destination it can use for you.",
          );
        } else {
          await this.#api.sendMessage(
            installation!.chatId,
            "Family contact disconnected. No routing destination remains.",
          );
        }
        await this.#api.answerCallback(callback.id, "Family contact disconnected.");
        return true;
      }
    }

    const audit = state.familyContactAudit;
    if (audit && installation) {
      const contactReplay =
        callbackMatchesHash(data, audit.contactRevokeCallbackHash) &&
        audit.contactConfirmationMessageId === callback.message.message_id &&
        callback.message.chat.type === "private" &&
        isRevokedContactSurface(audit, {
          userId: String(callback.from.id),
          chatId: String(callback.message.chat.id),
        });
      const ownerReplay =
        callbackMatchesHash(data, audit.ownerRevokeCallbackHash) &&
        audit.ownerConfirmationMessageId === callback.message.message_id &&
        callback.from.id === Number(installation.ownerTelegramId) &&
        callback.message.chat.id === Number(installation.chatId);
      if (contactReplay || ownerReplay) {
        await this.#api.answerCallback(
          callback.id,
          "Family contact is already disconnected.",
        );
        return true;
      }
    }
    await this.#api.answerCallback(
      callback.id,
      "That family contact control isn’t valid here.",
    );
    return true;
  }

  async #handleCallback(callback: TelegramCallbackQuery): Promise<void> {
    if (await this.#handleFamilyContactCallback(callback)) return;
    if (!callback.message || !callback.data) {
      await this.#api.answerCallback(callback.id, "That control isn’t valid here.");
      return;
    }
    const snapshot = this.#store.read();
    const candidate = snapshot.proposals.find(
      (proposal) =>
        proposal.callbackValue === callback.data ||
        proposal.declineCallbackValue === callback.data,
    );
    const standingActivation = snapshot.standingCandidates.find(
      (candidate) =>
        candidate.approveCallbackValue === callback.data ||
        candidate.declineCallbackValue === callback.data,
    );
    const standingCandidate = snapshot.standingOutcomes.find(
      (outcome) => outcome.callbackValue === callback.data,
    );
    if (standingActivation) {
      await this.#handleStandingActivationCallback(callback, standingActivation);
      return;
    }
    if (standingCandidate) {
      await this.#handleStandingCallback(callback, standingCandidate);
      return;
    }
    if (!candidate) {
      await this.#api.answerCallback(callback.id, "That control isn’t valid here.");
      return;
    }
    await this.#callbackLock.run(`callback:${candidate.draftId}`, async () => {
      const state = this.#store.read();
      const index = state.proposals.findIndex(
        (proposal) =>
          proposal.callbackValue === callback.data ||
          proposal.declineCallbackValue === callback.data,
      );
      const binding = state.proposals[index];
      const isDecline = binding?.declineCallbackValue === callback.data;
      const installation = state.installation;
      const exactSurface =
        binding &&
        installation &&
        installation.id === binding.installationId &&
        String(callback.from.id) === binding.ownerTelegramId &&
        String(callback.message!.chat.id) === binding.chatId &&
        callback.message!.message_id === binding.messageId;
      if (!binding || !exactSurface) {
        await this.#api.answerCallback(
          callback.id,
          "Only the connected person can use this button on Bander’s message.",
        );
        return;
      }
      if (
        binding.lifecycle === "pending" &&
        this.#now().getTime() >= new Date(binding.expiresAt).getTime()
      ) {
        state.proposals[index] = { ...binding, lifecycle: "expired" };
        this.#store.write(state);
        const text = refusalText(
          "draft_expired",
          this.#engine.getCard(binding.draftId),
          this.#mode,
        );
        try {
          await this.#api.sendMessage(binding.chatId, text);
          const delivered = this.#store.read();
          const deliveredIndex = delivered.proposals.findIndex(
            (proposal) => proposal.draftId === binding.draftId,
          );
          delivered.proposals[deliveredIndex] = {
            ...delivered.proposals[deliveredIndex]!,
            conflictMessage: text,
            conflictDeliveredAt: this.#now().toISOString(),
          };
          this.#store.write(delivered);
        } catch {
          await this.#api.answerCallback(
            callback.id,
            "I couldn’t send the update. Tap again to check safely.",
          );
          return;
        }
        await this.#api.answerCallback(callback.id, "That request expired. Nothing happened.");
        return;
      }
      if (binding.lifecycle === "declined") {
        if (isDecline) {
          this.#engine.decline(binding.draftId);
          if (!binding.declineDeliveredAt) {
            await this.#api.sendMessage(
              binding.chatId,
              declineText(this.#mode),
            );
            const delivered = this.#store.read();
            const deliveredIndex = delivered.proposals.findIndex(
              (proposal) => proposal.draftId === binding.draftId,
            );
            delivered.proposals[deliveredIndex] = {
              ...delivered.proposals[deliveredIndex]!,
              declineDeliveredAt: this.#now().toISOString(),
            };
            this.#store.write(delivered);
          }
          await this.#api.answerCallback(callback.id, "Nothing changed.");
        } else {
          await this.#api.answerCallback(
            callback.id,
            "You already chose Not now. Nothing happened.",
          );
        }
        return;
      }
      if (isDecline) {
        if (binding.lifecycle !== "pending") {
          await this.#api.answerCallback(callback.id, "This request has already finished.");
          return;
        }
        const result = this.#engine.decline(binding.draftId);
        const declined = this.#store.read();
        const declinedIndex = declined.proposals.findIndex(
          (proposal) => proposal.draftId === binding.draftId,
        );
        declined.proposals[declinedIndex] = {
          ...declined.proposals[declinedIndex]!,
          lifecycle: "declined",
        };
        this.#store.write(declined);
        await this.#api.sendMessage(
          binding.chatId,
          declineText(this.#mode),
        );
        const delivered = this.#store.read();
        const deliveredIndex = delivered.proposals.findIndex(
          (proposal) => proposal.draftId === binding.draftId,
        );
        delivered.proposals[deliveredIndex] = {
          ...delivered.proposals[deliveredIndex]!,
          declineDeliveredAt: this.#now().toISOString(),
        };
        this.#store.write(delivered);
        await this.#api.answerCallback(
          callback.id,
          result.status === "declined" ? "Nothing changed." : "Stopped.",
        );
        return;
      }
      try {
        // All valid first-use and replay callbacks use the engine's idempotent boundary.
        const receipt = await this.#engine.approveAndExecute(
          binding.draftId,
          binding.draftHash,
        );
        const current = this.#store.read();
        const currentIndex = current.proposals.findIndex(
          (proposal) => proposal.callbackValue === callback.data,
        );
        const currentBinding = current.proposals[currentIndex]!;
        const deliveryPending = !currentBinding.receiptDeliveredAt;
        current.proposals[currentIndex] = {
          ...currentBinding,
          lifecycle: "executed",
          receiptId: receipt.id,
        };
        this.#store.write(current);
        if (deliveryPending) {
          await this.#api.sendMessage(
            binding.chatId,
            receiptText(receipt, this.#mode),
          );
          const deliveredState = this.#store.read();
          const deliveredIndex = deliveredState.proposals.findIndex(
            (proposal) => proposal.callbackValue === callback.data,
          );
          const deliveredBinding = deliveredState.proposals[deliveredIndex];
          if (deliveredBinding && !deliveredBinding.receiptDeliveredAt) {
            deliveredState.proposals[deliveredIndex] = {
              ...deliveredBinding,
              receiptDeliveredAt: this.#now().toISOString(),
            };
            this.#store.write(deliveredState);
          }
        }
        await this.#api.answerCallback(
          callback.id,
          deliveryPending
            ? "Done exactly as shown."
            : "Already done. Nothing ran again.",
        );
      } catch (error) {
        if (error instanceof AuthorityError) {
          const conflictState = this.#store.read();
          const conflictIndex = conflictState.proposals.findIndex(
            (proposal) => proposal.callbackValue === callback.data,
          );
          const conflictBinding = conflictState.proposals[conflictIndex];
          if (conflictBinding) {
            const conflictMessage =
              conflictBinding.conflictMessage ??
              refusalText(
                error.code,
                this.#engine.getCard(binding.draftId),
                this.#mode,
              );
            const deliveryPending = !conflictBinding.conflictDeliveredAt;
            conflictState.proposals[conflictIndex] = {
              ...conflictBinding,
              lifecycle: error.code === "draft_expired" ? "expired" : "conflict",
              conflictMessage,
            };
            this.#store.write(conflictState);
            if (deliveryPending) {
              try {
                await this.#api.sendMessage(binding.chatId, conflictMessage);
                const deliveredState = this.#store.read();
                const deliveredIndex = deliveredState.proposals.findIndex(
                  (proposal) => proposal.callbackValue === callback.data,
                );
                const deliveredBinding = deliveredState.proposals[deliveredIndex];
                if (deliveredBinding && !deliveredBinding.conflictDeliveredAt) {
                  deliveredState.proposals[deliveredIndex] = {
                    ...deliveredBinding,
                    conflictDeliveredAt: this.#now().toISOString(),
                  };
                  this.#store.write(deliveredState);
                }
              } catch {
                await this.#api.answerCallback(
                  callback.id,
                  "Bander could not deliver the human outcome. Tap again to retry safely.",
                );
                return;
              }
            }
          }
          await this.#api.answerCallback(
            callback.id,
            error.code === "draft_expired"
              ? "That request expired. Nothing happened."
              : "Stopped safely. Nothing changed through Bander.",
          );
          return;
        }
        await this.#api.answerCallback(
          callback.id,
          "Bander could not confirm the outcome. Tap again to recover safely.",
        );
      }
    });
  }

  async #handleStandingActivationCallback(
    callback: TelegramCallbackQuery,
    candidate: TelegramStandingCandidateBinding,
  ): Promise<void> {
    await this.#callbackLock.run(
      `standing-candidate:${candidate.candidateId}`,
      async () => {
        const state = this.#store.read();
        const index = state.standingCandidates.findIndex(
          (binding) =>
            binding.approveCallbackValue === callback.data ||
            binding.declineCallbackValue === callback.data,
        );
        const binding = state.standingCandidates[index];
        const installation = state.installation;
        const messageAuthor = callback.message?.from;
        const exactSurface =
          binding &&
          installation &&
          callback.message &&
          installation.id === binding.installationId &&
          String(callback.from.id) === binding.ownerTelegramId &&
          String(callback.message.chat.id) === binding.chatId &&
          callback.message.message_id === binding.messageId &&
          messageAuthor?.is_bot === true &&
          String(messageAuthor.id) === binding.botTelegramId;
        if (!binding || !exactSurface) {
          await this.#api.answerCallback(
            callback.id,
            "Only the connected person can use this button on Bander’s message.",
          );
          return;
        }

        const isDecline = binding.declineCallbackValue === callback.data;
        const deliverExpiry = async () => {
          const current = this.#store.read();
          const currentIndex = current.standingCandidates.findIndex(
            (entry) => entry.candidateId === binding.candidateId,
          );
          const currentBinding = current.standingCandidates[currentIndex];
          if (!currentBinding || currentBinding.expiryDeliveredAt) return;
          await this.#api.sendMessage(
            binding.chatId,
            "That request expired. Nothing happened.\nAsk OpenClaw to prepare it again.",
          );
          const delivered = this.#store.read();
          const deliveredIndex = delivered.standingCandidates.findIndex(
            (entry) => entry.candidateId === binding.candidateId,
          );
          delivered.standingCandidates[deliveredIndex] = {
            ...delivered.standingCandidates[deliveredIndex]!,
            expiryDeliveredAt: this.#now().toISOString(),
          };
          this.#store.write(delivered);
        };
        if (
          binding.lifecycle === "pending" &&
          this.#now().getTime() >= new Date(binding.expiresAt).getTime()
        ) {
          state.standingCandidates[index] = {
            ...binding,
            lifecycle: "expired",
          };
          this.#store.write(state);
          await deliverExpiry();
          await this.#api.answerCallback(
            callback.id,
            "That request expired. Nothing happened.",
          );
          return;
        }

        if (binding.lifecycle === "expired") {
          await deliverExpiry();
          await this.#api.answerCallback(
            callback.id,
            "That request expired. Nothing happened.",
          );
          return;
        }
        if (binding.lifecycle === "declined") {
          if (isDecline && !binding.declineDeliveredAt) {
            await this.#api.sendMessage(
              binding.chatId,
              "Automatic handling stays off.\nI’ll check with you each time.",
            );
            const delivered = this.#store.read();
            const deliveredIndex = delivered.standingCandidates.findIndex(
              (entry) => entry.candidateId === binding.candidateId,
            );
            delivered.standingCandidates[deliveredIndex] = {
              ...delivered.standingCandidates[deliveredIndex]!,
              declineDeliveredAt: this.#now().toISOString(),
            };
            this.#store.write(delivered);
          }
          await this.#api.answerCallback(
            callback.id,
            isDecline
              ? "I’ll keep checking with you each time."
              : "You already chose to be asked each time.",
          );
          return;
        }
        if (binding.lifecycle === "activated") {
          if (isDecline) {
            await this.#api.answerCallback(
              callback.id,
              "Automatic handling is already on. Use Turn off automatic on an outcome.",
            );
            return;
          }
          const stillActive =
            binding.bandId &&
            state.standingBand?.bandId === binding.bandId &&
            this.#engine.getStandingBandSummary(binding.bandId).status === "active";
          await this.#api.answerCallback(
            callback.id,
            stillActive
              ? "Automatic handling was already on."
              : "That old button can’t turn automatic handling back on.",
          );
          return;
        }

        if (isDecline) {
          await this.#engine.declineStandingBandCandidate(
            binding.candidateId,
            binding.predicateHash,
          );
          state.standingCandidates[index] = {
            ...binding,
            lifecycle: "declined",
          };
          this.#store.write(state);
          await this.#api.sendMessage(
            binding.chatId,
            "Automatic handling stays off.\nI’ll check with you each time.",
          );
          const delivered = this.#store.read();
          const deliveredIndex = delivered.standingCandidates.findIndex(
            (entry) => entry.candidateId === binding.candidateId,
          );
          delivered.standingCandidates[deliveredIndex] = {
            ...delivered.standingCandidates[deliveredIndex]!,
            declineDeliveredAt: this.#now().toISOString(),
          };
          this.#store.write(delivered);
          await this.#api.answerCallback(
            callback.id,
            "I’ll check with you each time.",
          );
          return;
        }

        if (state.standingBand && state.standingBand.bandId !== binding.bandId) {
          const existing = this.#engine.getStandingBandSummary(
            state.standingBand.bandId,
          );
          if (existing.status === "active") {
            await this.#api.answerCallback(
              callback.id,
              "Automatic handling is already on for this installation.",
            );
            return;
          }
          delete state.standingBand;
        }

        try {
          const approved = await this.#engine.approveStandingBand(
            binding.candidateId,
            binding.predicateHash,
          );
          const current = this.#store.read();
          const currentIndex = current.standingCandidates.findIndex(
            (entry) => entry.candidateId === binding.candidateId,
          );
          const currentBinding = current.standingCandidates[currentIndex];
          if (!currentBinding) {
            throw new AuthorityError(
              "standing_candidate_state_missing",
              "The Telegram standing request is missing",
              409,
            );
          }
          current.standingBand = {
            installationId: binding.installationId,
            ownerTelegramId: binding.ownerTelegramId,
            chatId: binding.chatId,
            bandId: approved.bandId,
            activatedAt: this.#now().toISOString(),
          };
          delete current.oneTimeReviewMode;
          const deliveryPending = !currentBinding.activationDeliveredAt;
          current.standingCandidates[currentIndex] = {
            ...currentBinding,
            lifecycle: "activated",
            bandId: approved.bandId,
          };
          this.#store.write(current);
          if (deliveryPending) {
            await this.#api.sendMessage(
              binding.chatId,
              "Automatic handling is on.\nI’ll show you every move, and you can turn it off anytime.",
            );
            const delivered = this.#store.read();
            const deliveredIndex = delivered.standingCandidates.findIndex(
              (entry) => entry.candidateId === binding.candidateId,
            );
            delivered.standingCandidates[deliveredIndex] = {
              ...delivered.standingCandidates[deliveredIndex]!,
              activationDeliveredAt: this.#now().toISOString(),
            };
            this.#store.write(delivered);
          }
          await this.#api.answerCallback(
            callback.id,
            deliveryPending
              ? "Automatic handling is on."
              : "Automatic handling was already on.",
          );
        } catch (error) {
          if (error instanceof AuthorityError) {
            await this.#api.answerCallback(
              callback.id,
              error.code === "standing_candidate_expired"
                ? "That request expired. Nothing happened."
                : "That automatic request no longer matches what you reviewed.",
            );
            return;
          }
          throw error;
        }
      },
    );
  }

  async #handleStandingCallback(
    callback: TelegramCallbackQuery,
    candidate: TelegramStandingOutcomeBinding,
  ): Promise<void> {
    await this.#callbackLock.run(`standing:${candidate.bandId}`, async () => {
      const state = this.#store.read();
      const index = state.standingOutcomes.findIndex(
        (outcome) => outcome.callbackValue === callback.data,
      );
      const binding = state.standingOutcomes[index];
      const installation = state.installation;
      const exactSurface =
        binding &&
        installation &&
        binding.messageId !== undefined &&
        installation.id === binding.installationId &&
        String(callback.from.id) === binding.ownerTelegramId &&
        String(callback.message!.chat.id) === binding.chatId &&
        callback.message!.message_id === binding.messageId;
      if (!binding || !exactSurface) {
        await this.#api.answerCallback(
          callback.id,
          "Only the connected person can use this button on Bander’s message.",
        );
        return;
      }
      const alreadyRevoked = binding.lifecycle === "revoked";
      await this.#engine.revokeBand(binding.bandId);
      const current = this.#store.read();
      const currentIndex = current.standingOutcomes.findIndex(
        (outcome) => outcome.callbackValue === callback.data,
      );
      const currentBinding = current.standingOutcomes[currentIndex];
      const revocationDeliveryPending =
        currentBinding && !currentBinding.revocationDeliveredAt;
      if (currentBinding && currentBinding.lifecycle !== "revoked") {
        current.standingOutcomes[currentIndex] = {
          ...currentBinding,
          lifecycle: "revoked",
          revokedAt: this.#now().toISOString(),
        };
      }
      if (current.standingBand?.bandId === binding.bandId) {
        delete current.standingBand;
      }
      current.oneTimeReviewMode = {
        detachedBandId: binding.bandId,
        activatedAt: currentBinding?.revokedAt ?? this.#now().toISOString(),
      };
      this.#store.write(current);
      if (revocationDeliveryPending) {
        await this.#api.sendMessage(
          binding.chatId,
          [
            "Automatic handling is off.",
            "I’ll check with you each time now.",
          ].join("\n"),
        );
        const delivered = this.#store.read();
        const deliveredIndex = delivered.standingOutcomes.findIndex(
          (outcome) => outcome.callbackValue === callback.data,
        );
        const deliveredBinding = delivered.standingOutcomes[deliveredIndex];
        if (deliveredBinding && !deliveredBinding.revocationDeliveredAt) {
          delivered.standingOutcomes[deliveredIndex] = {
            ...deliveredBinding,
            revocationDeliveredAt: this.#now().toISOString(),
          };
          this.#store.write(delivered);
        }
      }
      await this.#api.answerCallback(
        callback.id,
        alreadyRevoked
          ? "Automatic handling is already off."
          : "Automatic handling is off.",
      );
    });
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#loop = this.#poll();
  }

  async stop(): Promise<void> {
    this.#running = false;
    await this.#loop;
    this.#loop = undefined;
  }

  async #poll(): Promise<void> {
    while (this.#running) {
      try {
        const offset = this.#store.read().nextUpdateId;
        const updates = await this.#api.getUpdates(offset);
        for (const update of updates) {
          if (!this.#running) break;
          await this.handleUpdate(update);
        }
      } catch {
        if (!this.#running) break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }
}
