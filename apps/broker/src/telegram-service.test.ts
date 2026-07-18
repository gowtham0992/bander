import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalCard, CalendarEvent, DraftDocument, ObservedExecutionResult, Person } from "@bander/contracts";
import {
  AuthorityEngine,
  AuthorityStore,
  ExecutionAlreadyAbsentError,
  ExecutionAmbiguousError,
  ExecutionConflictError,
  ExecutionRejectedError,
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
import { renderFamilyNotification } from "./family-notification.js";
import { buildPinnedReply } from "./gmail.js";

const fixture: DraftFixture = {
  id: "telegram-fixture",
  claimedUserRequest: "Move dinner and message Sarah.",
  calendar: {
    kind: "reschedule",
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
    kind: "reschedule",
    eventId: "event-focus-block",
    expectedEtag: "event-focus-block-r1",
    newStartTime: "2026-07-15T10:30:00-06:00",
  },
};

const cancelFixture: DraftFixture = {
  id: "telegram-cancel-fixture",
  claimedUserRequest: "Cancel my dentist appointment on Thursday.",
  calendar: {
    kind: "cancel",
    eventId: "event-dentist",
    expectedEtag: "event-dentist-r1",
  },
};

const familyNotificationDocument = {
  kind: "calendar_transition",
  eventTitle: "Bander Demo Appointment",
  newStartTime: "2026-07-18T22:00:00.000Z",
  newEndTime: "2026-07-18T23:00:00.000Z",
  timeZone: "America/Denver",
} as const;

const emailFixture: DraftFixture = {
  id: "telegram-email-fixture",
  claimedUserRequest: "Reply to Ruth that Tuesday at noon works.",
  emailReply: buildPinnedReply({
    source: { messageId: "source", threadId: "thread", latestThreadMessageId: "source", rfcMessageId: "<source@example.test>", references: [], replyRecipient: "ruth@example.test", subject: "Lunch" },
    body: "Tuesday at noon works.",
    stableMessageId: "<bander-stable@example.invalid>",
  }),
};

class FakeAdapter implements ExecutionAdapter {
  executions = 0;
  ambiguous = false;
  conflict = false;
  ambiguousKind: "calendar" | "email" | "family" = "calendar";
  conflictKind: "calendar" | "email" = "calendar";
  alreadyAbsent = false;
  rejectedAction?: "create" | "cancel";
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
  compoundDelivery?: (
    input: Parameters<TelegramService["deliverBoundFamilyNotification"]>[0],
  ) => Promise<{ status: "delivered" | "ambiguous" | "not_sent" }>;

  async resolveEvent(id: string): Promise<CalendarEvent> {
    if (id === "event-dentist") {
      return {
        id,
        title: "Dentist appointment",
        startTime: "2026-07-23T13:00:00-06:00",
        endTime: "2026-07-23T14:00:00-06:00",
        timeZone: "America/Denver",
        organizerId: "person-owner",
        attendeeIds: [],
        revision: 1,
        etag: "event-dentist-r1",
      };
    }
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
  }): Promise<void | ObservedExecutionResult> {
    this.executions += 1;
    if (this.ambiguous) throw new ExecutionAmbiguousError(this.ambiguousKind);
    if (this.conflict) throw new ExecutionConflictError(this.conflictKind);
    if (this.alreadyAbsent) throw new ExecutionAlreadyAbsentError();
    if (this.rejectedAction) throw new ExecutionRejectedError(this.rejectedAction);
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
    const family = input.document.effects.find(
      (effect) => effect.type === "family.telegram_notification",
    );
    const email = input.document.effects.find((effect) => effect.type === "email.reply");
    if (email) return { emailReply: { status: "committed" } };
    if (family?.document.kind === "direct_message") {
      const delivery = this.compoundDelivery
        ? await this.compoundDelivery({ requestId: `direct-${input.permitNonce}`, binding: family.binding, document: family.document })
        : { status: "delivered" as const };
      return { familyNotification: delivery };
    }
    const cancelled = input.document.effects.find(
      (effect) => effect.type === "calendar.cancel_event",
    );
    if (cancelled) {
      return {
        calendar: {
          action: "removed",
          status: "committed",
          completed: {
            startTime: cancelled.expected.startTime,
            endTime: cancelled.expected.endTime,
            timeZone: cancelled.expected.timeZone,
          },
        },
      };
    }
    if (calendar && family && this.compoundDelivery) {
      const delivery = await this.compoundDelivery({
        requestId: `compound-${input.permitNonce}`,
        binding: family.binding,
        document: family.document,
      });
      return {
        calendar: {
          status: "committed",
          completed: {
            startTime: calendar.changes.startTime,
            endTime: calendar.changes.endTime,
            timeZone: calendar.expected.timeZone,
          },
        },
        familyNotification: { status: delivery.status },
      };
    }
  }

  async getExecution(): Promise<boolean> {
    return false;
  }
}

class FakeTelegramApi implements TelegramBotApi {
  sendAttempts = 0;
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
    this.sendAttempts += 1;
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

async function ambiguousProposal(compound: boolean) {
  const current = setup("real", familyRandomValues);
  await pairOwner(current);
  const family = compound
    ? await (async () => {
        await pairFamilyContact(current);
        const binding = current.service.resolveFamilyContactAlias("my son")!;
        return {
          ...binding,
          document: {
            kind: "calendar_transition" as const,
            eventTitle: "Dinner with Sarah",
            newStartTime: "2026-07-15T01:30:00.000Z",
            newEndTime: "2026-07-15T03:00:00.000Z",
            timeZone: "America/Denver",
          },
        };
      })()
    : undefined;
  const card = await current.engine.proposeFixture({
    id: compound ? "ambiguous-compound" : "ambiguous-calendar-only",
    claimedUserRequest: compound
      ? "Move dinner and let my son know."
      : "Move dinner.",
    calendar: fixture.calendar!,
    ...(family ? { familyNotification: family } : {}),
  });
  await current.service.deliverProposal(card);
  const binding = current.store.read().proposals.at(-1)!;
  current.adapter.ambiguous = true;
  const callback = {
    update_id: 501,
    callback_query: {
      id: "ambiguous-owner-approval",
      from: { id: 101, is_bot: false },
      data: binding.callbackValue,
      message: {
        message_id: binding.messageId,
        chat: { id: -500, type: "supergroup" },
      },
    },
  } satisfies TelegramUpdate;
  return { ...current, callback };
}

describe("Bander Telegram service", () => {
  it("renders one create Card with the exact bounded event and exclusions", async () => {
    const current = setup("real");
    await pairOwner(current);
    const card = await current.engine.proposeFixture({
      id: "create-lunch",
      claimedUserRequest: "Add lunch with Ruth next Tuesday at noon.",
      calendar: {
        kind: "create",
        eventId: "b0123456789abcdefghijklmnopqrstuv",
        title: "Lunch with Ruth",
        startTime: "2026-07-21T18:00:00.000Z",
        endTime: "2026-07-21T19:00:00.000Z",
        timeZone: "America/Denver",
      },
    });
    await current.service.deliverProposal(card);
    const text = current.api.messages.at(-1)?.text ?? "";
    expect(text).toContain("📅 Add to Calendar “Lunch with Ruth”");
    expect(text).toContain("Tuesday, Jul 21, 12:00–1:00 PM (Mountain time)");
    expect(text).toContain(
      "Only this goes on your calendar. No one is invited, nothing repeats, and nothing is booked anywhere.",
    );
    expect(text).not.toContain("b0123456789");
  });

  it("lost create response uses truthful no-retry copy", async () => {
    const current = setup("real");
    await pairOwner(current);
    const card = await current.engine.proposeFixture({
      id: "create-lunch-ambiguous",
      claimedUserRequest: "Add lunch with Ruth next Tuesday at noon.",
      calendar: {
        kind: "create",
        eventId: "b0123456789abcdefghijklmnopqrstuv",
        title: "Lunch with Ruth",
        startTime: "2026-07-21T18:00:00.000Z",
        endTime: "2026-07-21T19:00:00.000Z",
        timeZone: "America/Denver",
      },
    });
    await current.service.deliverProposal(card);
    const binding = current.store.read().proposals.at(-1)!;
    current.adapter.ambiguous = true;
    await current.service.handleUpdate({
      update_id: 700,
      callback_query: {
        id: "create-ambiguous",
        from: { id: 101, is_bot: false },
        data: binding.callbackValue,
        message: {
          message_id: binding.messageId,
          chat: { id: -500, type: "supergroup" },
        },
      },
    });
    expect(current.api.messages.at(-1)?.text).toBe([
      "Bander couldn’t confirm whether the event was added.",
      "Bander won’t try to add it again automatically.",
      "Please check your calendar before asking your assistant again.",
    ].join("\n"));
  });

  it("renders and executes one calm real cancellation Card", async () => {
    const current = setup("real");
    await pairOwner(current);
    const card = await current.engine.proposeFixture(cancelFixture);
    await current.service.deliverProposal(card);
    const binding = current.store.read().proposals.at(-1)!;
    const proposal = current.api.messages.at(-1)!;
    expect(proposal.text).toContain("📅 Remove from Calendar “Dentist appointment”");
    expect(proposal.text).toContain("Thursday, Jul 23, 1:00–2:00 PM (Mountain time)");
    expect(proposal.text).toContain(
      "Bander will not automatically restore this event after you approve.",
    );
    expect(proposal.text).toContain("Not included:");
    expect(proposal.text).toContain("This removes only the calendar event.");
    expect(proposal.text).toContain(
      "It does not contact anyone or cancel the appointment itself.",
    );
    expect(proposal.text).not.toContain("No one will be contacted through the Calendar.");
    expect(proposal.replyMarkup).toMatchObject({
      inline_keyboard: [[{ text: "Remove this event" }, { text: "Not now" }]],
    });
    await current.service.handleUpdate({
      update_id: 705,
      callback_query: {
        id: "cancel-confirmed",
        from: { id: 101, is_bot: false },
        data: binding.callbackValue,
        message: {
          message_id: binding.messageId,
          chat: { id: -500, type: "supergroup" },
        },
      },
    });
    expect(current.api.messages.at(-1)?.text).toBe([
      "Removed ✓",
      "“Dentist appointment”",
      "Thursday, Jul 23, 1:00–2:00 PM (Mountain time)",
      "Bander didn’t contact anyone.",
      "Bander changed nothing else.",
    ].join("\n"));
  });

  it("cancellation Card with family update distinguishes Calendar removal from external cancellation", async () => {
    const current = setup("real");
    await pairOwner(current);
    const card = await current.engine.proposeFixture({
      ...cancelFixture,
      familyNotification: {
        installationId: "installation-opaque",
        contactId: "contact-opaque",
        pairingRevision: "a".repeat(64),
        displayLabel: "Gil",
        document: {
          kind: "calendar_cancellation",
          eventTitle: "Dentist appointment",
          startTime: "2026-07-23T19:00:00.000Z",
          endTime: "2026-07-23T20:00:00.000Z",
          timeZone: "America/Denver",
        },
      },
    });
    await current.service.deliverProposal(card);
    const text = current.api.messages.at(-1)?.text ?? "";
    expect(text).toContain("Only the exact family update shown above will be sent.");
    expect(text).toContain("Bander will not contact the clinic, business, or event organizer.");
    expect(text).not.toContain("It does not contact anyone");
  });

  it("ambiguous cancellation never claims nothing changed or retries", async () => {
    const current = setup("real");
    await pairOwner(current);
    const card = await current.engine.proposeFixture(cancelFixture);
    await current.service.deliverProposal(card);
    const binding = current.store.read().proposals.at(-1)!;
    current.adapter.ambiguous = true;
    const callback: TelegramUpdate = {
      update_id: 706,
      callback_query: {
        id: "cancel-ambiguous",
        from: { id: 101, is_bot: false },
        data: binding.callbackValue,
        message: {
          message_id: binding.messageId,
          chat: { id: -500, type: "supergroup" },
        },
      },
    };
    await current.service.handleUpdate(callback);
    const firstExecutions = current.adapter.executions;
    expect(current.api.messages.at(-1)?.text).toBe([
      "Bander couldn’t confirm whether the event was removed.",
      "Bander won’t try to remove it again automatically.",
      "Please check your calendar before asking your assistant again.",
    ].join("\n"));
    await current.service.handleUpdate({
      ...callback,
      update_id: 707,
      callback_query: { ...callback.callback_query!, id: "cancel-ambiguous-replay" },
    });
    expect(current.adapter.executions).toBe(firstExecutions);
    expect(current.store.read().proposals.at(-1)).toMatchObject({
      terminalFailureCode: "calendar_outcome_ambiguous",
      lifecycle: "conflict",
    });
  });

  it("initially absent and definitive create rejection use distinct truthful copy", async () => {
    const absent = setup("real");
    await pairOwner(absent);
    const cancelCard = await absent.engine.proposeFixture(cancelFixture);
    await absent.service.deliverProposal(cancelCard);
    absent.adapter.alreadyAbsent = true;
    const cancelBinding = absent.store.read().proposals.at(-1)!;
    await absent.service.handleUpdate({
      update_id: 708,
      callback_query: {
        id: "cancel-absent",
        from: { id: 101, is_bot: false },
        data: cancelBinding.callbackValue,
        message: { message_id: cancelBinding.messageId, chat: { id: -500, type: "supergroup" } },
      },
    });
    expect(absent.api.messages.at(-1)?.text).toBe([
      "Bander stopped—the event was already gone from the calendar.",
      "Bander didn’t remove anything.",
      "Ask your assistant to check again if needed.",
    ].join("\n"));

    const rejected = setup("real");
    await pairOwner(rejected);
    const createCard = await rejected.engine.proposeFixture({
      id: "create-rejected",
      claimedUserRequest: "Add lunch Tuesday at noon.",
      calendar: {
        kind: "create",
        eventId: "b0123456789abcdefghijklmnopqrstuv",
        title: "Lunch",
        startTime: "2026-07-21T18:00:00.000Z",
        endTime: "2026-07-21T19:00:00.000Z",
        timeZone: "America/Denver",
      },
    });
    await rejected.service.deliverProposal(createCard);
    rejected.adapter.rejectedAction = "create";
    const createBinding = rejected.store.read().proposals.at(-1)!;
    await rejected.service.handleUpdate({
      update_id: 709,
      callback_query: {
        id: "create-rejected",
        from: { id: 101, is_bot: false },
        data: createBinding.callbackValue,
        message: { message_id: createBinding.messageId, chat: { id: -500, type: "supergroup" } },
      },
    });
    expect(rejected.api.messages.at(-1)?.text).toBe(
      "Bander couldn’t add that because the calendar service rejected it. Bander added nothing.",
    );
  });

  it("protected_group_receives_one_bander_introduction", async () => {
    const current = setup("real");
    await pairOwner(current);
    const introductions = current.api.messages.filter((message) => message.text.startsWith("I’m Bander."));
    expect(introductions).toHaveLength(1);
    expect(introductions[0]?.chatId).toBe("-500");
    expect(current.store.read().installation?.groupIntroductionDeliveredAt).toBeDefined();
    expect(current.authorityStore.getOneTimeBandsForDraft("anything")).toHaveLength(0);
    expect(current.adapter.executions).toBe(0);
  });

  it("introduction_replay_and_restart_send_nothing", async () => {
    const current = setup("real");
    await pairOwner(current);
    await current.service.prepareForStart();
    const restarted = new TelegramService({
      api: current.api,
      engine: current.engine,
      store: current.store,
      mode: "real",
      now: current.now,
    });
    await restarted.prepareForStart();
    expect(current.api.messages.filter((message) => message.text.startsWith("I’m Bander."))).toHaveLength(1);
  });

  it("introduction_failure_never_claims_delivery_and_can_recover", async () => {
    const current = setup("real");
    current.api.failNextMessageMatching = (text) => text.startsWith("I’m Bander.");
    await expect(pairOwner(current)).rejects.toThrow("simulated Telegram send failure");
    expect(current.store.read().installation?.groupIntroductionDeliveredAt).toBeUndefined();
    expect(current.api.messages.filter((message) => message.text.startsWith("I’m Bander."))).toHaveLength(0);
    await current.service.prepareForStart();
    expect(current.api.messages.filter((message) => message.text.startsWith("I’m Bander."))).toHaveLength(1);
  });

  it("contact_cannot_trigger_group_introduction", async () => {
    const current = setup("real");
    await pairOwner(current);
    await current.service.handleUpdate(messageUpdate({ updateId: 90, fromId: 202, chatId: 202, chatType: "private", text: "hello" }));
    expect(current.api.messages.filter((message) => message.text.startsWith("I’m Bander."))).toHaveLength(1);
  });
  it("compound_callback_reuses_the_existing_state_lock_without_deadlock", async () => {
    const current = setup("real", familyRandomValues);
    await pairOwner(current);
    await pairFamilyContact(current);
    current.adapter.compoundDelivery = (input) =>
      current.service.deliverBoundFamilyNotification(input);
    const binding = current.service.resolveFamilyContactAlias("my son")!;
    const card = await current.engine.proposeFixture({
      id: "compound-lock",
      claimedUserRequest: "Move dinner and let my son know.",
      calendar: {
        kind: "reschedule",
        eventId: "event-dinner-sarah",
        expectedEtag: "event-dinner-sarah-r1",
        newStartTime: "2026-07-18T22:00:00.000Z",
      },
      familyNotification: {
        ...binding,
        document: {
          kind: "calendar_transition",
          eventTitle: "Dinner with Sarah",
          newStartTime: "2026-07-18T22:00:00.000Z",
          newEndTime: "2026-07-18T23:30:00.000Z",
          timeZone: "America/Denver",
        },
      },
    });
    await current.service.deliverProposal(card);
    const proposal = current.store.read().proposals.at(-1)!;
    await expect(Promise.race([
      current.service.handleUpdate({
        update_id: 777,
        callback_query: {
          id: "compound-owner-approval",
          from: { id: 101, is_bot: false },
          data: proposal.callbackValue,
          message: {
            message_id: proposal.messageId,
            chat: { id: -500, type: "supergroup" },
          },
        },
      }).then(() => "completed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("deadlocked"), 100)),
    ])).resolves.toBe("completed");
    expect(current.store.read().proposals.at(-1)?.lifecycle).toBe("executed");
    expect(current.store.read().familyNotifications).toHaveLength(1);
  });
  it("compound_card_shows_the_exact_delivery_text", async () => {
    const current = setup("real", familyRandomValues);
    await pairOwner(current);
    await pairFamilyContact(current);
    const binding = current.service.resolveFamilyContactAlias("my son")!;
    const compoundFixture: DraftFixture = {
      id: "compound-card",
      claimedUserRequest: "Move dinner and let my son know.",
      calendar: {
        kind: "reschedule",
        eventId: "event-dinner-sarah",
        expectedEtag: "event-dinner-sarah-r1",
        newStartTime: "2026-07-18T22:00:00.000Z",
      },
      familyNotification: {
        ...binding,
        document: {
          kind: "calendar_transition",
          eventTitle: "Dinner with Sarah",
          newStartTime: "2026-07-18T22:00:00.000Z",
          newEndTime: "2026-07-18T23:30:00.000Z",
          timeZone: "America/Denver",
        },
      },
    };
    const card = await current.engine.proposeFixture(compoundFixture);
    await current.service.deliverProposal(card);
    const approval = current.api.messages.at(-1)?.text ?? "";
    expect(approval).toContain("📅 Move");
    expect(approval).toContain("💬 Send Gil this message:");
    expect(approval).toContain(renderFamilyNotification(compoundFixture.familyNotification!.document));
  });
  it("direct_family_card_text_is_the_delivered_text_and_replay_sends_nothing", async () => {
    const current = setup("real", familyRandomValues);
    await pairOwner(current);
    await pairFamilyContact(current);
    current.adapter.compoundDelivery = (input) => current.service.deliverBoundFamilyNotification(input);
    const binding = current.service.resolveFamilyContactAlias("Gil")!;
    const document = { kind: "direct_message" as const, body: "Dinner is at 6." };
    const card = await current.engine.proposeFixture({ id: "direct-family", claimedUserRequest: "Tell Gil dinner is at 6.", familyNotification: { ...binding, document } });
    await current.service.deliverProposal(card);
    const proposal = current.store.read().proposals.at(-1)!;
    const callback: TelegramUpdate = { update_id: 778, callback_query: { id: "direct-family-approve", from: { id: 101, is_bot: false }, data: proposal.callbackValue, message: { message_id: proposal.messageId, chat: { id: -500, type: "supergroup" } } } };
    await current.service.handleUpdate(callback);
    await current.service.handleUpdate({ ...callback, update_id: 779, callback_query: { ...callback.callback_query!, id: "direct-family-replay" } });
    expect(current.api.messages.filter((message) => message.chatId === "202" && message.text === renderFamilyNotification(document))).toHaveLength(1);
    expect(current.api.messages.find((message) => message.chatId === "-500" && message.text.startsWith("Bander hasn’t done anything yet"))?.text).toContain(document.body);
  });
  it("rejects_delivery_to_revoked_contact", async () => {
    const current = setup("real", familyRandomValues);
    await pairOwner(current); await pairFamilyContact(current);
    await current.service.handleUpdate(messageUpdate({ updateId: 90, fromId: 202, chatId: 202, chatType: "private", text: "/disconnect" }));
    await expect(current.service.deliverFamilyNotification({ requestId: "family-send-0001", document: familyNotificationDocument })).rejects.toThrow("No active family contact");
    expect(current.api.messages.filter((message) => message.text === renderFamilyNotification(familyNotificationDocument))).toHaveLength(0);
  });

  it("delivery_request_content_mismatch_and_confirmed_replay_send_nothing", async () => {
    const current = setup("real", familyRandomValues);
    await pairOwner(current); await pairFamilyContact(current);
    const first = await current.service.deliverFamilyNotification({ requestId: "family-send-0002", document: familyNotificationDocument });
    const replay = await current.service.deliverFamilyNotification({ requestId: "family-send-0002", document: familyNotificationDocument });
    expect(first).toEqual({ status: "delivered" }); expect(replay).toEqual(first);
    expect(current.api.messages.filter((message) => message.text === renderFamilyNotification(familyNotificationDocument))).toHaveLength(1);
    await expect(current.service.deliverFamilyNotification({ requestId: "family-send-0002", document: { ...familyNotificationDocument, eventTitle: "Changed" } })).rejects.toThrow("different content");
  });

  it("concurrent_replay_attempts_one_send_and_ambiguous_transport_is_not_retried", async () => {
    const current = setup("real", familyRandomValues);
    await pairOwner(current); await pairFamilyContact(current);
    const calls = await Promise.all(Array.from({ length: 3 }, () => current.service.deliverFamilyNotification({ requestId: "family-send-0003", document: familyNotificationDocument })));
    expect(calls).toEqual([{ status: "delivered" }, { status: "delivered" }, { status: "delivered" }]);
    expect(current.api.messages.filter((message) => message.text === renderFamilyNotification(familyNotificationDocument))).toHaveLength(1);
    const attemptsBeforeAmbiguous = current.api.sendAttempts;
    current.api.failNextMessageMatching = (text) => text === renderFamilyNotification(familyNotificationDocument);
    expect(await current.service.deliverFamilyNotification({ requestId: "family-send-0004", document: familyNotificationDocument })).toEqual({ status: "ambiguous" });
    expect(await current.service.deliverFamilyNotification({ requestId: "family-send-0004", document: familyNotificationDocument })).toEqual({ status: "ambiguous" });
    expect(current.api.messages.filter((message) => message.text === renderFamilyNotification(familyNotificationDocument))).toHaveLength(1);
    expect(current.api.sendAttempts - attemptsBeforeAmbiguous).toBe(1);
  });

  it("restart_after_delivery_sends_nothing_and_leaks_no_details", async () => {
    const current = setup("real", familyRandomValues);
    await pairOwner(current); await pairFamilyContact(current);
    const result = await current.service.deliverFamilyNotification({ requestId: "family-send-0005", document: familyNotificationDocument });
    const attempts = current.api.sendAttempts;
    const restarted = new TelegramService({ api: current.api, engine: current.engine, store: current.store, mode: "real" });
    expect(await restarted.deliverFamilyNotification({ requestId: "family-send-0005", document: familyNotificationDocument })).toEqual(result);
    expect(current.api.sendAttempts).toBe(attempts);
    expect(result).toEqual({ status: "delivered" });
    expect(JSON.stringify(result)).not.toMatch(/Gil|202|Calendar|messageId|contactId/i);
  });

  it("revocation_linearizes_before_or_after_delivery_dispatch", async () => {
    const first = setup("real", familyRandomValues);
    await pairOwner(first); await pairFamilyContact(first);
    await first.service.handleUpdate(messageUpdate({ updateId: 91, fromId: 202, chatId: 202, chatType: "private", text: "/disconnect" }));
    const attempts = first.api.sendAttempts;
    await expect(first.service.deliverFamilyNotification({ requestId: "family-send-0006", document: familyNotificationDocument })).rejects.toThrow("No active family contact");
    expect(first.api.sendAttempts).toBe(attempts);

    const second = setup("real", familyRandomValues);
    await pairOwner(second); await pairFamilyContact(second);
    let revoke: Promise<void> | undefined;
    second.api.beforeSend = (text) => { if (text === renderFamilyNotification(familyNotificationDocument)) revoke = second.service.handleUpdate(messageUpdate({ updateId: 92, fromId: 202, chatId: 202, chatType: "private", text: "/disconnect" })); };
    expect(await second.service.deliverFamilyNotification({ requestId: "family-send-0007", document: familyNotificationDocument })).toEqual({ status: "delivered" });
    await revoke;
    expect(second.api.messages.filter((message) => message.text === renderFamilyNotification(familyNotificationDocument))).toHaveLength(1);
    expect(second.store.read().familyContact).toBeUndefined();
  });

  it("replaced_contact_never_receives_old_approved_message", async () => {
    const current = setup("real", [
      ...familyRandomValues,
      "family-token-replacement-1234",
      "family-challenge-replacement",
      "family-contact-replacement",
      "family-accept-replacement",
      "family-decline-replacement",
      "family-contact-revoke-replacement",
      "family-owner-revoke-replacement",
    ]);
    await pairOwner(current);
    await pairFamilyContact(current);
    const oldBinding = current.service.resolveFamilyContactAlias("my son")!;
    await current.service.handleUpdate(messageUpdate({ updateId: 93, fromId: 202, chatId: 202, chatType: "private", text: "/disconnect" }));
    await pairFamilyContact(current, 303);
    const attempts = current.api.sendAttempts;
    const result = await current.service.deliverBoundFamilyNotification({
      requestId: "compound-old-pairing-0001",
      binding: oldBinding,
      document: familyNotificationDocument,
    });
    expect(result).toEqual({ status: "not_sent" });
    expect(current.api.sendAttempts).toBe(attempts);
    expect(current.api.messages.filter((message) => message.text === renderFamilyNotification(familyNotificationDocument))).toHaveLength(0);
  });

  it("revoked_contact_never_receives_old_approved_message", async () => {
    const current = setup("real", familyRandomValues);
    await pairOwner(current);
    await pairFamilyContact(current);
    const binding = current.service.resolveFamilyContactAlias("Gil")!;
    await current.service.handleUpdate(messageUpdate({ updateId: 94, fromId: 202, chatId: 202, chatType: "private", text: "/disconnect" }));
    const attempts = current.api.sendAttempts;
    expect(await current.service.deliverBoundFamilyNotification({
      requestId: "compound-revoked-0001",
      binding,
      document: familyNotificationDocument,
    })).toEqual({ status: "not_sent" });
    expect(current.api.sendAttempts).toBe(attempts);
  });

  it("changed_pairing_revision_never_receives_old_approved_message", async () => {
    const current = setup("real", familyRandomValues);
    await pairOwner(current);
    await pairFamilyContact(current);
    const binding = current.service.resolveFamilyContactAlias("Gil")!;
    const state = current.store.read();
    state.familyContact = {
      ...state.familyContact!,
      pairedAt: "2026-07-14T18:01:00.000Z",
    };
    current.store.write(state);
    const attempts = current.api.sendAttempts;
    expect(await current.service.deliverBoundFamilyNotification({
      requestId: "compound-old-revision-0001",
      binding,
      document: familyNotificationDocument,
    })).toEqual({ status: "not_sent" });
    expect(current.api.sendAttempts).toBe(attempts);
  });

  it("bound_delivery_request_rejects_changed_contact_on_replay", async () => {
    const current = setup("real", familyRandomValues);
    await pairOwner(current);
    await pairFamilyContact(current);
    const binding = current.service.resolveFamilyContactAlias("son")!;
    await current.service.deliverBoundFamilyNotification({ requestId: "compound-binding-0001", binding, document: familyNotificationDocument });
    await expect(current.service.deliverBoundFamilyNotification({
      requestId: "compound-binding-0001",
      binding: { ...binding, contactId: "different-contact" },
      document: familyNotificationDocument,
    })).rejects.toThrow("different content or contact");
  });
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
      message.text.includes("Gil is connected for approved appointment updates."),
    )).toBe(true);
    expect(current.api.messages.some((message) => message.text.includes(
      "Bander may send you a short appointment update only after the person who invited you approves its exact text.",
    ))).toBe(true);
    expect(current.api.messages.some((message) => message.text.includes(
      "Bander can send only the exact update shown on your approval Card.",
    ))).toBe(true);
    expect(JSON.stringify(current.api.messages.map((message) => message.replyMarkup))).toContain("OK, keep me posted");
    expect(current.api.messages.filter((message) =>
      message.text.startsWith("You’re connected as Gil.") ||
      message.text.startsWith("Gil is connected for approved appointment updates."),
    ).every((message) =>
      !message.text.includes("No notifications are enabled yet."),
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
        message.text.startsWith("Keep me posted as Gil?"),
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
    current.api.failNextMessageMatching = (text) => text.startsWith("Keep me posted as Gil?");

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
        message.text.startsWith("Keep me posted as Gil?"),
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
      "You cannot approve anything or see their calendar or conversations.",
    );
    expect(current.api.messages.at(-1)?.text).toContain(
      "Bander may send you a short appointment update only after the person who invited you approves its exact text.",
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
        message.text === "You’re disconnected. Bander can’t send you updates anymore.",
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

  it("fails closed on an unsupported persisted proposal failure classification", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bander-proposal-state-"));
    const statePath = path.join(root, "state.json");
    const store = new FileTelegramServiceStore(statePath);
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        proposals: [{
          installationId: "installation-id",
          ownerTelegramId: "101",
          chatId: "-500",
          messageId: 43,
          callbackValue: "bander:callback-value",
          declineCallbackValue: "bander-decline:callback-value",
          draftId: "draft-id",
          draftHash: "a".repeat(64),
          expiresAt: "2026-07-14T18:10:00.000Z",
          lifecycle: "conflict",
          terminalFailureCode: "invented_failure",
        }],
        standingCandidates: [],
        standingOutcomes: [],
        familyNotifications: [],
      }),
      { mode: 0o600 },
    );
    expect(() => store.read()).toThrow(
      "Unsupported Telegram proposal failure classification",
    );
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

    expect(approvalText).toContain("Your assistant says you asked:");
    expect(approvalText).toContain("If you say yes, Bander will check the latest information.");
    expect(approvalText).toContain("Bander won’t do anything else.");
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
        "I stopped — your calendar changed since you asked.",
        "Bander moved nothing.",
        "Ask your assistant to check again.",
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
        kind: "reschedule",
        eventId: "event-focus-block",
        expectedEtag: "event-focus-block-r1",
        newStartTime: "2026-07-17T13:00:00-06:00",
      },
    };
    const card = await current.engine.proposeFixture(
      crossDayFixture,
      "openclaw-reference",
    );

    await current.service.deliverProposal(card);

    expect(current.api.messages.at(-1)?.text).toContain(
      "from Wednesday, Jul 15, 9:30–10:30 AM (Mountain time)\nto Friday, Jul 17, 1:00–2:00 PM",
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
      "Wednesday, Jul 15, 9:30–10:30 AM (Mountain time) → Wednesday, Jul 15, 10:30–11:30 AM",
    );
    expect(outcome).toContain("Bander didn’t message anyone.");
    expect(outcome).toContain("Bander changed nothing else.");
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
      "Tuesday, Jul 14, 7:00–8:30 PM (Mountain time) → Tuesday, Jul 14, 7:30–9:00 PM",
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
      "Bander hasn’t done anything yet — please check:",
    );
  });
  it("uses parent-friendly pairing copy in Hero mode", async () => {
    const current = setup("hero");
    await pairOwner(current);
    expect(current.api.messages[0]?.text).toBe(
      "You’re the person who approves Bander’s limits.\nChoose the Telegram group where you use OpenClaw.",
    );
    expect(current.api.messages.some((message) => message.text ===
      "Bander is ready.\nI only act here, and only within limits you approve.",
    )).toBe(true);
    expect(current.api.messages.filter((message) => message.text.startsWith("I’m Bander."))).toHaveLength(1);
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
      draftId: card.draftId,
      lifecycle: "pending",
    });
    expect(binding.callbackValue).toContain("opaque-callback");

    for (const [id, fromId, chatId, messageId, data] of [
      ["non-owner", 202, -500, binding.messageId, binding.callbackValue],
      ["wrong-chat", 101, -501, binding.messageId, binding.callbackValue],
      ["wrong-message", 101, -500, 99, binding.callbackValue],
      ["imitation", 101, -500, binding.messageId, "openclaw:imitation"],
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
        message: { message_id: binding.messageId, chat: { id: -500, type: "supergroup" } },
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
      "Bander did nothing.\nAsk your assistant again if you want something different.",
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
        "Bander did nothing.\nAsk your assistant again if you want something different."),
    ).toHaveLength(1);
  });

  it("telegram_copy_contains_no_engine_vocabulary_and_uses_human_local_times", async () => {
    const current = setup();
    await pairOwner(current);
    const card = await current.engine.proposeFixture(fixture, "openclaw-reference");
    await current.service.deliverProposal(card);
    const binding = current.store.read().proposals[0]!;
    const approvalText = current.api.messages.at(-1)!.text;

    expect(approvalText).toContain("Bander hasn’t done anything yet — please check:");
    expect(approvalText).toContain("Your assistant says you asked:");
    expect(approvalText).toContain("from Tuesday, Jul 14, 7:00–8:30 PM (Mountain time)\nto Tuesday, Jul 14, 7:30–9:00 PM");
    expect(approvalText).toContain("This closes in 10 minutes.");
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
      "Tuesday, Jul 14, 7:00–8:30 PM (Mountain time) → Tuesday, Jul 14, 7:30–9:00 PM",
    );
    expect(outcomeText).toContain("Bander changed nothing else.");
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
    expect(text.match(/\nIf you say yes, Bander will check the latest information\. If it still matches, Bander will:\n/g)).toHaveLength(1);
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
      "That request expired. Bander did nothing.\nAsk your assistant to prepare it again."),
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

  it("google_may_have_committed_never_says_nothing_changed", async () => {
    const current = await ambiguousProposal(true);
    await current.service.handleUpdate(current.callback);
    const humanOutcome = current.api.messages.at(-1)?.text ?? "";
    expect(humanOutcome).toContain("Bander couldn’t confirm whether your calendar changed.");
    expect(humanOutcome).not.toMatch(
      /nothing changed|I didn’t act|stopped safely|already stopped/i,
    );
  });

  it("ambiguous_compound_outcome_says_no_family_update_was_sent", async () => {
    const current = await ambiguousProposal(true);
    await current.service.handleUpdate(current.callback);
    expect(current.api.messages.at(-1)?.text).toBe([
      "Bander couldn’t confirm whether your calendar changed.",
      "Bander sent no family update.",
      "Bander won’t try this request again automatically.",
      "Please check your calendar before asking your assistant again.",
    ].join("\n"));
    expect(current.store.read().familyNotifications).toHaveLength(0);
  });

  it("ambiguous_calendar_only_outcome_omits_family_copy", async () => {
    const current = await ambiguousProposal(false);
    await current.service.handleUpdate(current.callback);
    const humanOutcome = current.api.messages.at(-1)?.text ?? "";
    expect(humanOutcome).toBe([
      "Bander couldn’t confirm whether your calendar changed.",
      "Bander won’t try this request again automatically.",
      "Please check your calendar before asking your assistant again.",
    ].join("\n"));
    expect(humanOutcome).not.toMatch(/family update/i);
  });

  it("ambiguous_callback_toast_is_truthful", async () => {
    const current = await ambiguousProposal(true);
    await current.service.handleUpdate(current.callback);
    expect(current.api.callbackAnswers.at(-1)?.text).toBe(
      "Calendar result unconfirmed. No family update was sent.",
    );
  });

  it("ambiguous_callback_replay_executes_nothing", async () => {
    const current = await ambiguousProposal(true);
    await current.service.handleUpdate(current.callback);
    await current.service.handleUpdate({
      ...current.callback,
      update_id: 502,
      callback_query: {
        ...current.callback.callback_query,
        id: "ambiguous-owner-replay",
      },
    });
    expect(current.adapter.executions).toBe(1);
    expect(current.store.read().familyNotifications).toHaveLength(0);
    expect(current.api.messages.filter((message) =>
      message.text.startsWith("Bander couldn’t confirm whether your calendar changed."),
    )).toHaveLength(1);
  });

  it("ambiguous_callback_replay_preserves_terminal_classification", async () => {
    const current = await ambiguousProposal(true);
    await current.service.handleUpdate(current.callback);
    await current.service.handleUpdate({
      ...current.callback,
      update_id: 503,
      callback_query: {
        ...current.callback.callback_query,
        id: "ambiguous-owner-replay-classification",
      },
    });
    expect(current.store.read().proposals.at(-1)).toMatchObject({
      lifecycle: "conflict",
      terminalFailureCode: "calendar_outcome_ambiguous",
    });
    expect(current.api.callbackAnswers.at(-1)?.text).toBe(
      "Calendar result unconfirmed. No family update was sent.",
    );
  });

  it("email_thread_change_and_ambiguous_send_have_truthful_terminal_replay", async () => {
    for (const mode of ["conflict", "ambiguous"] as const) {
      const current = setup("real");
      await pairOwner(current);
      const card = await current.engine.proposeFixture(emailFixture, "openclaw-reference");
      await current.service.deliverProposal(card);
      const binding = current.store.read().proposals.at(-1)!;
      if (mode === "conflict") {
        current.adapter.conflict = true;
        current.adapter.conflictKind = "email";
      } else {
        current.adapter.ambiguous = true;
        current.adapter.ambiguousKind = "email";
      }
      const callback: TelegramUpdate = { update_id: 600, callback_query: { id: `email-${mode}`, from: { id: 101, is_bot: false }, data: binding.callbackValue, message: { message_id: binding.messageId, chat: { id: -500, type: "supergroup" } } } };
      await current.service.handleUpdate(callback);
      await current.service.handleUpdate({ ...callback, update_id: 601, callback_query: { ...callback.callback_query!, id: `email-${mode}-replay` } });
      const state = current.store.read().proposals.at(-1)!;
      expect(state.terminalFailureCode).toBe(mode === "conflict" ? "email_thread_changed" : "email_outcome_ambiguous");
      expect(current.adapter.executions).toBe(1);
      const outcome = current.api.messages.find((message) => message.text.includes(mode === "conflict" ? "email conversation changed" : "couldn’t confirm whether the approved email reply was sent"));
      expect(outcome).toBeDefined();
      if (mode === "conflict") {
        expect(outcome?.text).toContain("since this reply was prepared");
        expect(outcome?.text).not.toContain("since you approved");
      }
      expect(current.api.messages.filter((message) => message.text === outcome?.text)).toHaveLength(1);
    }
  });

  it("ordinary_etag_conflict_still_says_nothing_was_changed_or_sent", async () => {
    const current = await ambiguousProposal(true);
    current.adapter.ambiguous = false;
    current.adapter.conflict = true;
    await current.service.handleUpdate(current.callback);
    expect(current.api.messages.at(-1)?.text).toBe([
      "I stopped — your calendar changed since you asked.",
      "Bander moved nothing and sent nothing.",
      "Ask your assistant to check again.",
    ].join("\n"));
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
      "Wednesday, Jul 15, 9:30–10:30 AM (Mountain time) → Wednesday, Jul 15, 10:30–11:30 AM",
    );
    expect(messages[0]?.text).toContain("Bander didn’t message anyone.");
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
        message.text.startsWith("Bander hasn’t done anything yet — please check:"),
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
