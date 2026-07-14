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
  invalidInterval = false;
  loseNextResponseAfterCommit = false;
  failNextBeforeCommit = false;
  reconciliations = 0;
  readonly outcomes = new Map<string, { draftHash: string; operationKey: string }>();
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
    return this.invalidInterval
      ? { ...structuredClone(event), endTime: event.startTime }
      : structuredClone(event);
  }

  async resolvePerson(): Promise<Person> {
    return structuredClone(person);
  }

  async executeDraft(input: {
    draftHash: string;
    permitNonce: string;
    document: DraftDocument;
  }): Promise<void> {
    if (this.failNextBeforeCommit) {
      this.failNextBeforeCommit = false;
      throw new Error("connection_lost_before_commit");
    }
    if (this.outcomes.has(input.permitNonce)) return;
    this.executions.push(structuredClone(input));
    this.outcomes.set(input.permitNonce, {
      draftHash: input.draftHash,
      operationKey: input.permitNonce,
    });
    if (this.loseNextResponseAfterCommit) {
      this.loseNextResponseAfterCommit = false;
      throw new Error("response_lost_after_commit");
    }
  }

  async getExecution(input: { draftHash: string; permitNonce: string }) {
    this.reconciliations += 1;
    const outcome = this.outcomes.get(input.permitNonce);
    return outcome?.draftHash === input.draftHash;
  }
}

function setup(now = "2026-07-13T18:00:00.000Z") {
  const adapter = new FakeAdapter();
  let id = 0;
  let currentTime = new Date(now);
  const store = new AuthorityStore();
  const engine = new AuthorityEngine({
    store,
    adapter,
    now: () => new Date(currentTime),
    id: () => `test-${++id}`,
  });
  return {
    adapter,
    engine,
    store,
    advance(milliseconds: number) {
      currentTime = new Date(currentTime.getTime() + milliseconds);
    },
  };
}

describe("one-time Draft, Card, Band, Permit, Receipt", () => {
  it("recovers a committed Calendar-only operation after its response is lost", async () => {
    const { adapter, advance, engine, store } = setup();
    const card = await engine.proposeFixture(standingFixture);
    const authorization = await engine.approve(card.draftId, card.draftHash);
    adapter.loseNextResponseAfterCommit = true;

    await expect(engine.executePermit(authorization.permitId)).rejects.toThrow(
      "response_lost_after_commit",
    );
    advance(31_000);
    const receipt = await engine.executePermit(authorization.permitId);

    expect(adapter.executions).toHaveLength(1);
    expect(adapter.reconciliations).toBe(1);
    expect(store.getPermit(authorization.permitId)?.consumedAt).toBeDefined();
    expect(receipt.summary).toContain("10:30–11:30 AM");
    expect(engine.getAgentReceipt(card.draftId).status).toBe("executed");
  });

  it("does not dispatch a missing operation after the Permit expires", async () => {
    const { adapter, advance, engine } = setup();
    const card = await engine.proposeFixture(standingFixture);
    const authorization = await engine.approve(card.draftId, card.draftHash);
    adapter.failNextBeforeCommit = true;

    await expect(engine.executePermit(authorization.permitId)).rejects.toThrow(
      "connection_lost_before_commit",
    );
    advance(31_000);

    await expect(engine.executePermit(authorization.permitId)).rejects.toMatchObject({
      code: "permit_expired",
    });
    expect(adapter.executions).toHaveLength(0);
    expect(adapter.reconciliations).toBe(1);
  });

  it("gives identical simultaneous proposals distinct Draft IDs", async () => {
    const { engine } = setup();

    const first = await engine.proposeFixture(fixture);
    const second = await engine.proposeFixture(fixture);

    expect(first.draftId).not.toBe(second.draftId);
    expect(first.draftHash).toBe(second.draftHash);
  });

  it("shows the complete old and new Calendar intervals on the Card", async () => {
    const { engine } = setup();

    const card = await engine.proposeFixture(fixture);

    expect(card.allows[0]).toBe(
      "reschedule “Dinner with Sarah” from 7:00–8:30 PM to 7:30–9:00 PM",
    );
  });

  it("stores the duration-preserving interval in the hashed Draft", async () => {
    const { adapter, engine } = setup();
    const card = await engine.proposeFixture(fixture);

    await engine.approveAndExecute(card.draftId, card.draftHash);

    expect(adapter.executions[0]?.document.effects[0]).toMatchObject({
      type: "calendar.reschedule_event",
      changes: {
        startTime: "2026-07-14T19:30:00-06:00",
        endTime: "2026-07-15T03:00:00.000Z",
      },
    });
  });

  it("repeats the completed Calendar interval on the Receipt", async () => {
    const { engine } = setup();
    const card = await engine.proposeFixture(fixture);

    const receipt = await engine.approveAndExecute(card.draftId, card.draftHash);

    expect(receipt.summary).toBe(
      "Completed as agreed: “Dinner with Sarah” moved from 7:00–8:30 PM to 7:30–9:00 PM.",
    );
  });

  it("rejects a Calendar event whose stored interval is invalid", async () => {
    const { adapter, engine } = setup();
    adapter.invalidInterval = true;

    await expect(engine.proposeFixture(fixture)).rejects.toMatchObject({
      code: "invalid_calendar_interval",
      statusCode: 422,
    });
  });

  it("keeps agent text in a provenance-labelled Card field", async () => {
    const { engine } = setup();
    const card = await engine.proposeFixture(fixture);

    expect(card.title).toBe("Here’s the deal");
    expect(card.provenanceLabel).toBe("Your agent says your request was:");
    expect(card.claimedUserRequest).toBe(fixture.claimedUserRequest);
    expect(card.allows).toEqual([
      "reschedule “Dinner with Sarah” from 7:00–8:30 PM to 7:30–9:00 PM",
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
            type: "calendar.reschedule_event",
            eventId: "event-dinner-sarah",
            changes: {
              startTime: "2026-07-14T19:30:00-06:00",
              endTime: "2026-07-15T03:00:00.000Z",
            },
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
      summary:
        "Completed as agreed: “Dinner with Sarah” moved from 7:00–8:30 PM to 7:30–9:00 PM.",
      detail: "Sarah was notified.",
    });
    expect(engine.getAgentReceipt(card.draftId)).toEqual({
      draftId: card.draftId,
      status: "executed",
    });

    const repeatedReceipt = await engine.approveAndExecute(card.draftId, card.draftHash);
    expect(repeatedReceipt.id).toBe(receipt.id);
    expect(adapter.executions).toHaveLength(1);
  });

  it("rejects a different hash when resuming existing authority", async () => {
    const { adapter, engine } = setup();
    const card = await engine.proposeFixture(standingFixture);
    const authorization = await engine.approve(card.draftId, card.draftHash);
    adapter.loseNextResponseAfterCommit = true;
    await expect(engine.executePermit(authorization.permitId)).rejects.toThrow(
      "response_lost_after_commit",
    );

    await expect(
      engine.approveAndExecute(card.draftId, "0".repeat(64)),
    ).rejects.toMatchObject({ code: "draft_hash_mismatch" });
    expect(adapter.executions).toHaveLength(1);
  });

  it("does not resume a declined Draft", async () => {
    const { adapter, engine } = setup();
    const card = await engine.proposeFixture(standingFixture);
    engine.decline(card.draftId);

    await expect(
      engine.approveAndExecute(card.draftId, card.draftHash),
    ).rejects.toMatchObject({ code: "draft_not_resumable" });
    expect(adapter.executions).toHaveLength(0);
  });

  it("does not resume a revoked Draft", async () => {
    const { adapter, engine } = setup();
    const card = await engine.proposeFixture(standingFixture);
    const authorization = await engine.approve(card.draftId, card.draftHash);
    await engine.revokeBand(authorization.bandId);

    await expect(
      engine.approveAndExecute(card.draftId, card.draftHash),
    ).rejects.toMatchObject({ code: "draft_not_resumable" });
    expect(adapter.executions).toHaveLength(0);
  });

  it("does not resume a conflicted Draft", async () => {
    const { adapter, engine, store } = setup();
    const card = await engine.proposeFixture(standingFixture);
    await engine.approve(card.draftId, card.draftHash);
    const draft = store.getDraft(card.draftId);
    expect(draft).toBeDefined();
    store.updateDraft({ ...draft!, status: "conflict" });

    await expect(
      engine.approveAndExecute(card.draftId, card.draftHash),
    ).rejects.toMatchObject({ code: "draft_not_resumable" });
    expect(adapter.executions).toHaveLength(0);
  });

  it("does not redispatch an uncommitted operation after its Permit expires", async () => {
    const { adapter, advance, engine } = setup();
    const card = await engine.proposeFixture(standingFixture);
    adapter.failNextBeforeCommit = true;
    await expect(
      engine.approveAndExecute(card.draftId, card.draftHash),
    ).rejects.toThrow("connection_lost_before_commit");
    advance(31_000);

    await expect(
      engine.approveAndExecute(card.draftId, card.draftHash),
    ).rejects.toMatchObject({ code: "permit_expired" });
    expect(adapter.executions).toHaveLength(0);
    expect(adapter.reconciliations).toBe(1);
  });

  it("does not initiate an undispatched operation after its Permit expires", async () => {
    const { adapter, advance, engine } = setup();
    const card = await engine.proposeFixture(standingFixture);
    await engine.approve(card.draftId, card.draftHash);
    advance(31_000);

    await expect(
      engine.approveAndExecute(card.draftId, card.draftHash),
    ).rejects.toMatchObject({ code: "permit_expired" });
    expect(adapter.executions).toHaveLength(0);
    expect(adapter.reconciliations).toBe(0);
  });
});

describe("standing Bands", () => {
  it("resumes a committed standing request and returns one cached Receipt", async () => {
    const { adapter, engine, store } = setup();
    const candidate = engine.createStandingBandCandidate();
    const { bandId } = await engine.approveStandingBand(
      candidate.candidateId,
      candidate.predicateHash,
    );
    const requestId = "standing-core-recovery-0001";
    adapter.loseNextResponseAfterCommit = true;

    await expect(
      engine.runStandingBand(bandId, standingFixture, requestId),
    ).rejects.toThrow("response_lost_after_commit");
    const recovered = await engine.runStandingBand(bandId, standingFixture, requestId);
    const repeated = await engine.runStandingBand(bandId, standingFixture, requestId);

    expect(recovered).toMatchObject({ status: "executed" });
    expect(repeated).toEqual(recovered);
    expect(adapter.executions).toHaveLength(1);
    expect(adapter.reconciliations).toBe(1);
    const band = store.getBand(bandId);
    expect(band?.mode).toBe("standing");
    if (!band || band.mode !== "standing") throw new Error("Expected standing Band");
    expect(band.actionTimestamps).toHaveLength(1);
    expect(store.getStandingRequest(bandId, requestId)).toMatchObject({
      status: "executed",
      receiptId:
        recovered.status === "executed" ? recovered.receipt.id : "unexpected",
    });
  });

  it("returns the same review Card for a repeated standing request", async () => {
    const { adapter, engine, store } = setup();
    const candidate = engine.createStandingBandCandidate();
    const { bandId } = await engine.approveStandingBand(
      candidate.candidateId,
      candidate.predicateHash,
    );
    const requestId = "standing-core-review-0001";

    const first = await engine.runStandingBand(bandId, adjacentFixture, requestId);
    const retry = await engine.runStandingBand(bandId, adjacentFixture, requestId);

    expect(retry).toEqual(first);
    expect(first.status).toBe("review_required");
    expect(adapter.executions).toHaveLength(0);
    expect(store.getStandingRequest(bandId, requestId)).toMatchObject({
      status: "review_required",
    });
  });

  it("renders the exact predicate and executes only an eligible calendar move", async () => {
    const { adapter, engine } = setup();
    const candidate = engine.createStandingBandCandidate();

    expect(candidate.clauses).toEqual([
      "Only appointments where you are the organizer and only attendee",
      "Only reschedule the complete appointment; never cancel or change duration",
      "The resulting appointment must start and finish Monday–Friday between 09:00 and 17:00 America/Denver",
      "Never send a message or make a purchase",
      expect.stringContaining("At most 3 actions per rolling day"),
    ]);

    const { bandId } = await engine.approveStandingBand(
      candidate.candidateId,
      candidate.predicateHash,
    );
    const result = await engine.runStandingBand(
      bandId,
      standingFixture,
      "standing-test-eligible-0001",
    );

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

    const result = await engine.runStandingBand(
      bandId,
      adjacentFixture,
      "standing-test-adjacent-0001",
    );

    expect(result).toMatchObject({
      status: "review_required",
      card: {
        title: "Here’s the deal",
        allows: [
          "reschedule “Dinner with Sarah” from 7:00–8:30 PM to 7:30–9:00 PM",
        ],
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

  it("falls back to review when the resulting appointment ends after 5 PM", async () => {
    const { adapter, engine } = setup();
    const candidate = engine.createStandingBandCandidate();
    const { bandId } = await engine.approveStandingBand(
      candidate.candidateId,
      candidate.predicateHash,
    );
    const lateFixture: DraftFixture = {
      ...standingFixture,
      calendar: {
        ...standingFixture.calendar,
        newStartTime: "2026-07-15T16:30:00-06:00",
      },
    };

    const result = await engine.runStandingBand(
      bandId,
      lateFixture,
      "standing-test-late-0001",
    );

    expect(result.status).toBe("review_required");
    expect(adapter.executions).toHaveLength(0);
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
