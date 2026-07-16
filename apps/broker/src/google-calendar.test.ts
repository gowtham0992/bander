import { describe, expect, it } from "vitest";
import type { DraftDocument } from "@bander/contracts";
import { ExecutionConflictError } from "@bander/core";
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

  async listEvents(): Promise<GoogleEventResource[]> {
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
  it("google_adapter_rejects_ambiguous_event_match", async () => {
    const boundary = new FakeBoundary();
    boundary.events.push({ ...structuredClone(eligibleEvent), id: "google-event-2" });
    const adapter = new GoogleCalendarAdapter(boundary);

    await expect(
      adapter.discoverEvent({
        titleHint: "Fictional planning block",
        localDate: "2026-07-20",
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
          localDate: "2026-07-20",
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
    ).resolves.toBeUndefined();
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

  it("google_adapter_fails_closed_on_non_412_google_errors", async () => {
    const boundary = new FakeBoundary();
    boundary.patchError = { response: { status: 503 }, config: { headers: "secret" } };
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
