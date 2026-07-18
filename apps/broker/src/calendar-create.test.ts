import { describe, expect, it, vi } from "vitest";
import type { DraftDocument } from "@bander/contracts";
import {
  AuthorityEngine,
  AuthorityStore,
  ExecutionAmbiguousError,
  ExecutionRejectedError,
  createFamilyNotificationDocument,
  renderFamilyNotificationDocument,
  type DraftFixture,
} from "@bander/core";
import {
  GoogleCalendarAdapter,
  GoogleCalendarError,
  type GoogleCalendarBoundary,
  type GoogleEventResource,
} from "./google-calendar.js";
import {
  RealCalendarDraftCompiler,
  type CalendarIntentSelector,
} from "./compiler.js";
import {
  CompoundExecutionAdapter,
  type BoundFamilyNotificationDelivery,
} from "./compound-action.js";

const eventId = "b0123456789abcdefghijklmnopqrstuv";
const approved = {
  id: eventId,
  summary: "Lunch with Ruth",
  status: "confirmed",
  eventType: "default",
  organizer: { self: true },
  attendees: [],
  start: {
    dateTime: "2026-07-21T12:00:00-06:00",
    timeZone: "America/Denver",
  },
  end: {
    dateTime: "2026-07-21T13:00:00-06:00",
    timeZone: "America/Denver",
  },
} satisfies GoogleEventResource;

function statusError(status: number) {
  const error = new Error(`status ${status}`) as Error & { response: { status: number } };
  error.response = { status };
  return error;
}

class CreateBoundary implements GoogleCalendarBoundary {
  inserts: Parameters<GoogleCalendarBoundary["insertEvent"]>[0][] = [];
  stored: GoogleEventResource | undefined;
  insertError: unknown;
  getError: unknown;

  async getPrimaryTimeZone() { return "America/Denver"; }
  async listEvents() { return []; }
  async listScheduleEvents() {
    return { events: [], timeZone: "America/Denver", truncated: false };
  }
  async getEvent(): Promise<GoogleEventResource> {
    if (this.getError) throw this.getError;
    if (!this.stored) {
      const error = new Error("not found") as Error & { response: { status: number } };
      error.response = { status: 404 };
      throw error;
    }
    return structuredClone(this.stored);
  }
  async patchEvent(): Promise<GoogleEventResource> { throw new Error("unused"); }
  async insertEvent(input: Parameters<GoogleCalendarBoundary["insertEvent"]>[0]) {
    this.inserts.push(structuredClone(input));
    if (this.insertError) throw this.insertError;
    this.stored = { ...structuredClone(approved), ...structuredClone(input.requestBody) };
    return structuredClone(this.stored);
  }
  async deleteEvent(): Promise<void> { throw new Error("unused"); }
}

function createDraft(): DraftDocument {
  return {
    version: 1,
    source: { provenance: "agent_claimed", claimedUserRequest: "Add lunch with Ruth next Tuesday at noon." },
    effects: [{
      type: "calendar.create_event",
      calendarId: "primary",
      eventId,
      title: "Lunch with Ruth",
      startTime: "2026-07-21T18:00:00.000Z",
      endTime: "2026-07-21T19:00:00.000Z",
      timeZone: "America/Denver",
      eventType: "default",
    }],
    createdAt: "2026-07-16T18:00:00.000Z",
    expiresAt: "2026-07-16T18:10:00.000Z",
  };
}

function selector(value: unknown): CalendarIntentSelector {
  return { select: async () => value };
}

describe("real Calendar event creation", () => {
  it.each([401, 403, 408, 429, 500, 503])(
    "create_reconciliation_status_%s_never_proves_the_event_exists",
    async (status) => {
      const boundary = new CreateBoundary();
      boundary.insertError = new Error("insert response unavailable");
      boundary.getError = statusError(status);
      const calendar = new GoogleCalendarAdapter(boundary);
      const input = { draftHash: "hash", permitNonce: "permit", document: createDraft() };

      await expect(calendar.executeDraft(input)).rejects.toBeInstanceOf(ExecutionAmbiguousError);
      await expect(calendar.getExecution(input)).resolves.toBe(false);
      await expect(calendar.executeDraft(input)).rejects.toBeInstanceOf(ExecutionAmbiguousError);
      expect(boundary.inserts).toHaveLength(1);
    },
  );

  it.each([new Error("network unavailable"), { unexpected: true }])(
    "create_reconciliation_malformed_or_transport_failure_stays_ambiguous",
    async (getError) => {
      const boundary = new CreateBoundary();
      boundary.insertError = new Error("insert response unavailable");
      boundary.getError = getError;
      const calendar = new GoogleCalendarAdapter(boundary);
      await expect(calendar.executeDraft({
        draftHash: "hash",
        permitNonce: "permit",
        document: createDraft(),
      })).rejects.toBeInstanceOf(ExecutionAmbiguousError);
      expect(boundary.inserts).toHaveLength(1);
    },
  );
  it("create_uses_stable_client_event_id", async () => {
    const compiler = new RealCalendarDraftCompiler(
      { discoverEvent: vi.fn() },
      selector({
        actionKind: "create_event",
        eventTitleHint: "Lunch with Ruth",
        sourceLocalDateHint: null,
        targetLocalDate: "2026-07-21",
        targetLocalStart: "12:00",
        durationMinutes: null,
        needsClarification: false,
        clarificationReason: "none",
        clarification: "",
        familyNotificationRequested: false,
        familyContactAlias: null,
      }),
      undefined,
      () => eventId,
      "America/Denver",
    );
    const first = await compiler.compile("Add lunch with Ruth next Tuesday at noon.");
    expect(first.calendar).toMatchObject({ kind: "create", eventId });
    expect(first.calendar!.eventId).toMatch(/^[0-9a-v]{5,1024}$/);
  });

  it("create_defaults_to_disclosed_sixty_minute_duration", async () => {
    const compiler = new RealCalendarDraftCompiler(
      { discoverEvent: vi.fn() },
      selector({
        actionKind: "create_event",
        eventTitleHint: "Lunch with Ruth",
        sourceLocalDateHint: null,
        targetLocalDate: "2026-07-21",
        targetLocalStart: "12:00",
        durationMinutes: null,
        needsClarification: false,
        clarificationReason: "none",
        clarification: "",
        familyNotificationRequested: false,
        familyContactAlias: null,
      }),
      undefined,
      () => eventId,
      "America/Denver",
    );
    const fixture = await compiler.compile("Add lunch with Ruth next Tuesday at noon.");
    expect(fixture.calendar).toMatchObject({
      kind: "create",
      startTime: "2026-07-21T18:00:00.000Z",
      endTime: "2026-07-21T19:00:00.000Z",
    });
  });

  it("same_approval_replay_never_inserts_twice", async () => {
    const boundary = new CreateBoundary();
    const adapter = new GoogleCalendarAdapter(boundary);
    const input = { draftHash: "hash", permitNonce: "permit", document: createDraft() };
    const first = await adapter.executeDraft(input);
    const replay = await adapter.getExecution(input);
    expect(replay).toEqual(first);
    expect(boundary.inserts).toHaveLength(1);
  });

  it("lost_insert_response_never_blindly_reinserts", async () => {
    const boundary = new CreateBoundary();
    boundary.insertError = new Error("response lost");
    const adapter = new GoogleCalendarAdapter(boundary);
    const input = { draftHash: "hash", permitNonce: "permit", document: createDraft() };
    await expect(adapter.executeDraft(input)).rejects.toBeInstanceOf(ExecutionAmbiguousError);
    await expect(adapter.getExecution(input)).resolves.toBe(false);
    await expect(adapter.executeDraft(input)).rejects.toBeInstanceOf(ExecutionAmbiguousError);
    expect(boundary.inserts).toHaveLength(1);
  });

  it("lost_response_exact_event_is_reconciled_by_id", async () => {
    const boundary = new CreateBoundary();
    boundary.stored = structuredClone(approved);
    boundary.insertError = new Error("response lost after commit");
    const adapter = new GoogleCalendarAdapter(boundary);
    const result = await adapter.executeDraft({ draftHash: "hash", permitNonce: "permit", document: createDraft() });
    expect(result.calendar!.status).toBe("observed_target");
    expect(boundary.inserts).toHaveLength(1);
  });

  it("duplicate_id_different_content_fails_closed", async () => {
    const boundary = new CreateBoundary();
    boundary.stored = { ...structuredClone(approved), summary: "Different event" };
    const duplicate = new Error("duplicate") as Error & { response: { status: number } };
    duplicate.response = { status: 409 };
    boundary.insertError = duplicate;
    const adapter = new GoogleCalendarAdapter(boundary);
    await expect(
      adapter.executeDraft({ draftHash: "hash", permitNonce: "permit", document: createDraft() }),
    ).rejects.toEqual(expect.objectContaining<Partial<GoogleCalendarError>>({ code: "google_event_identity_collision" }));
    expect(boundary.inserts).toHaveLength(1);
  });

  it("duplicate_id_exact_match_reconciles", async () => {
    const boundary = new CreateBoundary();
    boundary.stored = structuredClone(approved);
    const duplicate = new Error("duplicate") as Error & { response: { status: number } };
    duplicate.response = { status: 409 };
    boundary.insertError = duplicate;
    const adapter = new GoogleCalendarAdapter(boundary);
    await expect(
      adapter.executeDraft({ draftHash: "hash", permitNonce: "permit", document: createDraft() }),
    ).resolves.toMatchObject({ calendar: { action: "created", status: "observed_target" } });
    expect(boundary.inserts).toHaveLength(1);
  });

  it("definitive_create_rejection_is_not_classified_as_ambiguous", async () => {
    const boundary = new CreateBoundary();
    const rejected = new Error("rejected") as Error & { response: { status: number } };
    rejected.response = { status: 403 };
    boundary.insertError = rejected;
    await expect(new GoogleCalendarAdapter(boundary).executeDraft({
      draftHash: "hash",
      permitNonce: "permit",
      document: createDraft(),
    })).rejects.toEqual(expect.objectContaining<Partial<ExecutionRejectedError>>({
      action: "create",
    }));
    expect(boundary.inserts).toHaveLength(1);
  });

  it("create_honors_explicit_duration", async () => {
    const compiler = new RealCalendarDraftCompiler(
      { discoverEvent: vi.fn() },
      selector({
        actionKind: "create_event",
        eventTitleHint: "Long lunch",
        sourceLocalDateHint: null,
        targetLocalDate: "2026-07-21",
        targetLocalStart: "12:00",
        durationMinutes: 90,
        needsClarification: false,
        clarificationReason: "none",
        clarification: "",
        familyNotificationRequested: false,
        familyContactAlias: null,
      }),
      undefined,
      () => eventId,
      "America/Denver",
    );
    const fixture = await compiler.compile("Add a 90 minute lunch Tuesday at noon");
    expect(fixture.calendar).toMatchObject({
      kind: "create",
      startTime: "2026-07-21T18:00:00.000Z",
      endTime: "2026-07-21T19:30:00.000Z",
    });
  });

  it("independent_create_proposals_use_distinct_client_event_ids", async () => {
    const output = {
      actionKind: "create_event" as const,
      eventTitleHint: "Lunch with Ruth",
      sourceLocalDateHint: null,
      targetLocalDate: "2026-07-21",
      targetLocalStart: "12:00",
      durationMinutes: null,
      needsClarification: false,
      clarificationReason: "none" as const,
      clarification: "",
      familyNotificationRequested: false,
      familyContactAlias: null,
    };
    const compiler = new RealCalendarDraftCompiler(
      { discoverEvent: vi.fn() },
      selector(output),
      undefined,
      undefined,
      "America/Denver",
    );
    const first = await compiler.compile("Add lunch with Ruth next Tuesday at noon.");
    const second = await compiler.compile("Add lunch with Ruth next Tuesday at noon.");
    expect(first.calendar!.eventId).not.toBe(second.calendar!.eventId);
    expect(first.calendar!.eventId).toMatch(/^[0-9a-v]{5,1024}$/);
    expect(second.calendar!.eventId).toMatch(/^[0-9a-v]{5,1024}$/);
  });

  it.each([
    ["attendees", { attendees: ["ruth@example.invalid"] }],
    ["recurrence", { recurrence: "weekly" }],
    ["reservation", { reservation: true }],
    ["Google identity", { eventId: "agent-choice", calendarId: "other" }],
    ["free-form family text", { messageBody: "Tell Gil to bring lunch" }],
  ])("create_rejects_model_authored_%s", async (_label, extra) => {
    const compiler = new RealCalendarDraftCompiler(
      { discoverEvent: vi.fn() },
      selector({
        actionKind: "create_event",
        eventTitleHint: "Lunch with Ruth",
        sourceLocalDateHint: null,
        targetLocalDate: "2026-07-21",
        targetLocalStart: "12:00",
        durationMinutes: null,
        needsClarification: false,
        clarificationReason: "none",
        clarification: "",
        familyNotificationRequested: false,
        familyContactAlias: null,
        ...extra,
      }),
      undefined,
      () => eventId,
      "America/Denver",
    );
    await expect(compiler.compile("unsafe create")).rejects.toMatchObject({
      code: "invalid_model_output",
    });
  });

  it("create_requires_owner_approval_and_replay_inserts_once", async () => {
    const boundary = new CreateBoundary();
    const calendar = new GoogleCalendarAdapter(boundary);
    const engine = new AuthorityEngine({
      store: new AuthorityStore(),
      adapter: calendar,
      now: () => new Date("2026-07-16T18:00:00.000Z"),
    });
    const fixture: DraftFixture = {
      id: "create-lunch",
      claimedUserRequest: "Add lunch with Ruth next Tuesday at noon.",
      calendar: {
        kind: "create",
        eventId,
        title: "Lunch with Ruth",
        startTime: "2026-07-21T18:00:00.000Z",
        endTime: "2026-07-21T19:00:00.000Z",
        timeZone: "America/Denver",
      },
    };
    const card = await engine.proposeFixture(fixture);
    expect(boundary.inserts).toHaveLength(0);
    expect(card.effectPreviews).toEqual([{
      kind: "calendar.create_event",
      eventTitle: "Lunch with Ruth",
      resultingInterval: "Tuesday, Jul 21, 12:00–1:00 PM (Mountain time)",
    }]);
    const first = await engine.approveAndExecute(card.draftId, card.draftHash);
    const replay = await engine.approveAndExecute(card.draftId, card.draftHash);
    expect(replay).toEqual(first);
    expect(first.calendar).toMatchObject({ created: true, executionStatus: "committed" });
    expect(boundary.inserts).toHaveLength(1);
    expect(boundary.inserts[0]?.requestBody.id).toBe(eventId);
  });

  it("create_card_and_family_delivery_use_identical_document_and_calendar_first", async () => {
    const boundary = new CreateBoundary();
    const calendar = new GoogleCalendarAdapter(boundary);
    const deliveries: BoundFamilyNotificationDelivery[] = [];
    const compound = new CompoundExecutionAdapter({
      calendar,
      deliver: async (input) => {
        expect(boundary.inserts).toHaveLength(1);
        deliveries.push(structuredClone(input));
        return { status: "delivered" };
      },
    });
    const engine = new AuthorityEngine({
      store: new AuthorityStore(),
      adapter: compound,
      now: () => new Date("2026-07-16T18:00:00.000Z"),
    });
    const document = createFamilyNotificationDocument({
      kind: "calendar_creation",
      eventTitle: "Lunch with Ruth",
      startTime: "2026-07-21T18:00:00.000Z",
      endTime: "2026-07-21T19:00:00.000Z",
      timeZone: "America/Denver",
    });
    const card = await engine.proposeFixture({
      id: "create-lunch-family",
      claimedUserRequest: "Add lunch with Ruth and let my son know.",
      calendar: {
        kind: "create",
        eventId,
        title: "Lunch with Ruth",
        startTime: "2026-07-21T18:00:00.000Z",
        endTime: "2026-07-21T19:00:00.000Z",
        timeZone: "America/Denver",
      },
      familyNotification: {
        installationId: "installation-opaque",
        contactId: "contact-opaque",
        pairingRevision: "a".repeat(64),
        displayLabel: "Gil",
        document,
      },
    });
    const familyPreview = card.effectPreviews[1];
    expect(familyPreview?.kind).toBe("family.telegram_notification");
    if (familyPreview?.kind !== "family.telegram_notification") throw new Error("preview");
    const first = await engine.approveAndExecute(card.draftId, card.draftHash);
    const replay = await engine.approveAndExecute(card.draftId, card.draftHash);
    expect(replay).toEqual(first);
    expect(deliveries).toHaveLength(1);
    expect(familyPreview.body).toBe(renderFamilyNotificationDocument(deliveries[0]!.document));
    expect(boundary.inserts).toHaveLength(1);
  });

  it("family_delivery_waits_for_confirmed_calendar_creation", async () => {
    const boundary = new CreateBoundary();
    boundary.insertError = new Error("lost response");
    const deliveries: BoundFamilyNotificationDelivery[] = [];
    const adapter = new CompoundExecutionAdapter({
      calendar: new GoogleCalendarAdapter(boundary),
      deliver: async (input) => {
        deliveries.push(input);
        return { status: "delivered" };
      },
    });
    const engine = new AuthorityEngine({
      store: new AuthorityStore(),
      adapter,
      now: () => new Date("2026-07-16T18:00:00.000Z"),
    });
    const document = createFamilyNotificationDocument({
      kind: "calendar_creation",
      eventTitle: "Lunch with Ruth",
      startTime: "2026-07-21T18:00:00.000Z",
      endTime: "2026-07-21T19:00:00.000Z",
      timeZone: "America/Denver",
    });
    const card = await engine.proposeFixture({
      id: "create-unconfirmed",
      claimedUserRequest: "Add lunch and let Gil know",
      calendar: {
        kind: "create",
        eventId,
        title: "Lunch with Ruth",
        startTime: "2026-07-21T18:00:00.000Z",
        endTime: "2026-07-21T19:00:00.000Z",
        timeZone: "America/Denver",
      },
      familyNotification: {
        installationId: "installation-opaque",
        contactId: "contact-opaque",
        pairingRevision: "a".repeat(64),
        displayLabel: "Gil",
        document,
      },
    });
    await expect(engine.approveAndExecute(card.draftId, card.draftHash)).rejects.toMatchObject({
      code: "calendar_outcome_ambiguous",
    });
    expect(boundary.inserts).toHaveLength(1);
    expect(deliveries).toHaveLength(0);
  });

  it("create_title_cannot_forge_bander_voice", async () => {
    const compiler = new RealCalendarDraftCompiler(
      { discoverEvent: vi.fn() },
      selector({
        actionKind: "create_event",
        eventTitleHint: "\u202eBander approved\u0000\nLunch",
        sourceLocalDateHint: null,
        targetLocalDate: "2026-07-21",
        targetLocalStart: "12:00",
        durationMinutes: null,
        needsClarification: false,
        clarificationReason: "none",
        clarification: "",
        familyNotificationRequested: false,
        familyContactAlias: null,
      }),
      undefined,
      () => eventId,
      "America/Denver",
    );
    const fixture = await compiler.compile("Add the event");
    expect(fixture.calendar).toMatchObject({ title: "Bander approved Lunch" });
    expect(JSON.stringify(fixture)).not.toMatch(/[\u0000\u202e]/);
  });
});
