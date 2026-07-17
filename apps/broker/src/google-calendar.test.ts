import { describe, expect, it } from "vitest";
import type { DraftDocument } from "@bander/contracts";
import { ExecutionAmbiguousError, ExecutionConflictError } from "@bander/core";
import {
  GoogleCalendarAdapter,
  GoogleCalendarError,
  type GoogleCalendarBoundary,
  type GoogleEventResource,
} from "./google-calendar.js";

const eligibleEvent: GoogleEventResource = {
  id: "google-event-1",
  etag: '"etag-1"',
  summary: "Fictional planning block",
  status: "confirmed",
  sequence: 3,
  organizer: { self: true, email: "private@example.invalid" },
  attendees: [],
  start: {
    dateTime: "2026-07-20T09:00:00-06:00",
    timeZone: "America/Denver",
  },
  end: {
    dateTime: "2026-07-20T10:00:00-06:00",
    timeZone: "America/Denver",
  },
};

class FakeBoundary implements GoogleCalendarBoundary {
  events: GoogleEventResource[] = [structuredClone(eligibleEvent)];
  patches: Parameters<GoogleCalendarBoundary["patchEvent"]>[0][] = [];
  patchError: unknown;
  lists: Parameters<GoogleCalendarBoundary["listEvents"]>[0][] = [];

  async getPrimaryTimeZone(): Promise<string> {
    return "America/Denver";
  }

  async listScheduleEvents() {
    return {
      events: structuredClone(this.events),
      timeZone: "America/Denver",
      truncated: false,
    };
  }

  async listEvents(
    input: Parameters<GoogleCalendarBoundary["listEvents"]>[0],
  ): Promise<GoogleEventResource[]> {
    this.lists.push(structuredClone(input));
    return structuredClone(this.events);
  }

  async getEvent(): Promise<GoogleEventResource> {
    return structuredClone(this.events[0]!);
  }

  async patchEvent(
    input: Parameters<GoogleCalendarBoundary["patchEvent"]>[0],
  ): Promise<GoogleEventResource> {
    this.patches.push(structuredClone(input));
    if (this.patchError) throw this.patchError;
    return {
      ...structuredClone(eligibleEvent),
      etag: '"etag-2"',
      start: { ...input.requestBody.start },
      end: { ...input.requestBody.end },
    };
  }

  async insertEvent(): Promise<GoogleEventResource> {
    throw new Error("unused");
  }

  async deleteEvent(): Promise<void> {
    throw new Error("unused");
  }

}

function calendarOnlyDraft(): DraftDocument {
  return {
    version: 1,
    source: {
      provenance: "agent_claimed",
      claimedUserRequest: "Move my fictional planning block to 10:30.",
    },
    effects: [
      {
        type: "calendar.reschedule_event",
        eventId: "google-event-1",
        expected: {
          etag: '"etag-1"',
          title: "Fictional planning block",
          startTime: "2026-07-20T09:00:00-06:00",
          endTime: "2026-07-20T10:00:00-06:00",
          timeZone: "America/Denver",
          organizerId: "google-primary-owner",
          attendeeIds: [],
        },
        changes: {
          startTime: "2026-07-20T10:30:00-06:00",
          endTime: "2026-07-20T11:30:00-06:00",
        },
      },
    ],
    createdAt: "2026-07-20T14:00:00.000Z",
    expiresAt: "2026-07-20T14:10:00.000Z",
  };
}

describe("real Google Calendar boundary", () => {
  it("finds one exact-title eligible event in a bounded upcoming window without a source date", async () => {
    const boundary = new FakeBoundary();
    const adapter = new GoogleCalendarAdapter(
      boundary,
      () => new Date("2026-07-15T12:00:00.000Z"),
    );

    await expect(
      adapter.discoverEvent({
        titleHint: "  FICTIONAL   planning block ",
        sourceLocalDateHint: null,
      }),
    ).resolves.toMatchObject({ id: "google-event-1" });
    expect(boundary.lists).toEqual([
      {
        calendarId: "primary",
        timeMin: "2026-07-15T12:00:00.000Z",
        timeMax: "2026-08-15T12:00:00.000Z",
      },
    ]);
  });

  it("rejects multiple exact-title upcoming matches across dates", async () => {
    const boundary = new FakeBoundary();
    boundary.events.push({
      ...structuredClone(eligibleEvent),
      id: "google-event-2",
      start: {
        dateTime: "2026-07-22T09:00:00-06:00",
        timeZone: "America/Denver",
      },
      end: {
        dateTime: "2026-07-22T10:00:00-06:00",
        timeZone: "America/Denver",
      },
    });
    const adapter = new GoogleCalendarAdapter(
      boundary,
      () => new Date("2026-07-15T12:00:00.000Z"),
    );

    await expect(
      adapter.discoverEvent({
        titleHint: "Fictional planning block",
        sourceLocalDateHint: null,
      }),
    ).rejects.toMatchObject({ code: "ambiguous_event_match" });
  });

  it("returns a distinct no-match result for an exact title miss", async () => {
    const boundary = new FakeBoundary();
    const adapter = new GoogleCalendarAdapter(boundary);

    await expect(
      adapter.discoverEvent({
        titleHint: "An event that is not there",
        sourceLocalDateHint: null,
      }),
    ).rejects.toMatchObject({ code: "event_not_found" });
  });

  it("google_adapter_rejects_ambiguous_event_match", async () => {
    const boundary = new FakeBoundary();
    boundary.events.push({ ...structuredClone(eligibleEvent), id: "google-event-2" });
    const adapter = new GoogleCalendarAdapter(boundary);

    await expect(
      adapter.discoverEvent({
        titleHint: "Fictional planning block",
        sourceLocalDateHint: "2026-07-20",
      }),
    ).rejects.toEqual(
      new GoogleCalendarError(
        "ambiguous_event_match",
        "Bander could not identify exactly one eligible Calendar event",
      ),
    );
  });

  it.each([
    ["all-day", { start: { date: "2026-07-20" }, end: { date: "2026-07-21" } }],
    ["recurring", { recurringEventId: "series-1" }],
    ["not-owner-organized", { organizer: { self: false } }],
    ["has-attendees", { attendees: [{ email: "guest@example.invalid" }] }],
  ])(
    "google_adapter_rejects_unsupported_%s_event",
    async (_label, override) => {
      const boundary = new FakeBoundary();
      boundary.events = [{ ...structuredClone(eligibleEvent), ...override }];
      const adapter = new GoogleCalendarAdapter(boundary);

      await expect(
        adapter.discoverEvent({
          titleHint: "Fictional planning block",
          sourceLocalDateHint: "2026-07-20",
        }),
      ).rejects.toMatchObject({ code: "unsupported_event_shape" });
    },
  );

  it("google_adapter_sends_start_end_only_with_original_if_match", async () => {
    const boundary = new FakeBoundary();
    const adapter = new GoogleCalendarAdapter(boundary);

    await adapter.executeDraft({
      draftHash: "draft-hash",
      permitNonce: "permit-nonce",
      document: calendarOnlyDraft(),
    });

    expect(boundary.patches).toEqual([
      {
        calendarId: "primary",
        eventId: "google-event-1",
        sendUpdates: "none",
        ifMatch: '"etag-1"',
        requestBody: {
          start: {
            dateTime: "2026-07-20T10:30:00-06:00",
            timeZone: "America/Denver",
          },
          end: {
            dateTime: "2026-07-20T11:30:00-06:00",
            timeZone: "America/Denver",
          },
        },
      },
    ]);
  });

  it("accepts_google_response_with_equivalent_offset_timestamp_spelling", async () => {
    const boundary = new FakeBoundary();
    boundary.patchEvent = async (input) => {
      boundary.patches.push(structuredClone(input));
      return {
        ...structuredClone(eligibleEvent),
        etag: '"etag-2"',
        start: {
          dateTime: "2026-07-20T10:30:00-06:00",
          timeZone: "America/Denver",
        },
        end: {
          dateTime: "2026-07-20T11:30:00-06:00",
          timeZone: "America/Denver",
        },
      };
    };
    const adapter = new GoogleCalendarAdapter(boundary);
    const draft = calendarOnlyDraft();
    const calendar = draft.effects[0];
    if (calendar?.type !== "calendar.reschedule_event") throw new Error("fixture");
    calendar.changes = {
      startTime: "2026-07-20T16:30:00.000Z",
      endTime: "2026-07-20T17:30:00.000Z",
    };

    await expect(
      adapter.executeDraft({
        draftHash: "draft-hash",
        permitNonce: "permit-nonce",
        document: draft,
      }),
    ).resolves.toMatchObject({ calendar: { status: "committed" } });
  });

  it("google_adapter_maps_http_412_to_conflict_without_retry", async () => {
    const boundary = new FakeBoundary();
    boundary.patchError = { response: { status: 412 } };
    const adapter = new GoogleCalendarAdapter(boundary);

    await expect(
      adapter.executeDraft({
        draftHash: "draft-hash",
        permitNonce: "permit-nonce",
        document: calendarOnlyDraft(),
      }),
    ).rejects.toBeInstanceOf(ExecutionConflictError);
    expect(boundary.patches).toHaveLength(1);
  });

  it("google_adapter_fails_closed_on_definitive_google_rejection", async () => {
    const boundary = new FakeBoundary();
    boundary.patchError = { response: { status: 403 }, config: { headers: "secret" } };
    const adapter = new GoogleCalendarAdapter(boundary);

    await expect(
      adapter.executeDraft({
        draftHash: "draft-hash",
        permitNonce: "permit-nonce",
        document: calendarOnlyDraft(),
      }),
    ).rejects.toMatchObject({ code: "google_calendar_unavailable" });
    expect(boundary.patches).toHaveLength(1);
  });

  it("committed_google_write_with_lost_response_is_never_blindly_retried", async () => {
    const boundary = new FakeBoundary();
    boundary.patchEvent = async (input) => {
      boundary.patches.push(structuredClone(input));
      boundary.events[0] = {
        ...structuredClone(eligibleEvent),
        etag: '"etag-2"',
        start: { ...input.requestBody.start },
        end: { ...input.requestBody.end },
      };
      throw new Error("response lost after commit");
    };
    const adapter = new GoogleCalendarAdapter(boundary);

    await expect(
      adapter.executeDraft({
        draftHash: "draft-hash",
        permitNonce: "permit-nonce",
        document: calendarOnlyDraft(),
      }),
    ).resolves.toMatchObject({ calendar: { status: "observed_target" } });
    expect(boundary.patches).toHaveLength(1);
  });

  it("committed_patch_with_incomplete_response_is_reconciled_by_reread", async () => {
    const boundary = new FakeBoundary();
    boundary.patchEvent = async (input) => {
      boundary.patches.push(structuredClone(input));
      boundary.events[0] = {
        ...structuredClone(eligibleEvent),
        etag: '"etag-2"',
        start: { ...input.requestBody.start },
        end: { ...input.requestBody.end },
      };
      return {
        id: eligibleEvent.id!,
        etag: '"etag-2"',
        start: { ...input.requestBody.start },
        end: { ...input.requestBody.end },
      };
    };
    const adapter = new GoogleCalendarAdapter(boundary);
    await expect(adapter.executeDraft({
      draftHash: "draft-hash",
      permitNonce: "permit-nonce",
      document: calendarOnlyDraft(),
    })).resolves.toMatchObject({ calendar: { status: "observed_target" } });
    expect(boundary.patches).toHaveLength(1);
  });

  it("lost_google_response_with_non_target_state_stays_ambiguous_without_retry", async () => {
    const boundary = new FakeBoundary();
    boundary.patchError = { response: { status: 503 } };
    const adapter = new GoogleCalendarAdapter(boundary);
    await expect(
      adapter.executeDraft({
        draftHash: "draft-hash",
        permitNonce: "permit-nonce",
        document: calendarOnlyDraft(),
      }),
    ).rejects.toBeInstanceOf(ExecutionAmbiguousError);
    expect(boundary.patches).toHaveLength(1);
  });

  it("recovery_observes_the_approved_target_without_another_patch", async () => {
    const boundary = new FakeBoundary();
    const draft = calendarOnlyDraft();
    const calendar = draft.effects[0];
    if (calendar?.type !== "calendar.reschedule_event") throw new Error("fixture");
    boundary.events[0] = {
      ...structuredClone(eligibleEvent),
      etag: '"etag-2"',
      start: { dateTime: calendar.changes.startTime, timeZone: calendar.expected.timeZone },
      end: { dateTime: calendar.changes.endTime, timeZone: calendar.expected.timeZone },
    };
    const adapter = new GoogleCalendarAdapter(boundary);
    await expect(adapter.getExecution({
      draftHash: "draft-hash",
      permitNonce: "permit-nonce",
      document: draft,
    })).resolves.toMatchObject({ calendar: { status: "observed_target" } });
    expect(boundary.patches).toHaveLength(0);
  });

  it("google_adapter_rejects_messages_or_additional_effects", async () => {
    const boundary = new FakeBoundary();
    const adapter = new GoogleCalendarAdapter(boundary);
    const draft = calendarOnlyDraft();
    draft.effects.push({
      type: "messages.send",
      recipientId: "person-sarah",
      expected: { revision: 1, displayName: "Sarah" },
      body: "This must never be simulated in real mode.",
    });

    await expect(
      adapter.executeDraft({
        draftHash: "draft-hash",
        permitNonce: "permit-nonce",
        document: draft,
      }),
    ).rejects.toMatchObject({ code: "unsupported_real_execution_shape" });
    expect(boundary.patches).toHaveLength(0);
  });
});
