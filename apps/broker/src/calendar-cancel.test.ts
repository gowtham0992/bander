import { describe, expect, it, vi } from "vitest";
import type { DraftDocument } from "@bander/contracts";
import {
  AuthorityEngine,
  AuthorityStore,
  ExecutionAmbiguousError,
  ExecutionAlreadyAbsentError,
  ExecutionConflictError,
  createFamilyNotificationDocument,
  digestStandingRequest,
  renderFamilyNotificationDocument,
  type DraftFixture,
} from "@bander/core";
import {
  GoogleCalendarAdapter,
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

const eligible: GoogleEventResource = {
  id: "dentist-event",
  etag: '"dentist-v1"',
  summary: "Dentist appointment",
  status: "confirmed",
  eventType: "default",
  organizer: { self: true },
  attendees: [],
  start: { dateTime: "2026-07-23T13:00:00-06:00", timeZone: "America/Denver" },
  end: { dateTime: "2026-07-23T14:00:00-06:00", timeZone: "America/Denver" },
};

class CancelBoundary {
  events = [structuredClone(eligible)];
  deletes: Array<{
    calendarId: "primary";
    eventId: string;
    ifMatch: string;
    sendUpdates: "none";
  }> = [];
  inserts = 0;
  deleteError: unknown;
  getError: unknown;

  async getPrimaryTimeZone() { return "America/Denver"; }
  async listEvents() { return structuredClone(this.events); }
  async listScheduleEvents() {
    return { events: structuredClone(this.events), timeZone: "America/Denver", truncated: false };
  }
  async getEvent() {
    if (this.getError) throw this.getError;
    const event = this.events[0];
    if (!event) throw statusError(404);
    return structuredClone(event);
  }
  async patchEvent() { throw new Error("unused"); }
  async insertEvent() { this.inserts += 1; throw new Error("cancel must never recreate"); }
  async deleteEvent(input: {
    calendarId: "primary";
    eventId: string;
    ifMatch: string;
    sendUpdates: "none";
  }) {
    this.deletes.push(structuredClone(input));
    if (this.deleteError) throw this.deleteError;
    this.events = [];
  }
}

function statusError(status: number) {
  const error = new Error(`status ${status}`) as Error & { response: { status: number } };
  error.response = { status };
  return error;
}

function selector(value: unknown): CalendarIntentSelector {
  return { select: async () => value };
}

function cancelIntent(extra: Record<string, unknown> = {}) {
  return {
    actionKind: "cancel_event",
    eventTitleHint: "Dentist appointment",
    sourceLocalDateHint: "2026-07-23",
    targetLocalDate: "",
    targetLocalStart: "",
    durationMinutes: null,
    needsClarification: false,
    clarificationReason: "none",
    clarification: "",
    familyNotificationRequested: false,
    familyContactAlias: null,
    ...extra,
  };
}

function cancelFixture(): DraftFixture {
  return {
    id: "cancel-dentist",
    claimedUserRequest: "Cancel my dentist appointment on Thursday.",
    calendar: {
      kind: "cancel",
      eventId: "dentist-event",
      expectedEtag: '"dentist-v1"',
    },
  } as unknown as DraftFixture;
}

function cancelDraft(): DraftDocument {
  return {
    version: 1,
    source: {
      provenance: "agent_claimed",
      claimedUserRequest: "Cancel my dentist appointment on Thursday.",
    },
    effects: [{
      type: "calendar.cancel_event",
      calendarId: "primary",
      eventId: "dentist-event",
      expected: {
        etag: '"dentist-v1"',
        title: "Dentist appointment",
        startTime: "2026-07-23T13:00:00-06:00",
        endTime: "2026-07-23T14:00:00-06:00",
        timeZone: "America/Denver",
        eventType: "default",
        organizerMustBeOwner: true,
        attendeeIdsExactly: [],
        recurring: false,
      },
    }],
    createdAt: "2026-07-16T18:00:00.000Z",
    expiresAt: "2026-07-16T18:10:00.000Z",
  } as unknown as DraftDocument;
}

function adapter(boundary: CancelBoundary) {
  return new GoogleCalendarAdapter(boundary as unknown as GoogleCalendarBoundary);
}

describe("real Calendar cancellation", () => {
  it.each([401, 403, 408, 429, 500, 503])(
    "cancel_reconciliation_status_%s_never_proves_absence",
    async (status) => {
      const boundary = new CancelBoundary();
      boundary.deleteError = new Error("delete response unavailable");
      boundary.getError = statusError(status);
      const calendar = adapter(boundary);
      const input = {
        draftHash: "cancel-hash",
        permitNonce: "cancel-permit",
        document: cancelDraft(),
      };

      await expect(calendar.executeDraft(input)).rejects.toBeInstanceOf(ExecutionAmbiguousError);
      await expect(calendar.getExecution(input)).resolves.toBe(false);
      await expect(calendar.executeDraft(input)).rejects.toBeInstanceOf(ExecutionAmbiguousError);
      expect(boundary.deletes).toHaveLength(1);
      expect(boundary.inserts).toBe(0);
    },
  );

  it.each([new Error("network unavailable"), { unexpected: true }])(
    "cancel_reconciliation_malformed_or_transport_failure_stays_ambiguous",
    async (getError) => {
      const boundary = new CancelBoundary();
      boundary.deleteError = new Error("delete response unavailable");
      boundary.getError = getError;
      await expect(adapter(boundary).executeDraft({
        draftHash: "cancel-hash",
        permitNonce: "cancel-permit",
        document: cancelDraft(),
      })).rejects.toBeInstanceOf(ExecutionAmbiguousError);
      expect(boundary.deletes).toHaveLength(1);
      expect(boundary.inserts).toBe(0);
    },
  );
  it("cancel_requires_owner_approval", async () => {
    const boundary = new CancelBoundary();
    const engine = new AuthorityEngine({
      store: new AuthorityStore(),
      adapter: adapter(boundary),
      now: () => new Date("2026-07-16T18:00:00.000Z"),
    });
    const card = await engine.proposeFixture(cancelFixture());
    expect(boundary.deletes).toHaveLength(0);
    expect(card.effectPreviews).toEqual([{
      kind: "calendar.cancel_event",
      eventTitle: "Dentist appointment",
      previousInterval: "Thursday, Jul 23, 1:00–2:00 PM (Mountain time)",
    }]);
    await engine.approveAndExecute(card.draftId, card.draftHash);
    expect(boundary.deletes).toHaveLength(1);
  });

  it("cancel_commits_event_id_and_etag", async () => {
    const compiler = new RealCalendarDraftCompiler(
      adapter(new CancelBoundary()),
      selector(cancelIntent()),
      undefined,
      undefined,
      "America/Denver",
    );
    await expect(
      compiler.compile("Cancel my dentist appointment on Thursday."),
    ).resolves.toMatchObject({
      calendar: {
        kind: "cancel",
        eventId: "dentist-event",
        expectedEtag: '"dentist-v1"',
      },
    });
  });

  it("cancel_uses_if_match_and_send_updates_none", async () => {
    const boundary = new CancelBoundary();
    await adapter(boundary).executeDraft({
      draftHash: "cancel-hash",
      permitNonce: "cancel-permit",
      document: cancelDraft(),
    });
    expect(boundary.deletes).toEqual([{
      calendarId: "primary",
      eventId: "dentist-event",
      ifMatch: '"dentist-v1"',
      sendUpdates: "none",
    }]);
    expect(boundary.inserts).toBe(0);
  });

  it("stale_etag_cancels_nothing_and_sends_no_family_update", async () => {
    const boundary = new CancelBoundary();
    boundary.deleteError = statusError(412);
    const deliveries: BoundFamilyNotificationDelivery[] = [];
    const compound = new CompoundExecutionAdapter({
      calendar: adapter(boundary),
      deliver: async (input) => {
        deliveries.push(input);
        return { status: "delivered" };
      },
    });
    const draft = cancelDraft();
    draft.effects.push({
      type: "family.telegram_notification",
      binding: {
        installationId: "installation-opaque",
        contactId: "contact-opaque",
        pairingRevision: "a".repeat(64),
        displayLabel: "Gil",
      },
      document: createFamilyNotificationDocument({
        kind: "calendar_cancellation",
        eventTitle: "Dentist appointment",
        startTime: "2026-07-23T19:00:00.000Z",
        endTime: "2026-07-23T20:00:00.000Z",
        timeZone: "America/Denver",
      }),
    });
    await expect(compound.executeDraft({
      draftHash: "cancel-hash",
      permitNonce: "cancel-permit",
      document: draft,
    })).rejects.toBeInstanceOf(ExecutionConflictError);
    expect(boundary.deletes).toHaveLength(1);
    expect(deliveries).toHaveLength(0);
  });

  it("already_absent_is_not_reported_as_bander_success", async () => {
    const boundary = new CancelBoundary();
    boundary.deleteError = statusError(404);
    await expect(adapter(boundary).executeDraft({
      draftHash: "cancel-hash",
      permitNonce: "cancel-permit",
      document: cancelDraft(),
    })).rejects.toBeInstanceOf(ExecutionAlreadyAbsentError);
    expect(boundary.deletes).toHaveLength(1);
  });

  it("lost_delete_response_never_reissues_delete", async () => {
    const boundary = new CancelBoundary();
    boundary.deleteError = new Error("response lost");
    const calendar = adapter(boundary);
    await expect(calendar.executeDraft({
      draftHash: "cancel-hash",
      permitNonce: "cancel-permit",
      document: cancelDraft(),
    })).rejects.toBeInstanceOf(ExecutionAmbiguousError);
    await expect(calendar.executeDraft({
      draftHash: "cancel-hash",
      permitNonce: "cancel-permit",
      document: cancelDraft(),
    })).rejects.toBeInstanceOf(ExecutionAmbiguousError);
    expect(boundary.deletes).toHaveLength(1);
    expect(boundary.inserts).toBe(0);
  });

  it("lost_response_cancelled_tombstone_is_observed_safely", async () => {
    const boundary = new CancelBoundary();
    boundary.deleteError = new Error("response lost");
    boundary.events = [{ id: "dentist-event", status: "cancelled" }];
    await expect(adapter(boundary).executeDraft({
      draftHash: "cancel-hash",
      permitNonce: "cancel-permit",
      document: cancelDraft(),
    })).resolves.toMatchObject({ calendar: { action: "removed", status: "observed_target" } });
    expect(boundary.deletes).toHaveLength(1);
    expect(boundary.inserts).toBe(0);
  });

  it("lost_response_absent_event_is_observed_safely", async () => {
    const boundary = new CancelBoundary();
    boundary.deleteError = new Error("response lost");
    boundary.events = [];
    await expect(adapter(boundary).executeDraft({
      draftHash: "cancel-hash",
      permitNonce: "cancel-permit",
      document: cancelDraft(),
    })).resolves.toMatchObject({ calendar: { action: "removed", status: "observed_target" } });
    expect(boundary.deletes).toHaveLength(1);
    expect(boundary.inserts).toBe(0);
  });

  it("observed_absence_never_claims_bander_removed_it", async () => {
    const boundary = new CancelBoundary();
    boundary.deleteError = new Error("response lost after delete");
    const engine = new AuthorityEngine({
      store: new AuthorityStore(),
      adapter: adapter(boundary),
      now: () => new Date("2026-07-16T18:00:00.000Z"),
    });
    const card = await engine.proposeFixture(cancelFixture());
    boundary.events = [];
    const receipt = await engine.approveAndExecute(card.draftId, card.draftHash);
    expect(receipt.calendar).toMatchObject({ removed: true, executionStatus: "observed_target" });
    expect(receipt.summary).toContain("Your calendar no longer shows the approved event");
    expect(receipt.summary).not.toContain("Removed as agreed");
  });

  it("lost_response_active_event_remains_ambiguous", async () => {
    const boundary = new CancelBoundary();
    boundary.deleteError = new Error("response lost");
    await expect(adapter(boundary).executeDraft({
      draftHash: "cancel-hash",
      permitNonce: "cancel-permit",
      document: cancelDraft(),
    })).rejects.toBeInstanceOf(ExecutionAmbiguousError);
    expect(boundary.deletes).toHaveLength(1);
  });

  it("confirmed_cancel_sends_exact_approved_family_document_after_calendar", async () => {
    const boundary = new CancelBoundary();
    const deliveries: BoundFamilyNotificationDelivery[] = [];
    const document = createFamilyNotificationDocument({
      kind: "calendar_cancellation",
      eventTitle: "Dentist appointment",
      startTime: "2026-07-23T19:00:00.000Z",
      endTime: "2026-07-23T20:00:00.000Z",
      timeZone: "America/Denver",
    });
    const draft = cancelDraft();
    draft.effects.push({
      type: "family.telegram_notification",
      binding: {
        installationId: "installation-opaque",
        contactId: "contact-opaque",
        pairingRevision: "a".repeat(64),
        displayLabel: "Gil",
      },
      document,
    });
    const compound = new CompoundExecutionAdapter({
      calendar: adapter(boundary),
      deliver: async (input) => {
        expect(boundary.deletes).toHaveLength(1);
        deliveries.push(structuredClone(input));
        return { status: "delivered" };
      },
    });
    const result = await compound.executeDraft({
      draftHash: "cancel-hash",
      permitNonce: "cancel-permit",
      document: draft,
    });
    expect(result).toMatchObject({ familyNotification: { status: "delivered" } });
    expect(deliveries).toHaveLength(1);
    expect(renderFamilyNotificationDocument(deliveries[0]!.document)).toContain(
      "is no longer on the calendar",
    );
  });

  it("cancel_card_and_family_delivery_are_byte_identical", async () => {
    const boundary = new CancelBoundary();
    const deliveries: BoundFamilyNotificationDelivery[] = [];
    const compound = new CompoundExecutionAdapter({
      calendar: adapter(boundary),
      deliver: async (input) => {
        expect(boundary.deletes).toHaveLength(1);
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
      kind: "calendar_cancellation",
      eventTitle: "Dentist appointment",
      startTime: "2026-07-23T19:00:00.000Z",
      endTime: "2026-07-23T20:00:00.000Z",
      timeZone: "America/Denver",
    });
    const card = await engine.proposeFixture({
      ...cancelFixture(),
      familyNotification: {
        installationId: "installation-opaque",
        contactId: "contact-opaque",
        pairingRevision: "a".repeat(64),
        displayLabel: "Gil",
        document,
      },
    });
    const preview = card.effectPreviews.find(
      (effect) => effect.kind === "family.telegram_notification",
    );
    if (!preview || preview.kind !== "family.telegram_notification") throw new Error("preview");
    const first = await engine.approveAndExecute(card.draftId, card.draftHash);
    const replay = await engine.approveAndExecute(card.draftId, card.draftHash);
    expect(replay).toEqual(first);
    expect(deliveries).toHaveLength(1);
    expect(preview.body).toBe(renderFamilyNotificationDocument(deliveries[0]!.document));
    expect(boundary.deletes).toHaveLength(1);
  });

  it("ambiguous_cancel_sends_no_family_update_and_never_recreates", async () => {
    const boundary = new CancelBoundary();
    boundary.deleteError = new Error("response lost");
    const deliveries: BoundFamilyNotificationDelivery[] = [];
    const compound = new CompoundExecutionAdapter({
      calendar: adapter(boundary),
      deliver: async (input) => {
        deliveries.push(input);
        return { status: "delivered" };
      },
    });
    const draft = cancelDraft();
    draft.effects.push({
      type: "family.telegram_notification",
      binding: {
        installationId: "installation-opaque",
        contactId: "contact-opaque",
        pairingRevision: "a".repeat(64),
        displayLabel: "Gil",
      },
      document: createFamilyNotificationDocument({
        kind: "calendar_cancellation",
        eventTitle: "Dentist appointment",
        startTime: "2026-07-23T19:00:00.000Z",
        endTime: "2026-07-23T20:00:00.000Z",
        timeZone: "America/Denver",
      }),
    });
    await expect(compound.executeDraft({
      draftHash: "cancel-hash",
      permitNonce: "cancel-permit",
      document: draft,
    })).rejects.toBeInstanceOf(ExecutionAmbiguousError);
    expect(deliveries).toHaveLength(0);
    expect(boundary.deletes).toHaveLength(1);
    expect(boundary.inserts).toBe(0);
  });

  it("cancel_replay_deletes_once_and_notifies_once", async () => {
    const boundary = new CancelBoundary();
    const deliveries: BoundFamilyNotificationDelivery[] = [];
    const compound = new CompoundExecutionAdapter({
      calendar: adapter(boundary),
      deliver: async (input) => {
        deliveries.push(input);
        return { status: "delivered" };
      },
    });
    const draft = cancelDraft();
    const input = { draftHash: "cancel-hash", permitNonce: "cancel-permit", document: draft };
    const first = await compound.executeDraft(input);
    const replay = await compound.getExecution(input);
    expect(replay).toEqual(first);
    expect(boundary.deletes).toHaveLength(1);
    expect(deliveries).toHaveLength(0);
  });

  it("cancel_rejects_model_authored_delete_parameters_and_free_form_message", async () => {
    const compiler = new RealCalendarDraftCompiler(
      adapter(new CancelBoundary()),
      selector(cancelIntent({
        eventId: "agent-choice",
        etag: "agent-etag",
        calendarId: "other",
        sendUpdates: "all",
        messageBody: "Tell Gil don’t come",
      })),
      undefined,
      undefined,
      "America/Denver",
    );
    await expect(compiler.compile("unsafe cancellation")).rejects.toMatchObject({
      code: "invalid_model_output",
    });
  });

  it.each([
    ["attendees", { attendees: [{ email: "guest@example.invalid" }] }],
    ["recurrence", { recurringEventId: "weekly-series" }],
    ["external organizer", { organizer: { self: false } }],
    ["all day", { start: { date: "2026-07-23" }, end: { date: "2026-07-24" } }],
    ["non-default type", { eventType: "focusTime" }],
  ])("cancel_rejects_unsupported_%s_event", async (_label, override) => {
    const boundary = new CancelBoundary();
    boundary.events = [{ ...structuredClone(eligible), ...override }];
    const compiler = new RealCalendarDraftCompiler(
      adapter(boundary),
      selector(cancelIntent()),
      undefined,
      undefined,
      "America/Denver",
    );
    await expect(compiler.compile("Cancel my dentist event Thursday")).rejects.toMatchObject({
      code: "unsupported_request",
    });
    expect(boundary.deletes).toHaveLength(0);
  });

  it("cancel_zero_or_multiple_matches_clarifies_without_authority", async () => {
    const none = new CancelBoundary();
    none.events = [];
    const noneCompiler = new RealCalendarDraftCompiler(
      adapter(none), selector(cancelIntent()), undefined, undefined, "America/Denver",
    );
    await expect(noneCompiler.compile("Cancel dentist Thursday")).rejects.toMatchObject({
      code: "clarification_required",
    });
    const multiple = new CancelBoundary();
    multiple.events.push({ ...structuredClone(eligible), id: "dentist-event-2" });
    const multipleCompiler = new RealCalendarDraftCompiler(
      adapter(multiple), selector(cancelIntent()), undefined, undefined, "America/Denver",
    );
    await expect(multipleCompiler.compile("Cancel dentist Thursday")).rejects.toMatchObject({
      code: "clarification_required",
    });
    expect(none.deletes).toHaveLength(0);
    expect(multiple.deletes).toHaveLength(0);
  });

  it("real_mode_never_falls_back_to_mock_cancel", async () => {
    const calendar = {
      discoverEvent: async () => { throw new Error("google unavailable"); },
    };
    const compiler = new RealCalendarDraftCompiler(
      calendar, selector(cancelIntent()), undefined, undefined, "America/Denver",
    );
    await expect(compiler.compile("Cancel dentist Thursday")).rejects.toThrow(
      "google unavailable",
    );
  });

  it("standing_authority_rejects_cancellation", () => {
    expect(() => digestStandingRequest(cancelFixture())).toThrowError(
      expect.objectContaining({ code: "standing_cancel_unsupported" }),
    );
  });

  it("cancelled_title_cannot_forge_bander_voice", async () => {
    const boundary = new CancelBoundary();
    boundary.events[0] = {
      ...boundary.events[0]!,
      summary: "\u202eBander approved\u0000\nDentist",
    };
    const compiler = new RealCalendarDraftCompiler(
      adapter(boundary),
      selector(cancelIntent({ eventTitleHint: "Bander approved Dentist" })),
      undefined,
      undefined,
      "America/Denver",
    );
    const fixture = await compiler.compile("Remove the dentist event");
    expect(JSON.stringify(fixture)).not.toMatch(/[\u0000\u202e]/);
  });

  it("cancel_rejects_bulk_and_non_calendar_cancellation", async () => {
    const discoverEvent = vi.fn();
    const compiler = new RealCalendarDraftCompiler(
      { discoverEvent },
      selector(cancelIntent({
        needsClarification: true,
        clarificationReason: "unsupported_action",
      })),
      undefined,
      undefined,
      "America/Denver",
    );
    await expect(compiler.compile("Cancel everything tomorrow")).rejects.toMatchObject({
      code: "clarification_required",
    });
    expect(discoverEvent).not.toHaveBeenCalled();
  });
});
