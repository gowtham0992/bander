import { describe, expect, it } from "vitest";
import type { ApprovalCard, CalendarEvent, DraftDocument, Person } from "@bander/contracts";
import {
  AuthorityEngine,
  AuthorityStore,
  ExecutionConflictError,
  type DraftFixture,
  type ExecutionAdapter,
} from "@bander/core";
import {
  MemoryTelegramServiceStore,
  TelegramService,
  type TelegramBotApi,
  type TelegramMessage,
  type TelegramUpdate,
} from "./telegram-service.js";

const fixture: DraftFixture = {
  id: "telegram-fixture",
  claimedUserRequest: "Move dinner and message Sarah.",
  calendar: {
    eventId: "event-dinner-sarah",
    expectedEtag: "event-dinner-sarah-r1",
    newStartTime: "2026-07-14T19:30:00-06:00",
  },
  message: {
    recipientId: "person-sarah",
    expectedRecipientRevision: 1,
    body: "See you at 7:30!",
  },
};

class FakeAdapter implements ExecutionAdapter {
  executions = 0;
  conflict = false;

  async resolveEvent(): Promise<CalendarEvent> {
    return {
      id: "event-dinner-sarah",
      title: "Dinner with Sarah",
      startTime: "2026-07-14T19:00:00-06:00",
      endTime: "2026-07-14T20:30:00-06:00",
      timeZone: "America/Denver",
      organizerId: "person-owner",
      attendeeIds: ["person-owner", "person-sarah"],
      revision: 1,
      etag: "event-dinner-sarah-r1",
    };
  }

  async resolvePerson(): Promise<Person> {
    return {
      id: "person-sarah",
      displayName: "Sarah Chen",
      messageAddress: "+15550101002",
      revision: 1,
    };
  }

  async executeDraft(_input: {
    draftHash: string;
    permitNonce: string;
    document: DraftDocument;
  }): Promise<void> {
    this.executions += 1;
    if (this.conflict) throw new ExecutionConflictError();
  }

  async getExecution(): Promise<boolean> {
    return false;
  }
}

class FakeTelegramApi implements TelegramBotApi {
  readonly messages: Array<{
    chatId: string;
    text: string;
    replyMarkup?: Record<string, unknown>;
  }> = [];
  readonly callbackAnswers: Array<{ id: string; text: string }> = [];
  beforeSend: ((text: string) => void) | undefined;
  failNextMessageMatching: ((text: string) => boolean) | undefined;
  #nextMessageId = 40;

  async getMe() {
    return { id: 900, is_bot: true, username: "g_bander_test_bot" };
  }

  async getChat(chatId: string) {
    return { id: Number(chatId), type: "supergroup" };
  }

  async getUpdates(): Promise<TelegramUpdate[]> {
    return [];
  }

  async sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: Record<string, unknown>,
  ): Promise<TelegramMessage> {
    this.beforeSend?.(text);
    if (this.failNextMessageMatching?.(text)) {
      this.failNextMessageMatching = undefined;
      throw new Error("simulated Telegram send failure");
    }
    this.messages.push({
      chatId,
      text,
      ...(replyMarkup ? { replyMarkup } : {}),
    });
    this.#nextMessageId += 1;
    return { message_id: this.#nextMessageId, chat: { id: Number(chatId), type: "supergroup" } };
  }

  async answerCallback(callbackQueryId: string, text: string): Promise<boolean> {
    this.callbackAnswers.push({ id: callbackQueryId, text });
    return true;
  }
}

function messageUpdate(input: {
  updateId: number;
  fromId: number;
  chatId: number;
  chatType: string;
  text?: string;
  chatShared?: { request_id: number; chat_id: number };
}): TelegramUpdate {
  return {
    update_id: input.updateId,
    message: {
      message_id: input.updateId,
      from: { id: input.fromId, is_bot: false },
      chat: { id: input.chatId, type: input.chatType },
      ...(input.text ? { text: input.text } : {}),
      ...(input.chatShared ? { chat_shared: input.chatShared } : {}),
    },
  };
}

function setup() {
  const adapter = new FakeAdapter();
  const authorityStore = new AuthorityStore();
  const engine = new AuthorityEngine({
    store: authorityStore,
    adapter,
    now: () => new Date("2026-07-14T18:00:00.000Z"),
  });
  const api = new FakeTelegramApi();
  const store = new MemoryTelegramServiceStore();
  let tokenIndex = 0;
  const values = ["pairing-token", "installation-id", "opaque-callback"];
  const service = new TelegramService({
    api,
    engine,
    store,
    now: () => new Date("2026-07-14T18:00:00.000Z"),
    randomValue: () => values[tokenIndex++] ?? `random-${tokenIndex}`,
  });
  return { adapter, api, authorityStore, engine, service, store };
}

async function pairOwner(setupResult: ReturnType<typeof setup>) {
  const pairing = await setupResult.service.createPairing();
  expect(pairing.link).toContain("?start=pairing-token");
  await setupResult.service.handleUpdate(
    messageUpdate({
      updateId: 1,
      fromId: 101,
      chatId: 101,
      chatType: "private",
      text: "/start pairing-token",
    }),
  );
  const challenge = setupResult.store.read().pairing;
  expect(challenge?.ownerTelegramId).toBe("101");
  expect(challenge?.chatRequestId).toBeTypeOf("number");
  await setupResult.service.handleUpdate(
    messageUpdate({
      updateId: 2,
      fromId: 101,
      chatId: 101,
      chatType: "private",
      chatShared: {
        request_id: challenge!.chatRequestId!,
        chat_id: -500,
      },
    }),
  );
}

describe("Bander Telegram service", () => {
  it("pairs one owner and group through a private single-use token and private chat picker", async () => {
    const current = setup();
    await pairOwner(current);

    expect(current.store.read().installation).toMatchObject({
      ownerTelegramId: "101",
      chatId: "-500",
    });
    expect(current.store.read().pairing?.consumedAt).toBeDefined();

    await current.service.handleUpdate(
      messageUpdate({
        updateId: 3,
        fromId: 202,
        chatId: 202,
        chatType: "private",
        text: "/start pairing-token",
      }),
    );
    expect(current.store.read().installation?.ownerTelegramId).toBe("101");
  });

  it("locks an active pairing attempt to its first valid private claimant", async () => {
    const current = setup();
    await current.service.createPairing();
    await current.service.handleUpdate(
      messageUpdate({
        updateId: 1,
        fromId: 101,
        chatId: 101,
        chatType: "private",
        text: "/start pairing-token",
      }),
    );
    const firstClaim = current.store.read().pairing!;

    await current.service.handleUpdate(
      messageUpdate({
        updateId: 2,
        fromId: 202,
        chatId: 202,
        chatType: "private",
        text: "/start pairing-token",
      }),
    );

    expect(current.store.read().pairing).toMatchObject({
      ownerTelegramId: "101",
      ownerPrivateChatId: "101",
      chatRequestId: firstClaim.chatRequestId,
    });
    await current.service.handleUpdate(
      messageUpdate({
        updateId: 3,
        fromId: 101,
        chatId: 101,
        chatType: "private",
        chatShared: {
          request_id: firstClaim.chatRequestId!,
          chat_id: -500,
        },
      }),
    );
    expect(current.store.read().installation).toMatchObject({
      ownerTelegramId: "101",
      chatId: "-500",
    });
  });

  it("persists the exact Bander-authored approval surface and authorizes every callback independently", async () => {
    const current = setup();
    await pairOwner(current);
    const card = await current.engine.proposeFixture(fixture, "openclaw-reference");
    await current.service.deliverProposal(card);
    const binding = current.store.read().proposals[0]!;

    expect(binding).toMatchObject({
      ownerTelegramId: "101",
      chatId: "-500",
      messageId: 43,
      draftId: card.draftId,
      lifecycle: "pending",
    });
    expect(binding.callbackValue).toContain("opaque-callback");

    for (const [id, fromId, chatId, messageId, data] of [
      ["non-owner", 202, -500, 43, binding.callbackValue],
      ["wrong-chat", 101, -501, 43, binding.callbackValue],
      ["wrong-message", 101, -500, 99, binding.callbackValue],
      ["imitation", 101, -500, 43, "openclaw:imitation"],
    ] as const) {
      await current.service.handleUpdate({
        update_id: 10,
        callback_query: {
          id,
          from: { id: fromId, is_bot: false },
          data,
          message: { message_id: messageId, chat: { id: chatId, type: "supergroup" } },
        },
      });
    }
    expect(current.adapter.executions).toBe(0);

    const ownerCallback: TelegramUpdate = {
      update_id: 11,
      callback_query: {
        id: "owner",
        from: { id: 101, is_bot: false },
        data: binding.callbackValue,
        message: { message_id: 43, chat: { id: -500, type: "supergroup" } },
      },
    };
    await current.service.handleUpdate(ownerCallback);
    await current.service.handleUpdate({
      ...ownerCallback,
      update_id: 12,
      callback_query: { ...ownerCallback.callback_query!, id: "owner-replay" },
    });

    expect(current.adapter.executions).toBe(1);
    expect(current.authorityStore.getOneTimeBandsForDraft(card.draftId)).toHaveLength(1);
    expect(current.authorityStore.getPermitsForDraft(card.draftId)).toHaveLength(1);
    expect(current.store.read().proposals[0]).toMatchObject({ lifecycle: "executed" });
    expect(current.api.messages.filter((message) => message.text.startsWith("Done"))).toHaveLength(1);
  });

  it("refuses proposal delivery until authenticated pairing is complete", async () => {
    const current = setup();
    const card = await current.engine.proposeFixture(fixture);
    await expect(current.service.deliverProposal(card)).rejects.toThrow(
      "Telegram installation is not paired",
    );
  });

  it("marks a truthful Receipt delivered only after Telegram confirms it", async () => {
    const current = setup();
    await pairOwner(current);
    const card = await current.engine.proposeFixture(fixture, "openclaw-reference");
    await current.service.deliverProposal(card);
    const binding = current.store.read().proposals[0]!;
    let pendingWhenDeliveryStarted = false;
    current.api.beforeSend = (text) => {
      if (text.startsWith("Done")) {
        pendingWhenDeliveryStarted =
          current.store.read().proposals[0]?.receiptDeliveredAt === undefined;
      }
    };
    current.api.failNextMessageMatching = (text) => text.startsWith("Done");
    const callback = {
      update_id: 30,
      callback_query: {
        id: "owner-receipt-failure",
        from: { id: 101, is_bot: false },
        data: binding.callbackValue,
        message: {
          message_id: binding.messageId,
          chat: { id: -500, type: "supergroup" },
        },
      },
    } satisfies TelegramUpdate;

    await current.service.handleUpdate(callback);
    const pending = current.store.read().proposals[0]!;
    expect(pendingWhenDeliveryStarted).toBe(true);
    expect(pending).toMatchObject({
      lifecycle: "executed",
      receiptId: expect.stringMatching(/^receipt_/),
    });
    expect(pending.receiptDeliveredAt).toBeUndefined();
    expect(current.adapter.executions).toBe(1);

    await current.service.handleUpdate({
      ...callback,
      update_id: 31,
      callback_query: { ...callback.callback_query, id: "owner-receipt-retry" },
    });
    const delivered = current.store.read().proposals[0]!;
    expect(delivered.receiptId).toBe(pending.receiptId);
    expect(delivered.receiptDeliveredAt).toBeDefined();
    expect(current.adapter.executions).toBe(1);
    expect(current.api.messages.filter((message) => message.text.startsWith("Done"))).toHaveLength(1);

    await current.service.handleUpdate({
      ...callback,
      update_id: 32,
      callback_query: { ...callback.callback_query, id: "owner-after-delivery" },
    });
    expect(current.adapter.executions).toBe(1);
    expect(current.api.messages.filter((message) => message.text.startsWith("Done"))).toHaveLength(1);
  });

  it("retries the same human-only refusal when its Telegram send fails", async () => {
    const current = setup();
    await pairOwner(current);
    const card = await current.engine.proposeFixture(fixture, "openclaw-reference");
    await current.service.deliverProposal(card);
    const binding = current.store.read().proposals[0]!;
    current.adapter.conflict = true;
    let pendingWhenDeliveryStarted = false;
    current.api.beforeSend = (text) => {
      if (text.includes("calendar changed")) {
        pendingWhenDeliveryStarted =
          current.store.read().proposals[0]?.conflictDeliveredAt === undefined;
      }
    };
    current.api.failNextMessageMatching = (text) => text.includes("calendar changed");
    const callback = {
      update_id: 40,
      callback_query: {
        id: "owner-conflict-failure",
        from: { id: 101, is_bot: false },
        data: binding.callbackValue,
        message: {
          message_id: binding.messageId,
          chat: { id: -500, type: "supergroup" },
        },
      },
    } satisfies TelegramUpdate;

    await expect(current.service.handleUpdate(callback)).resolves.toBeUndefined();
    expect(pendingWhenDeliveryStarted).toBe(true);
    expect(current.store.read().proposals[0]).toMatchObject({
      lifecycle: "conflict",
    });
    expect(current.store.read().proposals[0]?.conflictDeliveredAt).toBeUndefined();
    expect(current.engine.getAgentReceipt(card.draftId)).toEqual({
      draftId: card.draftId,
      status: "conflict",
    });
    expect(current.authorityStore.getOneTimeBandsForDraft(card.draftId)).toHaveLength(1);
    expect(current.authorityStore.getPermitsForDraft(card.draftId)).toHaveLength(1);
    expect(current.store.read().proposals[0]).not.toHaveProperty("receiptId");

    await current.service.handleUpdate({
      ...callback,
      update_id: 41,
      callback_query: { ...callback.callback_query, id: "owner-conflict-retry" },
    });
    expect(current.store.read().proposals[0]?.conflictDeliveredAt).toBeDefined();
    expect(current.api.messages.filter((message) => message.text.includes("calendar changed"))).toHaveLength(1);
    expect(current.api.messages.some((message) => message.text.startsWith("Done"))).toBe(false);
  });

  it("keeps a changed-world explanation human-only and creates no Receipt", async () => {
    const current = setup();
    await pairOwner(current);
    const card = await current.engine.proposeFixture(fixture, "openclaw-reference");
    await current.service.deliverProposal(card);
    const binding = current.store.read().proposals[0]!;
    current.adapter.conflict = true;

    const callback = {
      update_id: 20,
      callback_query: {
        id: "owner-conflict",
        from: { id: 101, is_bot: false },
        data: binding.callbackValue,
        message: {
          message_id: binding.messageId,
          chat: { id: -500, type: "supergroup" },
        },
      },
    } satisfies TelegramUpdate;
    await current.service.handleUpdate(callback);
    await current.service.handleUpdate({
      ...callback,
      update_id: 21,
      callback_query: { ...callback.callback_query, id: "owner-conflict-replay" },
    });

    expect(current.engine.getAgentReceipt(card.draftId)).toEqual({
      draftId: card.draftId,
      status: "conflict",
    });
    expect(current.store.read().proposals[0]).toMatchObject({
      lifecycle: "conflict",
    });
    expect(current.authorityStore.getOneTimeBandsForDraft(card.draftId)).toHaveLength(1);
    expect(current.authorityStore.getPermitsForDraft(card.draftId)).toHaveLength(1);
    expect(current.api.messages.filter((message) => message.text.includes("calendar changed"))).toHaveLength(1);
    expect(current.api.messages.some((message) => message.text.startsWith("Done"))).toBe(false);
    expect(current.store.read().proposals[0]).not.toHaveProperty("receiptId");
  });
});
