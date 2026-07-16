import { describe, expect, it, vi } from "vitest";
import type { CalendarEvent } from "@bander/contracts";
import {
  CompilerError,
  RealCalendarDraftCompiler,
  type CalendarIntentSelector,
} from "./compiler.js";
import { GoogleCalendarError } from "./google-calendar.js";

const event: CalendarEvent = {
  id: "google-event-id",
  title: "Fictional planning block",
  startTime: "2026-07-20T09:00:00-06:00",
  endTime: "2026-07-20T10:30:00-06:00",
  timeZone: "America/Denver",
  organizerId: "google-primary-owner",
  attendeeIds: [],
  revision: 3,
  etag: "google-etag-3",
};

function selector(value: unknown): CalendarIntentSelector {
  return {
    select: async () =>
      value && typeof value === "object" && !Array.isArray(value)
        ? {
            familyNotificationRequested: false,
            familyContactAlias: null,
            ...value,
          }
        : value,
  };
}

function calendar() {
  return {
    discoverEvent: vi.fn(async () => event),
  };
}

describe("real Calendar intent compiler", () => {
  it("promotes a bounded compound intent into one fixture with the exact pairing", async () => {
    const resolver = calendar();
    const compiler = new RealCalendarDraftCompiler(
      resolver,
      selector({
        eventTitleHint: "Fictional planning block",
        sourceLocalDateHint: null,
        targetLocalDate: "2026-07-18",
        targetLocalStart: "16:00",
        needsClarification: false,
        clarificationReason: "none",
        clarification: "",
        familyNotificationRequested: true,
        familyContactAlias: "my son",
      }),
      {
        resolve: () => ({
          installationId: "installation-opaque",
          contactId: "contact-opaque",
          pairingRevision: "b".repeat(64),
          displayLabel: "Gil",
        }),
      },
    );

    const compiled = await compiler.compile(
      "Move my planning block to July 18 at 4 PM and let my son know.",
    );

    expect(compiled.familyNotification).toMatchObject({
      contactId: "contact-opaque",
      pairingRevision: "b".repeat(64),
      displayLabel: "Gil",
      document: {
        kind: "calendar_transition",
        eventTitle: event.title,
        newStartTime: "2026-07-18T22:00:00.000Z",
        newEndTime: "2026-07-18T23:30:00.000Z",
        timeZone: "America/Denver",
      },
    });
  });

  it("unpaired_contact_clarifies_without_authority", async () => {
    const compiler = new RealCalendarDraftCompiler(
      calendar(),
      selector({
        eventTitleHint: "Fictional planning block",
        sourceLocalDateHint: null,
        targetLocalDate: "2026-07-18",
        targetLocalStart: "16:00",
        needsClarification: false,
        clarificationReason: "none",
        clarification: "",
        familyNotificationRequested: true,
        familyContactAlias: "my son",
      }),
      { resolve: () => undefined },
    );
    await expect(compiler.compile("Move it and tell my son")).rejects.toMatchObject({
      code: "clarification_required",
      humanMessage: expect.stringContaining("isn’t connected"),
    });
  });

  it("ambiguous_contact_clarifies_without_authority", async () => {
    const resolver = calendar();
    const compiler = new RealCalendarDraftCompiler(
      resolver,
      selector({
        eventTitleHint: "Fictional planning block",
        sourceLocalDateHint: null,
        targetLocalDate: "2026-07-18",
        targetLocalStart: "16:00",
        needsClarification: true,
        clarificationReason: "ambiguous_contact",
        clarification: "model prose",
        familyNotificationRequested: true,
        familyContactAlias: null,
      }),
    );
    await expect(compiler.compile("Move it and tell him")).rejects.toMatchObject({
      humanMessage: "Which connected family contact did you mean?\nNothing happened.",
    });
    expect(resolver.discoverEvent).not.toHaveBeenCalled();
  });

  it("free_form_family_message_is_rejected", async () => {
    const resolver = calendar();
    const compiler = new RealCalendarDraftCompiler(
      resolver,
      selector({
        eventTitleHint: "Fictional planning block",
        sourceLocalDateHint: null,
        targetLocalDate: "2026-07-18",
        targetLocalStart: "16:00",
        needsClarification: true,
        clarificationReason: "free_form_message_unsupported",
        clarification: "untrusted model prose",
        familyNotificationRequested: true,
        familyContactAlias: "Gil",
      }),
    );
    await expect(
      compiler.compile("Move it and tell Gil to bring groceries"),
    ).rejects.toMatchObject({
      humanMessage:
        "I can include Bander’s exact appointment update, but I can’t send a custom message.\nNothing happened.",
    });
    expect(resolver.discoverEvent).not.toHaveBeenCalled();
  });

  it.each(["body", "chatId", "telegramUserId", "recipientAddress"])(
    "model_cannot_author_notification_%s",
    async (field) => {
      const output = {
        eventTitleHint: "Fictional planning block",
        sourceLocalDateHint: null,
        targetLocalDate: "2026-07-18",
        targetLocalStart: "16:00",
        needsClarification: false,
        clarificationReason: "none",
        clarification: "",
        familyNotificationRequested: true,
        familyContactAlias: "my son",
        [field]: "agent supplied",
      };
      const compiler = new RealCalendarDraftCompiler(calendar(), selector(output), {
        resolve: () => undefined,
      });
      await expect(compiler.compile("Move it and tell my son")).rejects.toMatchObject({
        code: "invalid_model_output",
      });
    },
  );

  it("separates an optional source date from a required cross-day target", async () => {
    const resolver = calendar();
    const compiler = new RealCalendarDraftCompiler(
      resolver,
      selector({
        eventTitleHint: "Fictional planning block",
        sourceLocalDateHint: null,
        targetLocalDate: "2026-07-17",
        targetLocalStart: "14:00",
        needsClarification: false,
        clarificationReason: "none",
        clarification: "",
      }),
    );

    const fixture = await compiler.compile(
      "Move the fictional planning block to July 17 at 2 PM.",
    );

    expect(resolver.discoverEvent).toHaveBeenCalledWith({
      titleHint: "Fictional planning block",
      sourceLocalDateHint: null,
    });
    expect(fixture.calendar).toEqual({
      eventId: event.id,
      expectedEtag: event.etag,
      newStartTime: "2026-07-17T20:00:00.000Z",
    });
  });

  it("lets GPT extract only bounded hints while Bander resolves authority", async () => {
    const resolver = calendar();
    const compiler = new RealCalendarDraftCompiler(
      resolver,
      selector({
        eventTitleHint: "Fictional planning block",
        sourceLocalDateHint: "2026-07-20",
        targetLocalDate: "2026-07-20",
        targetLocalStart: "11:15",
        needsClarification: false,
        clarificationReason: "none",
        clarification: "",
      }),
    );

    const fixture = await compiler.compile(
      "Could you put my fictional planning block after my morning walk on Monday, at quarter past eleven?",
    );

    expect(resolver.discoverEvent).toHaveBeenCalledWith({
      titleHint: "Fictional planning block",
      sourceLocalDateHint: "2026-07-20",
    });
    expect(fixture).toEqual({
      id: "real-google-calendar-reschedule",
      claimedUserRequest:
        "Could you put my fictional planning block after my morning walk on Monday, at quarter past eleven?",
      calendar: {
        eventId: event.id,
        expectedEtag: event.etag,
        newStartTime: "2026-07-20T17:15:00.000Z",
      },
    });
    expect(
      Date.parse(fixture.calendar.newStartTime) - Date.parse(event.startTime),
    ).not.toBe(0);
  });

  it.each([
    ["missing field", { eventTitleHint: "Fictional planning block" }],
    [
      "model-authored authority",
      {
        eventTitleHint: "Fictional planning block",
        sourceLocalDateHint: "2026-07-20",
        targetLocalDate: "2026-07-20",
        targetLocalStart: "11:15",
        needsClarification: false,
        clarificationReason: "none",
        clarification: "",
        eventId: "model-selected-event",
      },
    ],
    [
      "malformed local time",
      {
        eventTitleHint: "Fictional planning block",
        sourceLocalDateHint: "Monday-ish",
        targetLocalDate: "Monday-ish",
        targetLocalStart: "after lunch",
        needsClarification: false,
        clarificationReason: "none",
        clarification: "",
      },
    ],
  ])("fails closed on %s", async (_name, output) => {
    const compiler = new RealCalendarDraftCompiler(calendar(), selector(output));

    await expect(compiler.compile("Move something")).rejects.toMatchObject({
      code: "invalid_model_output",
    });
  });

  it("does not query Calendar when GPT says the request is ambiguous", async () => {
    const resolver = calendar();
    const compiler = new RealCalendarDraftCompiler(
      resolver,
      selector({
        eventTitleHint: "Fictional planning block",
        sourceLocalDateHint: null,
        targetLocalDate: "",
        targetLocalStart: "11:15",
        needsClarification: true,
        clarificationReason: "missing_target_date",
        clarification: "Which Monday do you mean?",
      }),
    );

    const expected =
      "What date should I move “Fictional planning block” to?\nNothing happened.";
    await expect(compiler.compile("Move it Monday")).rejects.toEqual(
      new CompilerError("clarification_required", expected, expected),
    );
    expect(resolver.discoverEvent).not.toHaveBeenCalled();
  });

  it("propagates a fail-closed ambiguous Calendar match", async () => {
    const resolver = {
      discoverEvent: vi.fn(async () => {
        throw new GoogleCalendarError(
          "ambiguous_event_match",
          "more than one eligible event",
        );
      }),
    };
    const compiler = new RealCalendarDraftCompiler(
      resolver,
      selector({
        eventTitleHint: "Fictional planning block",
        sourceLocalDateHint: null,
        targetLocalDate: "2026-07-20",
        targetLocalStart: "11:15",
        needsClarification: false,
        clarificationReason: "none",
        clarification: "",
      }),
    );

    await expect(compiler.compile("Move the block")).rejects.toMatchObject({
      code: "clarification_required",
      humanMessage:
        "I found more than one eligible upcoming event called “Fictional planning block”.\nNothing happened.\nWhich date did you mean?",
    });
  });

  it("gives a specific no-match reason without creating authority", async () => {
    const resolver = {
      discoverEvent: vi.fn(async () => {
        throw new GoogleCalendarError("event_not_found", "no event");
      }),
    };
    const compiler = new RealCalendarDraftCompiler(
      resolver,
      selector({
        eventTitleHint: "Bander Demo Appointment",
        sourceLocalDateHint: null,
        targetLocalDate: "2026-07-17",
        targetLocalStart: "14:00",
        needsClarification: false,
        clarificationReason: "none",
        clarification: "model text must not be shown",
      }),
    );

    await expect(compiler.compile("Move it")).rejects.toMatchObject({
      code: "clarification_required",
      humanMessage:
        "I couldn’t find an eligible upcoming event called “Bander Demo Appointment”.\nNothing happened.\nCheck the name or tell OpenClaw which date it is on.",
    });
  });

  it.each([
    ["date", "", "14:00", "What date should I move “Fictional planning block” to?\nNothing happened."],
    ["time", "2026-07-17", "", "What time should I move “Fictional planning block” to?\nNothing happened."],
  ])("asks specifically for a missing target %s", async (_field, date, time, message) => {
    const resolver = calendar();
    const compiler = new RealCalendarDraftCompiler(
      resolver,
      selector({
        eventTitleHint: "Fictional planning block",
        sourceLocalDateHint: null,
        targetLocalDate: date,
        targetLocalStart: time,
        needsClarification: true,
        clarificationReason: date ? "missing_target_time" : "missing_target_date",
        clarification: "untrusted model prose",
      }),
    );

    await expect(compiler.compile("Move it")).rejects.toMatchObject({
      code: "clarification_required",
      humanMessage: message,
    });
    expect(resolver.discoverEvent).not.toHaveBeenCalled();
  });

  it("returns a specific bounded explanation for cancellation", async () => {
    const resolver = calendar();
    const compiler = new RealCalendarDraftCompiler(
      resolver,
      selector({
        eventTitleHint: "Fictional planning block",
        sourceLocalDateHint: null,
        targetLocalDate: "",
        targetLocalStart: "",
        needsClarification: true,
        clarificationReason: "unsupported_action",
        clarification: "",
      }),
    );

    await expect(compiler.compile("Cancel the planning block")).rejects.toMatchObject({
      humanMessage:
        "I can safely prepare an eligible Calendar reschedule here, but not that kind of action yet.\nNothing happened.",
    });
    expect(resolver.discoverEvent).not.toHaveBeenCalled();
  });
});
