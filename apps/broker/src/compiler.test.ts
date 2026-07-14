import { describe, expect, it } from "vitest";
import type { DraftFixture } from "@bander/core";
import {
  CompilerError,
  FixtureDraftCompiler,
  type CandidateSelector,
} from "./compiler.js";

const fixture: DraftFixture = {
  id: "move-dinner-and-notify-sarah",
  claimedUserRequest: "Versioned fixture request",
  calendar: {
    eventId: "event-dinner-sarah",
    expectedEtag: "event-dinner-sarah-r1",
    newStartTime: "2026-07-14T19:30:00-06:00",
  },
  message: {
    recipientId: "person-sarah",
    expectedRecipientRevision: 1,
    body: "I’ll be about 20 minutes late. See you at 7:30!",
  },
};

function selector(
  result: Awaited<ReturnType<CandidateSelector["select"]>>,
): CandidateSelector {
  return { select: async () => result };
}

describe("optional model compiler", () => {
  it("can select but cannot alter a versioned Draft fixture", async () => {
    const compiler = new FixtureDraftCompiler(
      new Map([[fixture.id, fixture]]),
      selector({
        fixtureId: "move-dinner-and-notify-sarah",
        needsClarification: false,
        clarification: "",
      }),
    );
    const agentClaim = "Please move dinner and tell Sarah I’ll be late.";

    const compiled = await compiler.compile(agentClaim);

    expect(compiled.claimedUserRequest).toBe(agentClaim);
    expect(compiled.calendar).toEqual(fixture.calendar);
    expect(compiled.message).toEqual(fixture.message);
    expect(compiled).not.toBe(fixture);
  });

  it("does not create a Draft when the model asks for clarification", async () => {
    const compiler = new FixtureDraftCompiler(
      new Map([[fixture.id, fixture]]),
      selector({
        fixtureId: "move-dinner-and-notify-sarah",
        needsClarification: true,
        clarification: "What time should dinner move to?",
      }),
    );

    await expect(compiler.compile("Move dinner later")).rejects.toEqual(
      new CompilerError("clarification_required", "What time should dinner move to?"),
    );
  });
});
