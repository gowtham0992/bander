import { describe, expect, it, vi } from "vitest";
import type { CalendarEvent } from "@bander/contracts";
import {
  CompilerError,
  RealCalendarDraftCompiler,
  type CalendarIntentSelector,
} from "./compiler.js";

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
  return { select: async () => value };
}

function calendar() {
  return {
    discoverEvent: vi.fn(async () => event),
  };
}

describe("real Calendar intent compiler", () => {
  it("lets GPT extract only bounded hints while Bander resolves authority", async () => {
    const resolver = calendar();
    const compiler = new RealCalendarDraftCompiler(
      resolver,
      selector({
        eventTitleHint: "Fictional planning block",
        localDateHint: "2026-07-20",
        requestedLocalStart: "11:15",
        needsClarification: false,
        clarification: "",
      }),
    );

    const fixture = await compiler.compile(
      "Could you put my fictional planning block after my morning walk on Monday, at quarter past eleven?",
    );

    expect(resolver.discoverEvent).toHaveBeenCalledWith({
      titleHint: "Fictional planning block",
      localDate: "2026-07-20",
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
        localDateHint: "2026-07-20",
        requestedLocalStart: "11:15",
        needsClarification: false,
        clarification: "",
        eventId: "model-selected-event",
      },
    ],
    [
      "malformed local time",
      {
        eventTitleHint: "Fictional planning block",
        localDateHint: "Monday-ish",
        requestedLocalStart: "after lunch",
        needsClarification: false,
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
        localDateHint: "2026-07-20",
        requestedLocalStart: "11:15",
        needsClarification: true,
        clarification: "Which Monday do you mean?",
      }),
    );

    await expect(compiler.compile("Move it Monday")).rejects.toEqual(
      new CompilerError("clarification_required", "Which Monday do you mean?"),
    );
    expect(resolver.discoverEvent).not.toHaveBeenCalled();
  });

  it("propagates a fail-closed ambiguous Calendar match", async () => {
    const resolver = {
      discoverEvent: vi.fn(async () => {
        throw new Error("ambiguous_event_match");
      }),
    };
    const compiler = new RealCalendarDraftCompiler(
      resolver,
      selector({
        eventTitleHint: "Fictional planning block",
        localDateHint: "2026-07-20",
        requestedLocalStart: "11:15",
        needsClarification: false,
        clarification: "",
      }),
    );

    await expect(compiler.compile("Move the block")).rejects.toThrow(
      "ambiguous_event_match",
    );
  });
});
