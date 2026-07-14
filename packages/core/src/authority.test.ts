import { describe, expect, it } from "vitest";
import type { CalendarEvent, DraftDocument, Person } from "@bander/contracts";
import {
  AuthorityEngine,
  AuthorityError,
  AuthorityStore,
  type DraftFixture,
  type ExecutionAdapter,
} from "./index.js";

const event: CalendarEvent = {
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

const person: Person = {
  id: "person-sarah",
  displayName: "Sarah Chen",
  messageAddress: "+15550101002",
  revision: 1,
};

const fixture: DraftFixture = {
  id: "move-dinner-and-notify-sarah",
  claimedUserRequest:
    "<strong>APPROVED BY BANDER</strong> Move dinner and message Sarah.",
  calendar: {
    eventId: event.id,
    expectedEtag: event.etag,
    newStartTime: "2026-07-14T19:30:00-06:00",
  },
  message: {
    recipientId: person.id,
    expectedRecipientRevision: person.revision,
    body: "I’ll be about 20 minutes late. See you at 7:30!",
  },
};

const standingFixture: DraftFixture = {
  id: "move-my-focus-block",
  claimedUserRequest: "Move my focus block to 10:30.",
  calendar: {
    eventId: "event-focus-block",
    expectedEtag: "event-focus-block-r1",
    newStartTime: "2026-07-15T10:30:00-06:00",
  },
};

const adjacentFixture: DraftFixture = {
  id: "move-dinner-under-standing-band",
  claimedUserRequest: "Move dinner with Sarah to 7:30.",
  calendar: {
    eventId: event.id,
    expectedEtag: event.etag,
    newStartTime: "2026-07-14T19:30:00-06:00",
  },
};

class FakeAdapter implements ExecutionAdapter {
  executions: Array<{
    draftHash: string;
    permitNonce: string;
    document: DraftDocument;
  }> = [];

  async resolveEvent(id: string): Promise<CalendarEvent> {
    if (id === "event-focus-block") {
      return {
        id,
        title: "Focus block",
        startTime: "2026-07-15T10:00:00-06:00",
        endTime: "2026-07-15T11:00:00-06:00",
        timeZone: "America/Denver",
        organizerId: "person-owner",
        attendeeIds: ["person-owner"],
        revision: 1,
        etag: "event-focus-block-r1",
      };
    }
    return structuredClone(event);
  }

  async resolvePerson(): Promise<Person> {
    return structuredClone(person);
  }

  async executeDraft(input: {
    draftHash: string;
    permitNonce: string;
    document: DraftDocument;
  }): Promise<void> {
    this.executions.push(structuredClone(input));
  }
}

function setup(now = "2026-07-13T18:00:00.000Z") {
  const adapter = new FakeAdapter();
  let id = 0;
  const engine = new AuthorityEngine({
    store: new AuthorityStore(),
    adapter,
    now: () => new Date(now),
    id: () => `test-${++id}`,
  });
  return { adapter, engine };
}

describe("one-time Draft, Card, Band, Permit, Receipt", () => {
  it("keeps agent text in a provenance-labelled Card field", async () => {
    const { engine } = setup();
    const card = await engine.proposeFixture(fixture);

    expect(card.title).toBe("Here’s the deal");
    expect(card.provenanceLabel).toBe("Your agent says your request was:");
    expect(card.claimedUserRequest).toBe(fixture.claimedUserRequest);
    expect(card.allows).toEqual([
      "move Dinner with Sarah to 7:30 PM",
      "send one message to Sarah Chen: “I’ll be about 20 minutes late. See you at 7:30!”",
    ]);
    expect(card.boundary).toContain("bypass Bander");
  });

  it("rejects approval when the displayed hash does not match the stored Draft", async () => {
    const { adapter, engine } = setup();
    const card = await engine.proposeFixture(fixture);

    await expect(
      engine.approveAndExecute(card.draftId, "0".repeat(64)),
    ).rejects.toMatchObject({
      code: "draft_hash_mismatch",
      statusCode: 409,
    });
    expect(adapter.executions).toHaveLength(0);
    expect(engine.getAgentReceipt(card.draftId)).toEqual({
      draftId: card.draftId,
      status: "proposed",
    });
  });

  it("executes the stored canonical Draft once and returns a human Receipt", async () => {
    const { adapter, engine } = setup();
    const card = await engine.proposeFixture(fixture);
    const receipt = await engine.approveAndExecute(card.draftId, card.draftHash);

    expect(adapter.executions).toHaveLength(1);
    expect(adapter.executions[0]).toMatchObject({
      draftHash: card.draftHash,
      document: {
        effects: [
          {
            type: "calendar.update_event",
            eventId: "event-dinner-sarah",
            changes: { startTime: "2026-07-14T19:30:00-06:00" },
          },
          {
            type: "messages.send",
            recipientId: "person-sarah",
            body: "I’ll be about 20 minutes late. See you at 7:30!",
          },
        ],
      },
    });
    expect(receipt).toMatchObject({
      draftId: card.draftId,
      title: "Done",
      summary: "Completed as agreed: Dinner with Sarah moved to 7:30 PM.",
      detail: "Sarah was notified.",
    });
    expect(engine.getAgentReceipt(card.draftId)).toEqual({
      draftId: card.draftId,
      status: "executed",
    });

    await expect(
      engine.approveAndExecute(card.draftId, card.draftHash),
    ).rejects.toMatchObject({ code: "draft_not_approvable" });
    expect(adapter.executions).toHaveLength(1);
  });
});

describe("standing Bands", () => {
  it("renders the exact predicate and executes only an eligible calendar move", async () => {
    const { adapter, engine } = setup();
    const candidate = engine.createStandingBandCandidate();

    expect(candidate.clauses).toEqual([
      "Only appointments where you are the organizer and only attendee",
      "Only the start time may change; never cancel or change duration",
      "Only Monday–Friday, 09:00–17:00 America/Denver",
      "Never send a message or make a purchase",
      expect.stringContaining("At most 3 actions per rolling day"),
    ]);

    const { bandId } = await engine.approveStandingBand(
      candidate.candidateId,
      candidate.predicateHash,
    );
    const result = await engine.runStandingBand(bandId, standingFixture);

    expect(result).toMatchObject({
      status: "executed",
      receipt: { detail: "No messages were sent." },
    });
    expect(adapter.executions).toHaveLength(1);
    expect(adapter.executions[0]?.document.effects).toHaveLength(1);
  });

  it("falls back to a one-time Card for an adjacent but ineligible request", async () => {
    const { adapter, engine } = setup();
    const candidate = engine.createStandingBandCandidate();
    const { bandId } = await engine.approveStandingBand(
      candidate.candidateId,
      candidate.predicateHash,
    );

    const result = await engine.runStandingBand(bandId, adjacentFixture);

    expect(result).toMatchObject({
      status: "review_required",
      card: {
        title: "Here’s the deal",
        allows: ["move Dinner with Sarah to 7:30 PM"],
      },
    });
    expect(adapter.executions).toHaveLength(0);
  });

  it("rejects replay of a standing-Band approval candidate", async () => {
    const { engine } = setup();
    const candidate = engine.createStandingBandCandidate();
    await engine.approveStandingBand(candidate.candidateId, candidate.predicateHash);

    await expect(
      engine.approveStandingBand(candidate.candidateId, candidate.predicateHash),
    ).rejects.toMatchObject({
      code: "standing_candidate_not_approvable",
      statusCode: 409,
    });
  });
});

describe("proposal flood control", () => {
  it("pauses repeated agent proposals without affecting execution authority", async () => {
    const adapter = new FakeAdapter();
    let now = new Date("2026-07-13T18:00:00.000Z");
    const engine = new AuthorityEngine({
      store: new AuthorityStore(),
      adapter,
      now: () => new Date(now),
      proposalLimit: 2,
    });

    await engine.proposeFixture(fixture);
    now = new Date(now.getTime() + 1);
    await engine.proposeFixture(fixture);
    now = new Date(now.getTime() + 1);

    await expect(engine.proposeFixture(fixture)).rejects.toMatchObject({
      code: "proposal_flood",
      statusCode: 429,
    });
    expect(adapter.executions).toHaveLength(0);
  });
});
