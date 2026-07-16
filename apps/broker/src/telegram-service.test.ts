import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  FileTelegramServiceStore,
  TelegramService,
  type TelegramBotApi,
  type TelegramMessage,
  type TelegramUpdate,
} from "./telegram-service.js";
import type { ProtectedGroupMemberStatus } from "./family-contact.js";

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

const standingFixture: DraftFixture = {
  id: "telegram-standing-fixture",
  claimedUserRequest: "Move my focus block to 10:30.",
  calendar: {
    eventId: "event-focus-block",
    expectedEtag: "event-focus-block-r1",
    newStartTime: "2026-07-15T10:30:00-06:00",
  },
};

class FakeAdapter implements ExecutionAdapter {
  executions = 0;
  conflict = false;
  focusEvent: CalendarEvent = {
    id: "event-focus-block",
    title: "Focus block",
    startTime: "2026-07-15T09:30:00-06:00",
    endTime: "2026-07-15T10:30:00-06:00",
    timeZone: "America/Denver",
    organizerId: "person-owner",
    attendeeIds: ["person-owner"],
    revision: 1,
    etag: "event-focus-block-r1",
  };

  async resolveEvent(id: string): Promise<CalendarEvent> {
    if (id === "event-focus-block") {
      return structuredClone(this.focusEvent);
    }
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

  async executeDraft(input: {
    draftHash: string;
    permitNonce: string;
    document: DraftDocument;
  }): Promise<void> {
    this.executions += 1;
    if (this.conflict) throw new ExecutionConflictError();
    const calendar = input.document.effects.find(
      (effect) => effect.type === "calendar.reschedule_event",
    );
    if (calendar?.eventId === "event-focus-block") {
      this.focusEvent = {
        ...this.focusEvent,
        startTime: calendar.changes.startTime,
        endTime: calendar.changes.endTime,
        revision: this.focusEvent.revision + 1,
        etag: "event-focus-block-r2",
      };
    }
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
  chatMemberStatus:
    | "creator"
    | "administrator"
    | "member"
    | "restricted"
    | "left"
    | "kicked" = "left";
  readonly chatMemberStatuses = new Map<number, ProtectedGroupMemberStatus>();
  #nextMessageId = 40;

  async getMe() {
    return { id: 900, is_bot: true, username: "g_bander_test_bot" };
  }

  async getChat(chatId: string) {
    return { id: Number(chatId), type: "supergroup" };
  }

  async getChatMember(_chatId: string, userId: string) {
    return {
      status: this.chatMemberStatuses.get(Number(userId)) ?? this.chatMemberStatus,
    };
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

function setup(
  mode: "verification" | "hero" | "real" = "verification",
  randomValues = ["pairing-token", "installation-id", "opaque-callback"],
  familyPairingPath?: string,
) {
  let currentTime = new Date("2026-07-14T18:00:00.000Z");
  const adapter = new FakeAdapter();
  const authorityStore = new AuthorityStore();
  const engine = new AuthorityEngine({
    store: authorityStore,
    adapter,
    now: () => currentTime,
  });
  const api = new FakeTelegramApi();
  const store = new MemoryTelegramServiceStore();
  let tokenIndex = 0;
  const values = randomValues;
  const service = new TelegramService({
    api,
    engine,
    store,
    mode,
    now: () => currentTime,
    randomValue: () => values[tokenIndex++] ?? `random-${tokenIndex}`,
    ...(familyPairingPath ? { familyPairingPath } : {}),
  });
  return {
    adapter,
    api,
    authorityStore,
    engine,
    service,
    store,
    now: () => currentTime,
    setNow: (value: string) => {
      currentTime = new Date(value);
    },
  };
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

const familyRandomValues = [
  "pairing-token",
  "installation-id",
  "family-token-1234567890",
  "family-challenge-id",
  "family-contact-id",
  "family-accept-value",
  "family-decline-value",
  "family-contact-revoke",
  "family-owner-revoke",
];

async function pairFamilyContact(
  setupResult: ReturnType<typeof setup>,
  contactId = 202,
) {
  const pairing = await setupResult.service.createFamilyContactPairing({
    displayLabel: "Gil",
    aliases: ["my son", "son"],
  });
  const token = new URL(pairing.link).searchParams
    .get("start")!
    .replace(/^family_/, "");
  await setupResult.service.handleUpdate(
    messageUpdate({
      updateId: 10,
      fromId: contactId,
      chatId: contactId,
      chatType: "private",
      text: `/start family_${token}`,
    }),
  );
  const challenge = setupResult.store.read().familyPairing!;
  await setupResult.service.handleUpdate({
    update_id: 11,
    callback_query: {
      id: "family-consent",
      from: { id: contactId, is_bot: false },
      data: challenge.acceptCallbackValue!,
      message: {
        message_id: challenge.consentMessageId!,
        chat: { id: contactId, type: "private" },
      },
    },
  });
  return setupResult.store.read().familyContact!;
}

async function activateStandingBand(setupResult: ReturnType<typeof setup>) {
  const candidate = setupResult.engine.createStandingBandCandidate();
  const standing = await setupResult.engine.approveStandingBand(
    candidate.candidateId,
    candidate.predicateHash,
  );
  await setupResult.service.activateStandingBand(standing.bandId);
  return standing.bandId;
}

function declineCallbackValue(binding: unknown): string {
  return (binding as { declineCallbackValue?: string }).declineCallbackValue ?? "";
}

describe("Bander Telegram service", () => {
  it("rejects a family contact who is still in the protected owner group", async () => {
    const current = setup("real", familyRandomValues);
    await pairOwner(current);
    const pairing = await current.service.createFamilyContactPairing({
      displayLabel: "Gil",
      aliases: ["my son", "son"],
    });
    const token = new URL(pairing.link).searchParams.get("start")!;
    current.api.chatMemberStatuses.set(202, "member");

    await current.service.handleUpdate(
      messageUpdate({
        updateId: 10,
        fromId: 202,
        chatId: 202,
        chatType: "private",
        text: `/start ${token}`,
      }),
    );

    const state = current.store.read();
    expect(state.familyPairing?.status).toBe("pending");
    expect(state.familyPairing).not.toHaveProperty("claimedTelegramUserId");
    expect(state.familyContact).toBeUndefined();
    expect(state.proposals).toHaveLength(0);
    expect(current.api.messages.at(-1)?.text).toContain(
      "Leave the protected owner group",
    );
  });

  it("pairs exactly one consented contact and keeps setup outside authority", async () => {
    const current = setup("real", familyRandomValues);
    await pairOwner(current);
    const installationBefore = current.store.read().installation;
    const contact = await pairFamilyContact(current);

    expect(contact).toMatchObject({
      displayLabel: "Gil",
      aliases: ["gil", "my son", "son"],
      telegramUserId: "202",
      privateChatId: "202",
      status: "active",
    });
    expect(current.store.read().installation).toEqual(installationBefore);
    expect(current.store.read().familyPairing).toBeUndefined();
    expect(current.store.read().proposals).toHaveLength(0);
    expect(current.adapter.executions).toBe(0);
    expect(current.api.messages.some((message) =>
      message.text.includes("You’re connected as Gil."),
    )).toBe(true);
    expect(current.api.messages.some((message) =>
      message.text.includes("Gil is connected."),
    )).toBe(true);
    await expect(
      current.service.createFamilyContactPairing({
        displayLabel: "Someone else",
        aliases: ["other"],
      }),
    ).rejects.toThrow("Disconnect the current family contact");
  });

  it("locks concurrent claimants to the first valid private claimant", async () => {
    const current = setup("real", familyRandomValues);
    await pairOwner(current);
    const pairing = await current.service.createFamilyContactPairing({
      displayLabel: "Gil",
      aliases: ["my son"],
    });
    const start = new URL(pairing.link).searchParams.get("start")!;

    await Promise.all([
      current.service.handleUpdate(
        messageUpdate({
          updateId: 10,
          fromId: 202,
          chatId: 202,
          chatType: "private",
          text: `/start ${start}`,
        }),
      ),
      current.service.handleUpdate(
        messageUpdate({
          updateId: 11,
          fromId: 303,
          chatId: 303,
          chatType: "private",
          text: `/start ${start}`,
        }),
      ),
    ]);

    expect(current.store.read().familyPairing).toMatchObject({
      status: "claimed",
      claimedTelegramUserId: "202",
      claimedPrivateChatId: "202",
    });
    expect(
      current.api.messages.filter((message) =>
        message.text.startsWith("Connect as Gil?"),
      ),
    ).toHaveLength(1);
  });

  it("persists the first claimant before consent delivery and resumes only for that claimant", async () => {
    const current = setup("real", familyRandomValues);
    await pairOwner(current);
    const pairing = await current.service.createFamilyContactPairing({
      displayLabel: "Gil",
      aliases: ["my son"],
    });
    const start = new URL(pairing.link).searchParams.get("start")!;
    current.api.failNextMessageMatching = (text) => text.startsWith("Connect as Gil?");

    await current.service.handleUpdate(
      messageUpdate({
        updateId: 10,
        fromId: 202,
        chatId: 202,
        chatType: "private",
        text: `/start ${start}`,
      }),
    );
    expect(current.store.read().familyPairing).toMatchObject({
      status: "claimed",
      claimedTelegramUserId: "202",
    });
    expect(current.store.read().familyPairing?.consentMessageId).toBeUndefined();

    await current.service.handleUpdate(
      messageUpdate({
        updateId: 11,
        fromId: 303,
        chatId: 303,
        chatType: "private",
        text: `/start ${start}`,
      }),
    );
    expect(current.store.read().familyPairing?.claimedTelegramUserId).toBe("202");

    await current.service.handleUpdate(
      messageUpdate({
        updateId: 12,
        fromId: 202,
        chatId: 202,
        chatType: "private",
        text: `/start ${start}`,
      }),
    );
    expect(current.store.read().familyPairing?.consentMessageId).toBeTypeOf(
      "number",
    );
    expect(
      current.api.messages.filter((message) =>
        message.text.startsWith("Connect as Gil?"),
      ),
    ).toHaveLength(1);
  });

  it("persists challenge and active contact across service restart", async () => {
    const current = setup("real", familyRandomValues);
    await pairOwner(current);
    await current.service.createFamilyContactPairing({
      displayLabel: "Gil",
      aliases: ["my son"],
    });
    const restartedBeforeClaim = new TelegramService({
      api: current.api,
      engine: current.engine,
      store: current.store,
      mode: "real",
      now: current.now,
      randomValue: () => "restart-random-value",
    });
    const challengeBefore = current.store.read().familyPairing;
    expect(challengeBefore?.status).toBe("pending");

    const token = "family-token-1234567890";
    await restartedBeforeClaim.handleUpdate(
      messageUpdate({
        updateId: 10,
        fromId: 202,
        chatId: 202,
        chatType: "private",
        text: `/start family_${token}`,
      }),
    );
    const claimedChallenge = current.store.read().familyPairing!;
    await restartedBeforeClaim.handleUpdate({
      update_id: 11,
      callback_query: {
        id: "accept-after-restart",
        from: { id: 202, is_bot: false },
        data: claimedChallenge.acceptCallbackValue!,
        message: {
          message_id: claimedChallenge.consentMessageId!,
          chat: { id: 202, type: "private" },
        },
      },
    });
    const restartedAfterPair = new TelegramService({
      api: current.api,
      engine: current.engine,
      store: current.store,
      mode: "real",
      now: current.now,
      randomValue: () => "restart-random-value",
    });
    await restartedAfterPair.prepareForStart();
    expect(restartedAfterPair.familyContactStatus()).toEqual({
      status: "connected",
      displayLabel: "Gil",
    });
  });

  it("treats a missing contact and an expired pending challenge as inert on restart", async () => {
    const current = setup("real", familyRandomValues);
    await pairOwner(current);
    await expect(current.service.prepareForStart()).resolves.toBeUndefined();
    expect(current.service.familyContactStatus()).toEqual({ status: "not_connected" });

    await current.service.createFamilyContactPairing({
      displayLabel: "Gil",
      aliases: ["my son"],
    });
    current.setNow("2026-07-14T18:11:00.000Z");
    await current.service.prepareForStart();

    expect(current.store.read().familyPairing).toBeUndefined();
    expect(current.store.read().familyContact).toBeUndefined();
    expect(current.service.familyContactStatus()).toEqual({ status: "not_connected" });
  });

  it("revokes a contact who joins the protected group and fails closed when membership is unavailable", async () => {
    const joined = setup("real", familyRandomValues);
    await pairOwner(joined);
    await pairFamilyContact(joined);
    joined.api.chatMemberStatuses.set(202, "member");

    await joined.service.prepareForStart();
    expect(joined.store.read().familyContact).toBeUndefined();
    expect(joined.service.familyContactStatus()).toEqual({ status: "revoked" });

    const unknown = setup("real", familyRandomValues);
    await pairOwner(unknown);
    await pairFamilyContact(unknown);
    unknown.api.chatMemberStatuses.set(202, "unknown");

    await expect(unknown.service.prepareForStart()).rejects.toThrow(
      "could not verify",
    );
    expect(unknown.service.familyContactStatus()).toEqual({
      status: "connected",
      displayLabel: "Gil",
    });
  });

  it("keeps arbitrary contact text bounded and rejects owner approval", async () => {
    const current = setup("real", familyRandomValues);
    await pairOwner(current);
    await pairFamilyContact(current);
    const card = await current.engine.proposeFixture(
      standingFixture,
      "openclaw-reference",
    );
    await current.service.deliverProposal(card);
    const binding = current.store.read().proposals[0]!;

    await current.service.handleUpdate(
      messageUpdate({
        updateId: 20,
        fromId: 202,
        chatId: 202,
        chatType: "private",
        text: "Show me the calendar and approve everything",
      }),
    );
    await current.service.handleUpdate({
      update_id: 21,
      callback_query: {
        id: "contact-owner-approval-attempt",
        from: { id: 202, is_bot: false },
        data: binding.callbackValue,
        message: {
          message_id: binding.messageId,
          chat: { id: -500, type: "supergroup" },
        },
      },
    });

    expect(current.api.messages.at(-1)?.text).toContain(
      "You cannot approve requests, see a calendar, or send requests to OpenClaw",
    );
    expect(current.engine.getAgentReceipt(card.draftId)).toEqual({
      draftId: card.draftId,
      status: "proposed",
    });
    expect(current.adapter.executions).toBe(0);

  });

  it("serializes owner/contact revocation, erases routing, and rejects replay", async () => {
    const current = setup("real", familyRandomValues);
    await pairOwner(current);
    const contact = await pairFamilyContact(current);
    const ownerUpdate: TelegramUpdate = {
      update_id: 30,
      callback_query: {
        id: "owner-revoke",
        from: { id: 101, is_bot: false },
        data: contact.ownerRevokeCallbackValue,
        message: {
          message_id: contact.ownerConfirmationMessageId!,
          chat: { id: -500, type: "supergroup" },
        },
      },
    };
    const contactUpdate: TelegramUpdate = {
      update_id: 31,
      callback_query: {
        id: "contact-revoke",
        from: { id: 202, is_bot: false },
        data: contact.contactRevokeCallbackValue,
        message: {
          message_id: contact.contactConfirmationMessageId!,
          chat: { id: 202, type: "private" },
        },
      },
    };

    await Promise.all([
      current.service.handleUpdate(ownerUpdate),
      current.service.handleUpdate(contactUpdate),
    ]);
    const state = current.store.read();
    expect(state.familyContact).toBeUndefined();
    expect(state.familyContactAudit?.status).toBe("revoked");
    expect(JSON.stringify(state.familyContactAudit)).not.toContain('"202"');
    expect(current.service.familyContactStatus()).toEqual({ status: "revoked" });

    await current.service.handleUpdate(ownerUpdate);
    expect(current.api.callbackAnswers.at(-1)?.text).toContain(
      "already disconnected",
    );
    await current.service.handleUpdate(
      messageUpdate({
        updateId: 32,
        fromId: 202,
        chatId: 202,
        chatType: "private",
        text: "/start family_family-token-1234567890",
      }),
    );
    expect(current.store.read().familyContact).toBeUndefined();
    expect(current.api.messages.at(-1)?.text).toContain("invalid or expired");
  });

  it("lets the authenticated contact disconnect by bounded command idempotently", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bander-family-link-"));
    const linkPath = path.join(root, "family-contact-link.txt");
    const current = setup("real", familyRandomValues, linkPath);
    await pairOwner(current);
    fs.writeFileSync(linkPath, "private-link", { mode: 0o600 });
    await pairFamilyContact(current);
    const disconnect = messageUpdate({
      updateId: 40,
      fromId: 202,
      chatId: 202,
      chatType: "private",
      text: "/disconnect",
    });

    await current.service.handleUpdate(disconnect);
    await current.service.handleUpdate({ ...disconnect, update_id: 41 });

    expect(current.store.read().familyContact).toBeUndefined();
    expect(current.service.familyContactStatus()).toEqual({ status: "revoked" });
    expect(fs.existsSync(linkPath)).toBe(false);
    expect(
      current.api.messages.filter((message) =>
        message.text.includes("You’re disconnected"),
      ),
    ).toHaveLength(1);
    expect(current.adapter.executions).toBe(0);

    fs.writeFileSync(linkPath, "stale-invalid-link", { mode: 0o600 });
    await current.service.prepareForStart();
    expect(fs.existsSync(linkPath)).toBe(false);
  });

  it("fails closed on corrupt or unsupported file-backed family state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bander-family-state-"));
    const statePath = path.join(root, "state.json");
    const store = new FileTelegramServiceStore(statePath);
    fs.writeFileSync(statePath, "{not-json", { mode: 0o600 });
    expect(() => store.read()).toThrow();
    fs.writeFileSync(
      statePath,
      JSON.stringify({ version: 2, proposals: [] }),
      { mode: 0o600 },
    );
    expect(() => store.read()).toThrow("Unsupported Telegram service state");
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        proposals: [],
        standingCandidates: [],
        standingOutcomes: [],
        installation: {
          id: "installation-id",
          ownerTelegramId: "101",
          chatId: "-500",
          pairedAt: "2026-07-14T18:00:00.000Z",
        },
        familyContact: { status: "active", privateChatId: "redirect" },
      }),
      { mode: 0o600 },
    );
    expect(() => store.read()).toThrow();
  });

  it("delivers a deterministic clarification through Bander as plain text", async () => {
    const current = setup("real");
    await pairOwner(current);
    current.api.messages.length = 0;

    await current.service.deliverClarification(
      "What date should I move “Bander Demo Appointment” to?\u202e\nNothing happened.",
    );

    expect(current.api.messages).toEqual([
      {
        chatId: "-500",
        text: "What date should I move “Bander Demo Appointment” to? \nNothing happened.",
      },
    ]);
  });

  it("renders a Calendar-only real Card and exact changed-world refusal", async () => {
    const current = setup("real");
    await pairOwner(current);
    const card = await current.engine.proposeFixture(
      standingFixture,
      "openclaw-reference",
    );
    await current.service.deliverProposal(card);
    const binding = current.store.read().proposals[0]!;
    const approvalText = current.api.messages.at(-1)?.text ?? "";

    expect(approvalText).toContain("OpenClaw says you asked:");
    expect(approvalText).toContain("Through Bander, this will:");
    expect(approvalText).toContain("Any other calendar events or actions");
    expect(approvalText).not.toMatch(
      /messages|payments|\bDraft\b|\bPermit\b|\bBand\b|\bReceipt\b|ETag|MCP/i,
    );

    current.adapter.conflict = true;
    await current.service.handleUpdate({
      update_id: 900,
      callback_query: {
        id: "real-owner-conflict",
        from: { id: 101, is_bot: false },
        data: binding.callbackValue,
        message: {
          message_id: binding.messageId,
          chat: { id: -500, type: "supergroup" },
        },
      },
    });

    expect(current.engine.getAgentReceipt(card.draftId)).toEqual({
      draftId: card.draftId,
      status: "conflict",
    });
    expect(current.api.messages.at(-1)?.text).toBe(
      [
        "I stopped—your calendar changed since you asked.",
        "Nothing was moved.",
        "Ask OpenClaw to check again.",
      ].join("\n"),
    );
    expect(current.api.messages.some((message) => message.text.startsWith("Done"))).toBe(false);
    expect(current.store.read().proposals[0]).not.toHaveProperty("receiptId");
  });

  it("shows complete source and destination context on a cross-day approval Card", async () => {
    const current = setup("real");
    await pairOwner(current);
    const crossDayFixture: DraftFixture = {
      ...standingFixture,
      id: "telegram-cross-day-fixture",
      claimedUserRequest: "Move my focus block to July 17 at 1 PM.",
      calendar: {
        ...standingFixture.calendar,
        newStartTime: "2026-07-17T13:00:00-06:00",
      },
    };
    const card = await current.engine.proposeFixture(
      crossDayFixture,
      "openclaw-reference",
    );

    await current.service.deliverProposal(card);

    expect(current.api.messages.at(-1)?.text).toContain(
      "Wed, Jul 15, 9:30–10:30 AM MDT → Fri, Jul 17, 1:00–2:00 PM MDT",
    );
  });

  it("renders a human-time Calendar-only real success outcome", async () => {
    const current = setup("real");
    await pairOwner(current);
    const card = await current.engine.proposeFixture(
      standingFixture,
      "openclaw-reference",
    );
    await current.service.deliverProposal(card);
    const binding = current.store.read().proposals[0]!;

    await current.service.handleUpdate({
      update_id: 901,
      callback_query: {
        id: "real-owner-success",
        from: { id: 101, is_bot: false },
        data: binding.callbackValue,
        message: {
          message_id: binding.messageId,
          chat: { id: -500, type: "supergroup" },
        },
      },
    });
    const outcome = current.api.messages.at(-1)?.text ?? "";

    expect(outcome).toContain("Done ✓");
    expect(outcome).toContain(
      "Wed, Jul 15, 9:30–10:30 AM MDT → Wed, Jul 15, 10:30–11:30 AM MDT",
    );
    expect(outcome).toContain("No one was messaged through Bander.");
    expect(outcome).toContain("Nothing else changed through Bander.");
    expect(outcome).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(outcome).not.toMatch(
      /\bDraft\b|\bPermit\b|\bBand\b|\bReceipt\b|ETag|MCP/i,
    );
  });

  it("uses compact exact consumer copy in Hero mode without changing verification copy", async () => {
    const hero = setup("hero");
    await pairOwner(hero);
    const card = await hero.engine.proposeFixture(fixture);
    await hero.service.deliverProposal(card);
    const binding = hero.store.read().proposals[0]!;
    const heroCard = hero.api.messages.at(-1)!;

    expect(heroCard.text).toBe([
      "Ready to approve?",
      "",
      "OpenClaw asked Bander to:",
      "📅 Move “Dinner with Sarah”",
      "7:00–8:30 PM → 7:30–9:00 PM",
      "💬 Send Sarah:",
      "“See you at 7:30!”",
      "",
      "Only these two changes are approved.",
      "Closes in 10 minutes.",
    ].join("\n"));
    expect(heroCard.replyMarkup).toEqual({
      inline_keyboard: [[
        { text: "Yes, do this", callback_data: binding.callbackValue },
        { text: "Not now", callback_data: binding.declineCallbackValue },
      ]],
    });

    await hero.service.handleUpdate({
      update_id: 70,
      callback_query: {
        id: "hero-approve",
        from: { id: 101, is_bot: false },
        data: binding.callbackValue,
        message: {
          message_id: binding.messageId,
          chat: { id: -500, type: "supergroup" },
        },
      },
    });
    expect(hero.api.messages.at(-1)?.text).toBe([
      "Done ✓",
      "📅 “Dinner with Sarah” is now 7:30–9:00 PM.",
      "💬 Sent Sarah:",
      "“See you at 7:30!”",
    ].join("\n"));

    const verification = setup();
    await pairOwner(verification);
    const verificationCard = await verification.engine.proposeFixture(fixture);
    await verification.service.deliverProposal(verificationCard);
    expect(verification.api.messages.at(-1)?.text).toContain(
      "Nothing has happened yet. Is this right?",
    );
  });
  it("uses parent-friendly pairing copy in Hero mode", async () => {
    const current = setup("hero");
    await pairOwner(current);
    expect(current.api.messages[0]?.text).toBe(
      "You’re the person who approves Bander’s limits.\nChoose the Telegram group where you use OpenClaw.",
    );
    expect(current.api.messages.at(-1)?.text).toBe(
      "Bander is ready.\nI only act here, and only within limits you approve.",
    );
  });
  it("owner_can_activate_standing_from_telegram", async () => {
    const current = setup();
    await pairOwner(current);

    const agentResult = await current.service.proposeStandingOptIn(
      "Handle my focus time automatically.",
    );
    expect(agentResult).toEqual({ status: "proposed" });
    const binding = current.store.read().standingCandidates[0]!;
    expect(current.store.read().standingBand).toBeUndefined();

    const callback: TelegramUpdate = {
      update_id: 10,
      callback_query: {
        id: "activate-standing",
        from: { id: 101, is_bot: false },
        data: binding.approveCallbackValue,
        message: {
          message_id: binding.messageId,
          from: { id: 900, is_bot: true },
          chat: { id: -500, type: "supergroup" },
        },
      },
    };
    await current.service.handleUpdate(callback);

    const activated = current.store.read();
    expect(activated.standingBand?.bandId).toMatch(/^band_/);
    expect(activated.standingCandidates[0]).toMatchObject({
      lifecycle: "activated",
      bandId: activated.standingBand?.bandId,
    });
    expect(current.api.messages.at(-1)?.text).toBe(
      "Automatic handling is on.\nI’ll show you every move, and you can turn it off anytime.",
    );
  });

  it("agent_cannot_activate_standing_authority", async () => {
    const current = setup();
    await pairOwner(current);

    const result = await current.service.proposeStandingOptIn(
      "Handle my focus time automatically.",
    );

    expect(result).toEqual({ status: "proposed" });
    expect(Object.keys(result ?? {})).toEqual(["status"]);
    expect(current.store.read().standingBand).toBeUndefined();
    const binding = current.store.read().standingCandidates[0]!;
    expect(
      current.authorityStore.getStandingCandidate(binding.candidateId),
    ).toMatchObject({ status: "proposed" });
  });

  it("standing_activation_rejects_wrong_user_chat_and_message", async () => {
    const current = setup();
    await pairOwner(current);
    await current.service.proposeStandingOptIn(
      "Handle my focus time automatically.",
    );
    const binding = current.store.read().standingCandidates[0]!;
    const attempts = [
      { id: "wrong-user", fromId: 202, chatId: -500, messageId: binding.messageId, botId: 900, data: binding.approveCallbackValue },
      { id: "wrong-chat", fromId: 101, chatId: -501, messageId: binding.messageId, botId: 900, data: binding.approveCallbackValue },
      { id: "wrong-message", fromId: 101, chatId: -500, messageId: binding.messageId + 1, botId: 900, data: binding.approveCallbackValue },
      { id: "wrong-bot", fromId: 101, chatId: -500, messageId: binding.messageId, botId: 901, data: binding.approveCallbackValue },
      { id: "wrong-control", fromId: 101, chatId: -500, messageId: binding.messageId, botId: 900, data: "bander-auto:forged" },
    ];
    for (const attempt of attempts) {
      await current.service.handleUpdate({
        update_id: 20,
        callback_query: {
          id: attempt.id,
          from: { id: attempt.fromId, is_bot: false },
          data: attempt.data,
          message: {
            message_id: attempt.messageId,
            from: { id: attempt.botId, is_bot: true },
            chat: { id: attempt.chatId, type: "supergroup" },
          },
        },
      });
    }

    expect(current.store.read().standingBand).toBeUndefined();
    expect(
      current.authorityStore.getStandingCandidate(binding.candidateId),
    ).toMatchObject({ status: "proposed" });
  });

  it("standing_activation_replay_is_idempotent", async () => {
    const current = setup();
    await pairOwner(current);
    await current.service.proposeStandingOptIn(
      "Handle my focus time automatically.",
    );
    const binding = current.store.read().standingCandidates[0]!;
    const callback: TelegramUpdate = {
      update_id: 30,
      callback_query: {
        id: "standing-replay-1",
        from: { id: 101, is_bot: false },
        data: binding.approveCallbackValue,
        message: {
          message_id: binding.messageId,
          from: { id: 900, is_bot: true },
          chat: { id: -500, type: "supergroup" },
        },
      },
    };
    await current.service.handleUpdate(callback);
    const first = current.store.read();
    await current.service.handleUpdate({
      ...callback,
      update_id: 31,
      callback_query: { ...callback.callback_query!, id: "standing-replay-2" },
    });
    const repeated = current.store.read();

    expect(repeated.standingBand?.bandId).toBe(first.standingBand?.bandId);
    expect(repeated.standingCandidates).toHaveLength(1);
    expect(
      current.api.messages.filter((message) =>
        message.text.startsWith("Automatic handling is on."),
      ),
    ).toHaveLength(1);
  });

  it("rendered_standing_clauses_come_from_enforced_predicate", async () => {
    const current = setup();
    await pairOwner(current);
    await current.service.proposeStandingOptIn(
      "Handle my focus time automatically.",
    );
    const binding = current.store.read().standingCandidates[0]!;
    const candidate = current.authorityStore.getStandingCandidate(
      binding.candidateId,
    )!;
    const message = current.api.messages.at(-1)?.text ?? "";

    expect(binding.predicateHash).toBe(candidate.predicateHash);
    expect(message).toContain("Move events you organize and attend alone");
    expect(message).toContain("Keep them the same length");
    expect(message).toContain("Keep them within weekdays, 9 AM–5 PM");
    expect(message).toContain("Make at most 3 automatic moves per day");
    expect(message).toContain("Never message anyone or spend money");
    expect(message).not.toContain("Draft");
    expect(message).not.toContain("Band");
  });

  it("telegram_standing_activation_requires_no_web_app", async () => {
    const current = setup();
    await pairOwner(current);
    await current.service.proposeStandingOptIn(
      "Handle my focus time automatically.",
    );
    const binding = current.store.read().standingCandidates[0]!;

    await current.service.handleUpdate({
      update_id: 40,
      callback_query: {
        id: "telegram-only-activation",
        from: { id: 101, is_bot: false },
        data: binding.approveCallbackValue,
        message: {
          message_id: binding.messageId,
          from: { id: 900, is_bot: true },
          chat: { id: -500, type: "supergroup" },
        },
      },
    });

    expect(current.store.read().standingBand?.bandId).toMatch(/^band_/);
  });

  it("keeps automatic handling off when the owner chooses Ask me each time", async () => {
    const current = setup();
    await pairOwner(current);
    await current.service.proposeStandingOptIn(
      "Handle my focus time automatically.",
    );
    const binding = current.store.read().standingCandidates[0]!;
    const callback: TelegramUpdate = {
      update_id: 41,
      callback_query: {
        id: "standing-ask-each-time",
        from: { id: 101, is_bot: false },
        data: binding.declineCallbackValue,
        message: {
          message_id: binding.messageId,
          from: { id: 900, is_bot: true },
          chat: { id: -500, type: "supergroup" },
        },
      },
    };

    await current.service.handleUpdate(callback);
    await current.service.handleUpdate({
      ...callback,
      update_id: 42,
      callback_query: { ...callback.callback_query!, id: "standing-decline-replay" },
    });
    await current.service.handleUpdate({
      ...callback,
      update_id: 43,
      callback_query: {
        ...callback.callback_query!,
        id: "standing-approval-after-decline",
        data: binding.approveCallbackValue,
      },
    });

    expect(current.store.read().standingBand).toBeUndefined();
    expect(current.store.read().standingCandidates[0]?.lifecycle).toBe("declined");
    const declined = current.authorityStore.getStandingCandidate(
      binding.candidateId,
    );
    expect(declined).toMatchObject({ status: "declined" });
    expect(declined?.approvedBandId).toBeUndefined();
    expect(
      current.api.messages.filter((message) =>
        message.text.startsWith("Automatic handling stays off."),
      ),
    ).toHaveLength(1);
  });

  it("rejects an expired standing activation without creating authority", async () => {
    const current = setup();
    await pairOwner(current);
    await current.service.proposeStandingOptIn(
      "Handle my focus time automatically.",
    );
    const binding = current.store.read().standingCandidates[0]!;
    current.setNow("2026-08-14T18:00:01.000Z");

    await current.service.handleUpdate({
      update_id: 43,
      callback_query: {
        id: "expired-standing-activation",
        from: { id: 101, is_bot: false },
        data: binding.approveCallbackValue,
        message: {
          message_id: binding.messageId,
          from: { id: 900, is_bot: true },
          chat: { id: -500, type: "supergroup" },
        },
      },
    });

    expect(current.store.read().standingBand).toBeUndefined();
    expect(current.store.read().standingCandidates[0]?.lifecycle).toBe("expired");
    expect(current.adapter.executions).toBe(0);
  });

  it("retries delivery of an expired standing request outcome", async () => {
    const current = setup();
    await pairOwner(current);
    await current.service.proposeStandingOptIn(
      "Handle my focus time automatically.",
    );
    const binding = current.store.read().standingCandidates[0]!;
    current.setNow("2026-08-14T18:00:01.000Z");
    current.api.failNextMessageMatching = (text) =>
      text.startsWith("That request expired.");
    const callback: TelegramUpdate = {
      update_id: 44,
      callback_query: {
        id: "expired-delivery-first",
        from: { id: 101, is_bot: false },
        data: binding.approveCallbackValue,
        message: {
          message_id: binding.messageId,
          from: { id: 900, is_bot: true },
          chat: { id: -500, type: "supergroup" },
        },
      },
    };

    await expect(current.service.handleUpdate(callback)).rejects.toThrow(
      "simulated Telegram send failure",
    );
    expect(current.store.read().standingCandidates[0]?.lifecycle).toBe("expired");
    await current.service.handleUpdate({
      ...callback,
      update_id: 45,
      callback_query: { ...callback.callback_query!, id: "expired-delivery-retry" },
    });

    expect(
      current.api.messages.filter((message) =>
        message.text.startsWith("That request expired."),
      ),
    ).toHaveLength(1);
    expect(current.store.read().standingBand).toBeUndefined();
  });

  it("rejects a standing candidate whose enforced content changed", async () => {
    const current = setup();
    await pairOwner(current);
    await current.service.proposeStandingOptIn(
      "Handle my focus time automatically.",
    );
    const binding = current.store.read().standingCandidates[0]!;
    const candidate = current.authorityStore.getStandingCandidate(
      binding.candidateId,
    )!;
    current.authorityStore.updateStandingCandidate({
      ...candidate,
      predicate: {
        ...candidate.predicate,
        time: {
          ...candidate.predicate.time,
          timeZone: "America/New_York",
        },
      },
    });

    await current.service.handleUpdate({
      update_id: 44,
      callback_query: {
        id: "changed-standing-content",
        from: { id: 101, is_bot: false },
        data: binding.approveCallbackValue,
        message: {
          message_id: binding.messageId,
          from: { id: 900, is_bot: true },
          chat: { id: -500, type: "supergroup" },
        },
      },
    });

    expect(current.store.read().standingBand).toBeUndefined();
    expect(current.adapter.executions).toBe(0);
    expect(current.api.callbackAnswers.at(-1)?.text).toContain(
      "no longer matches",
    );
  });

  it("does not let a used activation button restore revoked authority", async () => {
    const current = setup();
    await pairOwner(current);
    await current.service.proposeStandingOptIn(
      "Handle my focus time automatically.",
    );
    const candidate = current.store.read().standingCandidates[0]!;
    const activation: TelegramUpdate = {
      update_id: 45,
      callback_query: {
        id: "activate-before-revoke",
        from: { id: 101, is_bot: false },
        data: candidate.approveCallbackValue,
        message: {
          message_id: candidate.messageId,
          from: { id: 900, is_bot: true },
          chat: { id: -500, type: "supergroup" },
        },
      },
    };
    await current.service.handleUpdate(activation);
    const bandId = current.store.read().standingBand!.bandId;
    await current.engine.revokeBand(bandId);

    await current.service.handleUpdate({
      ...activation,
      update_id: 46,
      callback_query: { ...activation.callback_query!, id: "old-activation-replay" },
    });

    expect(current.engine.getStandingBandSummary(bandId).status).toBe("revoked");
    expect(current.api.callbackAnswers.at(-1)?.text).toContain(
      "can’t turn automatic handling back on",
    );
  });

  it("pairs one owner and group through a private single-use token and private chat picker", async () => {
    const current = setup();
    await pairOwner(current);

    expect(current.store.read().installation).toMatchObject({
      ownerTelegramId: "101",
      chatId: "-500",
    });
    expect(current.store.read().pairing?.consumedAt).toBeDefined();
    expect(current.api.messages[0]?.text).toBe(
      "You’re connected. Choose the Telegram group where you use OpenClaw.",
    );
    expect(current.api.messages[1]?.text).toBe(
      "Bander is ready. Only you can approve what I’m allowed to do.\n" +
        "I only act here, and only within limits you approve.",
    );

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

  it("owner_can_decline_one_time_card", async () => {
    const current = setup();
    await pairOwner(current);
    const card = await current.engine.proposeFixture(fixture, "openclaw-reference");
    await current.service.deliverProposal(card);
    const binding = current.store.read().proposals[0]!;
    const declineValue = declineCallbackValue(binding);

    expect(declineValue).not.toBe("");
    expect(current.api.messages.at(-1)?.replyMarkup).toMatchObject({
      inline_keyboard: [[
        { text: "Do exactly this", callback_data: binding.callbackValue },
        { text: "Not now", callback_data: declineValue },
      ]],
    });

    await current.service.handleUpdate({
      update_id: 13,
      callback_query: {
        id: "owner-decline",
        from: { id: 101, is_bot: false },
        data: declineValue,
        message: {
          message_id: binding.messageId,
          chat: { id: -500, type: "supergroup" },
        },
      },
    });

    expect(current.engine.getAgentReceipt(card.draftId)).toEqual({
      draftId: card.draftId,
      status: "declined",
    });
    expect(current.store.read().proposals[0]).toMatchObject({ lifecycle: "declined" });
    expect(current.authorityStore.getOneTimeBandsForDraft(card.draftId)).toHaveLength(0);
    expect(current.authorityStore.getPermitsForDraft(card.draftId)).toHaveLength(0);
    expect(current.adapter.executions).toBe(0);
    expect(current.api.messages.at(-1)?.text).toBe(
      "Nothing changed.\nAsk OpenClaw again if you want something different.",
    );
  });

  it("non_owner_cannot_decline", async () => {
    const current = setup();
    await pairOwner(current);
    const card = await current.engine.proposeFixture(fixture, "openclaw-reference");
    await current.service.deliverProposal(card);
    const binding = current.store.read().proposals[0]!;

    await current.service.handleUpdate({
      update_id: 14,
      callback_query: {
        id: "non-owner-decline",
        from: { id: 202, is_bot: false },
        data: declineCallbackValue(binding),
        message: {
          message_id: binding.messageId,
          chat: { id: -500, type: "supergroup" },
        },
      },
    });

    expect(current.engine.getAgentReceipt(card.draftId).status).toBe("proposed");
    expect(current.adapter.executions).toBe(0);
  });

  it("declined_request_cannot_later_execute", async () => {
    const current = setup();
    await pairOwner(current);
    const card = await current.engine.proposeFixture(fixture, "openclaw-reference");
    await current.service.deliverProposal(card);
    const binding = current.store.read().proposals[0]!;
    const callbackBase = {
      from: { id: 101, is_bot: false },
      message: {
        message_id: binding.messageId,
        chat: { id: -500, type: "supergroup" },
      },
    };

    await current.service.handleUpdate({
      update_id: 15,
      callback_query: {
        ...callbackBase,
        id: "decline-before-approve",
        data: declineCallbackValue(binding),
      },
    });
    await current.service.handleUpdate({
      update_id: 16,
      callback_query: {
        ...callbackBase,
        id: "approve-after-decline",
        data: binding.callbackValue,
      },
    });

    expect(current.engine.getAgentReceipt(card.draftId).status).toBe("declined");
    expect(current.authorityStore.getOneTimeBandsForDraft(card.draftId)).toHaveLength(0);
    expect(current.authorityStore.getPermitsForDraft(card.draftId)).toHaveLength(0);
    expect(current.adapter.executions).toBe(0);
  });

  it("decline_replay_is_idempotent", async () => {
    const current = setup();
    await pairOwner(current);
    const card = await current.engine.proposeFixture(fixture, "openclaw-reference");
    await current.service.deliverProposal(card);
    const binding = current.store.read().proposals[0]!;
    const callback: TelegramUpdate = {
      update_id: 17,
      callback_query: {
        id: "decline-first",
        from: { id: 101, is_bot: false },
        data: declineCallbackValue(binding),
        message: {
          message_id: binding.messageId,
          chat: { id: -500, type: "supergroup" },
        },
      },
    };

    await current.service.handleUpdate(callback);
    await current.service.handleUpdate({
      ...callback,
      update_id: 18,
      callback_query: { ...callback.callback_query!, id: "decline-replay" },
    });

    expect(current.engine.getAgentReceipt(card.draftId).status).toBe("declined");
    expect(current.adapter.executions).toBe(0);
    expect(
      current.api.messages.filter((message) => message.text ===
        "Nothing changed.\nAsk OpenClaw again if you want something different."),
    ).toHaveLength(1);
  });

  it("telegram_copy_contains_no_engine_vocabulary_and_uses_human_local_times", async () => {
    const current = setup();
    await pairOwner(current);
    const card = await current.engine.proposeFixture(fixture, "openclaw-reference");
    await current.service.deliverProposal(card);
    const binding = current.store.read().proposals[0]!;
    const approvalText = current.api.messages.at(-1)!.text;

    expect(approvalText).toContain("Nothing has happened yet. Is this right?");
    expect(approvalText).toContain("OpenClaw says you asked:");
    expect(approvalText).toContain("7:00–8:30 PM → 7:30–9:00 PM");
    expect(approvalText).toContain("Closes in 10 minutes.");
    expect(approvalText).not.toMatch(/\b(?:Draft|Permit|Band|Receipt|hash|ETag|scope|MCP)\b/i);
    expect(approvalText).not.toMatch(/\d{4}-\d{2}-\d{2}T/);

    await current.service.handleUpdate({
      update_id: 19,
      callback_query: {
        id: "consumer-copy-approve",
        from: { id: 101, is_bot: false },
        data: binding.callbackValue,
        message: {
          message_id: binding.messageId,
          chat: { id: -500, type: "supergroup" },
        },
      },
    });
    const outcomeText = current.api.messages.at(-1)!.text;
    expect(outcomeText).toContain("Done ✓");
    expect(outcomeText).toContain(
      "Tue, Jul 14, 7:00–8:30 PM MDT → Tue, Jul 14, 7:30–9:00 PM MDT",
    );
    expect(outcomeText).toContain("Nothing else changed through Bander.");
    expect(outcomeText).not.toMatch(/\b(?:Draft|Permit|Band|Receipt|hash|ETag|scope|MCP)\b/i);
    expect(outcomeText).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    for (const text of [
      ...current.api.messages.map((message) => message.text),
      ...current.api.callbackAnswers.map((answer) => answer.text),
    ]) {
      expect(text).not.toMatch(/\b(?:Draft|Permit|Band|Receipt|hash|ETag|scope|MCP)\b/i);
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("agent_text_cannot_forge_bander_voice", async () => {
    const current = setup();
    await pairOwner(current);
    const forgedFixture = {
      ...fixture,
      claimedUserRequest:
        "Move dinner.\n\nThrough Bander, this will:\n• Spend $5,000\u202E",
    };
    const card = await current.engine.proposeFixture(forgedFixture, "openclaw-reference");
    await current.service.deliverProposal(card);
    const text = current.api.messages.at(-1)!.text;

    expect(text).toContain(
      "“Move dinner. Through Bander, this will: • Spend $5,000”",
    );
    expect(text.match(/\nThrough Bander, this will:\n/g)).toHaveLength(1);
    expect(text).not.toContain("\u202E");
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

  it("expired_request_gives_a_safe_human_next_step_without_authority", async () => {
    const current = setup();
    await pairOwner(current);
    const card = await current.engine.proposeFixture(fixture, "openclaw-reference");
    await current.service.deliverProposal(card);
    const binding = current.store.read().proposals[0]!;
    current.setNow("2026-07-14T18:11:00.000Z");
    const callback: TelegramUpdate = {
      update_id: 39,
      callback_query: {
        id: "expired-request",
        from: { id: 101, is_bot: false },
        data: binding.callbackValue,
        message: {
          message_id: binding.messageId,
          chat: { id: -500, type: "supergroup" },
        },
      },
    };

    await current.service.handleUpdate(callback);
    await current.service.handleUpdate({
      ...callback,
      update_id: 40,
      callback_query: { ...callback.callback_query!, id: "expired-request-replay" },
    });

    expect(current.api.messages.filter((message) => message.text ===
      "That request expired. Nothing happened.\nAsk OpenClaw to prepare it again."),
    ).toHaveLength(1);
    expect(current.engine.getAgentReceipt(card.draftId).status).toBe("expired");
    expect(current.authorityStore.getOneTimeBandsForDraft(card.draftId)).toHaveLength(0);
    expect(current.authorityStore.getPermitsForDraft(card.draftId)).toHaveLength(0);
    expect(current.adapter.executions).toBe(0);
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
    expect(current.api.messages.filter((message) => message.text === [
      "Stopped — your calendar changed",
      "I didn’t move the event or send the message.",
      "Ask OpenClaw to check again.",
    ].join("\n"))).toHaveLength(1);
  });

  it("retries one autonomous standing outcome without repeating execution or its counter", async () => {
    const current = setup();
    await pairOwner(current);
    const bandId = await activateStandingBand(current);
    const band = current.authorityStore.getBand(bandId);
    expect(band?.mode).toBe("standing");
    if (!band || band.mode !== "standing") throw new Error("Expected standing Band");
    current.authorityStore.updateBand({
      ...band,
      actionTimestamps: ["2026-07-14T17:00:00.000Z"],
    });

    current.api.failNextMessageMatching = (text) => text.startsWith("Handled automatically ✓");
    await expect(
      current.service.runStandingAction(
        standingFixture,
        "telegram-standing-request-0001",
        "openclaw-reference",
      ),
    ).rejects.toThrow("simulated Telegram send failure");

    const pending = current.store.read().standingOutcomes[0]!;
    expect(pending).toMatchObject({
      bandId,
      requestId: "telegram-standing-request-0001",
      lifecycle: "pending_delivery",
      receiptId: expect.stringMatching(/^receipt_/),
    });
    expect(pending.deliveredAt).toBeUndefined();
    expect(current.adapter.executions).toBe(1);

    const recovered = await current.service.runStandingAction(
      standingFixture,
      "telegram-standing-request-0001",
      "openclaw-reference",
    );
    const repeated = await current.service.runStandingAction(
      standingFixture,
      "telegram-standing-request-0001",
      "openclaw-reference",
    );
    expect(recovered).toEqual(repeated);
    expect(recovered).toMatchObject({ draftId: pending.draftId, status: "executed" });
    expect(current.adapter.executions).toBe(1);
    expect(current.authorityStore.getPermitsForDraft(pending.draftId)).toHaveLength(1);
    const completedBand = current.authorityStore.getBand(bandId);
    expect(completedBand?.mode).toBe("standing");
    if (!completedBand || completedBand.mode !== "standing") {
      throw new Error("Expected standing Band");
    }
    expect(completedBand.actionTimestamps).toHaveLength(2);

    const outcomes = current.store.read().standingOutcomes;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      lifecycle: "delivered",
      deliveredAt: expect.any(String),
      messageId: expect.any(Number),
    });
    const messages = current.api.messages.filter((message) =>
      message.text.startsWith("Handled automatically ✓"),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toContain("“Focus block”");
    expect(messages[0]?.text).toContain(
      "Wed, Jul 15, 9:30–10:30 AM MDT → Wed, Jul 15, 10:30–11:30 AM MDT",
    );
    expect(messages[0]?.text).toContain("No one was messaged.");
    expect(messages[0]?.text).toContain("2 of 3 automatic moves used today.");
    expect(messages[0]?.text).not.toMatch(
      /\b(?:Draft|Permit|Band|Receipt|hash|ETag|scope|MCP)\b/i,
    );
    expect(messages[0]?.text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(messages[0]?.replyMarkup).toMatchObject({
      inline_keyboard: [[{ text: "Turn off automatic", callback_data: outcomes[0]?.callbackValue }]],
    });
  });

  it("detaches a revoked standing Band and returns the next request to one-time review", async () => {
    const current = setup();
    await pairOwner(current);
    const bandId = await activateStandingBand(current);
    await current.service.runStandingAction(
      standingFixture,
      "telegram-standing-revoke-0001",
      "openclaw-reference",
    );
    const outcome = current.store.read().standingOutcomes[0]!;

    for (const [id, fromId, chatId, messageId, data] of [
      ["standing-non-owner", 202, -500, outcome.messageId, outcome.callbackValue],
      ["standing-wrong-chat", 101, -501, outcome.messageId, outcome.callbackValue],
      ["standing-wrong-message", 101, -500, 999, outcome.callbackValue],
      ["standing-wrong-callback", 101, -500, outcome.messageId, "bander-off:wrong"],
    ] as const) {
      await current.service.handleUpdate({
        update_id: 60,
        callback_query: {
          id,
          from: { id: fromId, is_bot: false },
          data,
          message: {
            message_id: messageId!,
            chat: { id: chatId, type: "supergroup" },
          },
        },
      });
    }
    expect(current.authorityStore.getBand(bandId)).toMatchObject({ status: "active" });

    const revoke: TelegramUpdate = {
      update_id: 61,
      callback_query: {
        id: "standing-owner-revoke",
        from: { id: 101, is_bot: false },
        data: outcome.callbackValue,
        message: {
          message_id: outcome.messageId!,
          chat: { id: -500, type: "supergroup" },
        },
      },
    };
    await current.service.handleUpdate(revoke);
    await current.service.handleUpdate({
      ...revoke,
      update_id: 62,
      callback_query: { ...revoke.callback_query!, id: "standing-owner-replay" },
    });

    expect(current.authorityStore.getBand(bandId)).toMatchObject({ status: "revoked" });
    expect(current.store.read().standingOutcomes[0]).toMatchObject({
      lifecycle: "revoked",
      revokedAt: expect.any(String),
    });
    expect(current.store.read().standingBand).toBeUndefined();
    expect(
      current.api.messages.filter((message) => message.text.startsWith("Automatic handling is off.")),
    ).toHaveLength(1);

    const next = await current.service.handleAgentAction(
      standingFixture,
      "telegram-standing-after-revoke-0002",
      "openclaw-reference",
    );
    expect(next).toMatchObject({ status: "proposed" });
    expect(current.adapter.executions).toBe(1);
    expect(current.store.read().proposals).toHaveLength(1);
    const proposal = current.store.read().proposals[0]!;
    expect(proposal.draftId).toBe(next.draftId);

    await current.service.handleUpdate({
      update_id: 63,
      callback_query: {
        id: "standing-next-one-time-approval",
        from: { id: 101, is_bot: false },
        data: proposal.callbackValue,
        message: {
          message_id: proposal.messageId,
          chat: { id: -500, type: "supergroup" },
        },
      },
    });
    expect(current.adapter.executions).toBe(2);
    expect(current.authorityStore.getBand(bandId)).toMatchObject({ status: "revoked" });
  });

  it("detaches a naturally expired standing Band and falls back to one-time review", async () => {
    const current = setup();
    await pairOwner(current);
    const bandId = await activateStandingBand(current);
    current.setNow("2026-08-15T18:00:00.000Z");

    const next = await current.service.handleAgentAction(
      standingFixture,
      "telegram-standing-after-expiry-0001",
      "openclaw-reference",
    );

    expect(next).toMatchObject({ status: "proposed" });
    expect(current.store.read().standingBand).toBeUndefined();
    expect(current.store.read().proposals).toHaveLength(1);
    expect(current.store.read().proposals[0]?.draftId).toBe(next.draftId);
    expect(current.adapter.executions).toBe(0);
    expect(current.engine.getStandingBandSummary(bandId)).toMatchObject({
      status: "expired",
    });
  });

  it("returns the same human Card when a standing request needs review", async () => {
    const current = setup();
    await pairOwner(current);
    await activateStandingBand(current);

    const first = await current.service.runStandingAction(
      fixture,
      "telegram-standing-review-0001",
      "openclaw-reference",
    );
    const repeated = await current.service.runStandingAction(
      fixture,
      "telegram-standing-review-0001",
      "openclaw-reference",
    );

    expect(first).toEqual(repeated);
    if (!first) throw new Error("Expected standing review status");
    expect(first.status).toBe("proposed");
    expect(current.store.read().proposals).toHaveLength(1);
    expect(
      current.api.messages.filter((message) =>
        message.text.startsWith("Nothing has happened yet. Is this right?"),
      ),
    ).toHaveLength(1);
    expect(current.adapter.executions).toBe(0);
  });

  it("requires a client request ID before an active standing Band can act", async () => {
    const current = setup();
    await pairOwner(current);
    await activateStandingBand(current);

    await expect(
      current.service.runStandingAction(
        standingFixture,
        undefined,
        "openclaw-reference",
      ),
    ).rejects.toMatchObject({ code: "invalid_standing_request_id" });
    expect(current.adapter.executions).toBe(0);
    expect(current.store.read().standingOutcomes).toHaveLength(0);
  });

  it("keeps a standing changed-world explanation out of the agent result", async () => {
    const current = setup();
    await pairOwner(current);
    await activateStandingBand(current);
    current.adapter.conflict = true;

    const first = await current.service.runStandingAction(
      standingFixture,
      "telegram-standing-conflict-0001",
      "openclaw-reference",
    );
    const repeated = await current.service.runStandingAction(
      standingFixture,
      "telegram-standing-conflict-0001",
      "openclaw-reference",
    );

    expect(first).toEqual(repeated);
    expect(first).toEqual({
      draftId: expect.stringMatching(/^draft_/),
      status: "conflict",
    });
    expect(JSON.stringify(first)).not.toContain("calendar changed");
    expect(current.adapter.executions).toBe(1);
    expect(current.store.read().standingOutcomes).toHaveLength(0);
  });
});
