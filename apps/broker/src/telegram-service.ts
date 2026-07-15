import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentReceipt, ApprovalCard, HumanReceipt } from "@bander/contracts";
import {
  AuthorityEngine,
  AuthorityError,
  formatCalendarIntervalWithContext,
  KeyedLock,
} from "@bander/core";
import type { DraftFixture, StandingRunResult } from "@bander/core";

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
  draftId: string;
  draftHash: string;
  expiresAt: string;
  lifecycle: "pending" | "executed" | "conflict" | "expired";
  receiptId?: string;
  receiptDeliveredAt?: string;
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
  standingBand?: TelegramStandingBandBinding;
  oneTimeReviewMode?: { detachedBandId: string; activatedAt: string };
  standingOutcomes: TelegramStandingOutcomeBinding[];
}

export interface TelegramServiceStore {
  read(): TelegramServiceState;
  write(state: TelegramServiceState): void;
}

function emptyState(): TelegramServiceState {
  return { version: 1, proposals: [], standingOutcomes: [] };
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
    const state = JSON.parse(fs.readFileSync(this.#filePath, "utf8")) as TelegramServiceState;
    if (state.version !== 1 || !Array.isArray(state.proposals)) {
      throw new Error("Unsupported Telegram service state");
    }
    return copy({ ...state, standingOutcomes: state.standingOutcomes ?? [] });
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

interface TelegramServiceOptions {
  api: TelegramBotApi;
  engine: AuthorityEngine;
  store: TelegramServiceStore;
  now?: () => Date;
  randomValue?: () => string;
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

function cardText(card: ApprovalCard): string {
  const effects = card.effectPreviews.map((effect) => {
    if (effect.kind === "calendar.reschedule_event") {
      return `• Calendar: ${effect.eventTitle}\n  ${effect.previousInterval} → ${effect.resultingInterval}`;
    }
    return `• Message to ${effect.recipientDisplayName}: “${effect.body}”`;
  });
  return [
    card.title,
    "",
    card.provenanceLabel,
    `“${card.claimedUserRequest}”`,
    "",
    "This approval allows:",
    ...effects,
    "",
    card.notAllowed,
    card.boundary,
    `Expires: ${card.expiresAt}`,
  ].join("\n");
}

function receiptText(receipt: HumanReceipt): string {
  return [
    receipt.title,
    receipt.summary,
    receipt.detail,
    `Calendar: ${receipt.calendar.title}`,
    `${receipt.calendar.previous.startTime}–${receipt.calendar.previous.endTime}`,
    `→ ${receipt.calendar.completed.startTime}–${receipt.calendar.completed.endTime}`,
    ...(receipt.message
      ? [`Message to ${receipt.message.recipientDisplayName}: “${receipt.message.body}”`]
      : []),
    `Receipt: ${receipt.id}`,
  ].join("\n");
}

function standingOutcomeText(
  receipt: HumanReceipt,
  actionsUsed: number,
  maxActions: number,
): string {
  return [
    "Bander handled this",
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
    "No one was messaged",
    `${actionsUsed} of ${maxActions} actions used today`,
  ].join("\n");
}

export class TelegramService {
  readonly #api: TelegramBotApi;
  readonly #engine: AuthorityEngine;
  readonly #store: TelegramServiceStore;
  readonly #now: () => Date;
  readonly #randomValue: () => string;
  readonly #stateLock = new KeyedLock();
  readonly #callbackLock = new KeyedLock();
  readonly #standingRequestLock = new KeyedLock();
  #running = false;
  #loop: Promise<void> | undefined;

  constructor(options: TelegramServiceOptions) {
    this.#api = options.api;
    this.#engine = options.engine;
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
    this.#randomValue =
      options.randomValue ?? (() => randomBytes(24).toString("base64url"));
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

  async deliverProposal(card: ApprovalCard): Promise<void> {
    await this.#stateLock.run("telegram-state", async () => {
      const state = this.#store.read();
      const installation = state.installation;
      if (!installation) throw new Error("Telegram installation is not paired");
      if (state.proposals.some((proposal) => proposal.draftId === card.draftId)) return;
      const callbackValue = `bander:${this.#randomValue()}`;
      if (Buffer.byteLength(callbackValue, "utf8") > 64) {
        throw new Error("Telegram callback value exceeds 64 bytes");
      }
      const message = await this.#api.sendMessage(
        installation.chatId,
        cardText(card),
        {
          inline_keyboard: [
            [{ text: "Approve this one-time deal", callback_data: callbackValue }],
          ],
        },
      );
      state.proposals.push({
        installationId: installation.id,
        ownerTelegramId: installation.ownerTelegramId,
        chatId: installation.chatId,
        messageId: message.message_id,
        callbackValue,
        draftId: card.draftId,
        draftHash: card.draftHash,
        expiresAt: card.expiresAt,
        lifecycle: "pending",
      });
      this.#store.write(state);
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
                [{ text: "Turn off", callback_data: outcome.callbackValue }],
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
      if (update.message) await this.#handleMessage(update.message);
      if (update.callback_query) await this.#handleCallback(update.callback_query);
      const state = this.#store.read();
      state.nextUpdateId = Math.max(state.nextUpdateId ?? 0, update.update_id + 1);
      this.#store.write(state);
    });
  }

  async #handleMessage(message: TelegramMessage): Promise<void> {
    const from = message.from;
    if (!from || from.is_bot) return;
    const token = startToken(message.text);
    if (token) {
      await this.#claimPairing(message, token);
      return;
    }
    if (message.chat_shared) await this.#completePairing(message);
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
      "Owner authenticated. Choose the one Telegram group Bander may use.",
      {
        keyboard: [
          [
            {
              text: "Choose Bander group",
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
        input_field_placeholder: "Choose the private Bander group",
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
      "Bander is paired. Only you can approve Bander Cards in the selected group.",
      { remove_keyboard: true },
    );
  }

  async #handleCallback(callback: TelegramCallbackQuery): Promise<void> {
    if (!callback.message || !callback.data) {
      await this.#api.answerCallback(callback.id, "Denied. This is not a Bander approval surface.");
      return;
    }
    const snapshot = this.#store.read();
    const candidate = snapshot.proposals.find(
      (proposal) => proposal.callbackValue === callback.data,
    );
    const standingCandidate = snapshot.standingOutcomes.find(
      (outcome) => outcome.callbackValue === callback.data,
    );
    if (standingCandidate) {
      await this.#handleStandingCallback(callback, standingCandidate);
      return;
    }
    if (!candidate) {
      await this.#api.answerCallback(callback.id, "Denied. This is not a Bander approval surface.");
      return;
    }
    await this.#callbackLock.run(`callback:${candidate.draftId}`, async () => {
      const state = this.#store.read();
      const index = state.proposals.findIndex(
        (proposal) => proposal.callbackValue === callback.data,
      );
      const binding = state.proposals[index];
      const installation = state.installation;
      const exactSurface =
        binding &&
        installation &&
        installation.id === binding.installationId &&
        String(callback.from.id) === binding.ownerTelegramId &&
        String(callback.message!.chat.id) === binding.chatId &&
        callback.message!.message_id === binding.messageId;
      if (!binding || !exactSurface) {
        await this.#api.answerCallback(callback.id, "Denied. This approval is bound to its owner and Bander Card.");
        return;
      }
      if (
        binding.lifecycle === "pending" &&
        this.#now().getTime() >= new Date(binding.expiresAt).getTime()
      ) {
        state.proposals[index] = { ...binding, lifecycle: "expired" };
        this.#store.write(state);
        await this.#api.answerCallback(callback.id, "This Bander Card expired. Nothing was executed.");
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
          await this.#api.sendMessage(binding.chatId, receiptText(receipt));
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
            ? "Approved. Bander completed exactly this deal."
            : "Recovered the same Receipt. Nothing ran again.",
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
              conflictBinding.conflictMessage ?? error.message;
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
          await this.#api.answerCallback(callback.id, error.message);
          return;
        }
        await this.#api.answerCallback(
          callback.id,
          "Bander could not confirm the outcome. Tap again to recover safely.",
        );
      }
    });
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
          "Denied. This control is bound to its owner and Bander message.",
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
            "Back in control",
            "Future matching requests will come back as one-time deals.",
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
          ? "This standing Band is already off."
          : "Standing Band turned off. Future actions are blocked.",
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
