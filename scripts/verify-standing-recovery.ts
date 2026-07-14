import assert from "node:assert/strict";
import type {
  Band,
  CalendarEvent,
  DraftDocument,
  HumanReceipt,
  Permit,
  Person,
} from "@bander/contracts";
import {
  AuthorityEngine,
  AuthorityStore,
  digestStandingRequest,
  type ExecutionAdapter,
} from "@bander/core";
import { buildBrokerApp } from "../apps/broker/src/app.js";
import { loadDraftFixtures } from "../apps/broker/src/fixtures.js";

const focusEvent: CalendarEvent = {
  id: "event-focus-block",
  title: "Focus block",
  startTime: "2026-07-15T10:00:00-06:00",
  endTime: "2026-07-15T11:00:00-06:00",
  timeZone: "America/Denver",
  organizerId: "person-owner",
  attendeeIds: ["person-owner"],
  revision: 1,
  etag: "event-focus-block-r1",
};

const dinnerEvent: CalendarEvent = {
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

class StandingRecoveryAdapter implements ExecutionAdapter {
  readonly events = new Map([
    [focusEvent.id, structuredClone(focusEvent)],
    [dinnerEvent.id, structuredClone(dinnerEvent)],
  ]);
  loseNextResponseAfterCommit = false;
  mutationCount = 0;
  reconciliationCount = 0;
  readonly operations = new Map<string, string>();

  async resolveEvent(id: string): Promise<CalendarEvent> {
    const event = this.events.get(id);
    if (!event) throw new Error("event_not_found");
    return structuredClone(event);
  }

  async resolvePerson(id: string): Promise<Person> {
    assert.equal(id, "person-sarah");
    return {
      id,
      displayName: "Sarah Chen",
      messageAddress: "+15550101002",
      revision: 1,
    };
  }

  async executeDraft(input: {
    draftHash: string;
    permitNonce: string;
    document: DraftDocument;
  }): Promise<void> {
    const existing = this.operations.get(input.permitNonce);
    if (existing !== undefined) {
      assert.equal(existing, input.draftHash);
      return;
    }
    const effect = input.document.effects[0];
    assert.equal(effect?.type, "calendar.reschedule_event");
    if (effect?.type !== "calendar.reschedule_event") return;
    const event = this.events.get(effect.eventId);
    assert.ok(event);
    assert.equal(event.etag, effect.expected.etag);
    const revision = event.revision + 1;
    this.events.set(event.id, {
      ...event,
      startTime: effect.changes.startTime,
      endTime: effect.changes.endTime,
      revision,
      etag: `${event.id}-r${revision}`,
    });
    this.mutationCount += 1;
    this.operations.set(input.permitNonce, input.draftHash);
    if (this.loseNextResponseAfterCommit) {
      this.loseNextResponseAfterCommit = false;
      throw new Error("response_lost_after_calendar_commit");
    }
  }

  async getExecution(input: { draftHash: string; permitNonce: string }): Promise<boolean> {
    this.reconciliationCount += 1;
    return this.operations.get(input.permitNonce) === input.draftHash;
  }
}

class CountingStore extends AuthorityStore {
  draftWrites = 0;
  permitWrites = 0;
  receiptWrites = 0;

  override saveDraft(draft: Parameters<AuthorityStore["saveDraft"]>[0]): void {
    this.draftWrites += 1;
    super.saveDraft(draft);
  }

  override savePermit(permit: Permit): void {
    this.permitWrites += 1;
    super.savePermit(permit);
  }

  override saveReceipt(receipt: HumanReceipt): void {
    this.receiptWrites += 1;
    super.saveReceipt(receipt);
  }
}

async function postJson<T>(baseUrl: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const text = await response.text();
  return { response, payload: (text ? JSON.parse(text) : undefined) as T };
}

async function createHarness(options?: { downstreamLoss?: boolean; brokerLoss?: boolean }) {
  const adapter = new StandingRecoveryAdapter();
  adapter.loseNextResponseAfterCommit = options?.downstreamLoss ?? false;
  const store = new CountingStore();
  let id = 0;
  let currentTime = new Date("2026-07-14T18:00:00.000Z");
  let dropBrokerResponse = options?.brokerLoss ?? false;
  const engine = new AuthorityEngine({
    store,
    adapter,
    now: () => new Date(currentTime),
    id: () => `standing-recovery-${++id}`,
  });
  const app = buildBrokerApp({
    engine,
    fixtures: loadDraftFixtures(),
    dropNextStandingRunResponseAfterCompletion: () => {
      if (!dropBrokerResponse) return false;
      dropBrokerResponse = false;
      return true;
    },
  });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const candidate = await postJson<{ candidateId: string; predicateHash: string }>(
    baseUrl,
    "/api/demo/standing-band-candidates",
  );
  assert.equal(candidate.response.status, 200);
  const standing = await postJson<{ bandId: string }>(
    baseUrl,
    `/api/standing-band-candidates/${candidate.payload.candidateId}/approve`,
    { predicateHash: candidate.payload.predicateHash },
  );
  assert.equal(standing.response.status, 200);
  return {
    adapter,
    app,
    baseUrl,
    bandId: standing.payload.bandId,
    engine,
    store,
    advance(milliseconds: number) {
      currentTime = new Date(currentTime.getTime() + milliseconds);
    },
  };
}

async function verifyLossMode(mode: "downstream" | "broker") {
  const harness = await createHarness({
    downstreamLoss: mode === "downstream",
    brokerLoss: mode === "broker",
  });
  try {
    const path = `/api/standing-bands/${harness.bandId}/run`;
    const body = {
      fixtureId: "move-my-focus-block",
      requestId: `standing-${mode}-request-0001`,
    };
    if (mode === "downstream") {
      const first = await postJson<{ error: { code: string } }>(harness.baseUrl, path, body);
      assert.equal(first.response.status, 500);
    } else {
      await assert.rejects(fetch(`${harness.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
    }

    const retry = await postJson<{ status: string; receipt: HumanReceipt }>(
      harness.baseUrl,
      path,
      body,
    );
    assert.equal(retry.response.status, 200, `${mode} retry must recover`);
    assert.equal(retry.payload.status, "executed");
    const repeated = await postJson<{ status: string; receipt: HumanReceipt }>(
      harness.baseUrl,
      path,
      body,
    );
    assert.equal(repeated.payload.receipt.id, retry.payload.receipt.id);
    assert.equal(harness.store.draftWrites, 1);
    assert.equal(harness.store.permitWrites, 1);
    assert.equal(harness.adapter.mutationCount, 1);
    assert.equal(harness.store.receiptWrites, 1);
    const band = harness.store.getBand(harness.bandId);
    assert.ok(band && band.mode === "standing");
    assert.equal(band.actionTimestamps.length, 1);
    return retry.payload.receipt.id;
  } finally {
    await harness.app.close();
  }
}

const downstreamReceipt = await verifyLossMode("downstream");
const brokerReceipt = await verifyLossMode("broker");

const changedContent = await createHarness();
try {
  const path = `/api/standing-bands/${changedContent.bandId}/run`;
  const requestId = "standing-content-binding-0001";
  const first = await postJson<{ status: string }>(changedContent.baseUrl, path, {
    fixtureId: "move-my-focus-block",
    requestId,
  });
  assert.equal(first.response.status, 200);
  const changed = await postJson<{ error: { code: string } }>(changedContent.baseUrl, path, {
    fixtureId: "move-dinner-under-standing-band",
    requestId,
  });
  assert.equal(changed.response.status, 409);
  assert.equal(changed.payload.error.code, "standing_request_mismatch");
  assert.equal(changedContent.store.draftWrites, 1);
  assert.equal(changedContent.store.permitWrites, 1);
  assert.equal(changedContent.adapter.mutationCount, 1);
} finally {
  await changedContent.app.close();
}

const reviewRequired = await createHarness();
try {
  const path = `/api/standing-bands/${reviewRequired.bandId}/run`;
  const body = {
    fixtureId: "move-dinner-under-standing-band",
    requestId: "standing-review-required-0001",
  };
  const first = await postJson<{
    status: string;
    card: { draftId: string; draftHash: string };
  }>(reviewRequired.baseUrl, path, body);
  const retry = await postJson<{
    status: string;
    card: { draftId: string; draftHash: string };
  }>(reviewRequired.baseUrl, path, body);
  assert.equal(first.payload.status, "review_required");
  assert.deepEqual(retry.payload, first.payload);
  assert.equal(reviewRequired.store.draftWrites, 1);
  assert.equal(reviewRequired.store.permitWrites, 0);
  assert.equal(reviewRequired.adapter.mutationCount, 0);
  assert.equal(reviewRequired.store.receiptWrites, 0);
  const band = reviewRequired.store.getBand(reviewRequired.bandId);
  assert.ok(band && band.mode === "standing");
  assert.equal(band.actionTimestamps.length, 0);
} finally {
  await reviewRequired.app.close();
}

const expired = await createHarness();
try {
  const fixtures = loadDraftFixtures();
  const fixture = fixtures.get("move-my-focus-block");
  assert.ok(fixture);
  const card = await expired.engine.proposeFixture(fixture, "standing-expiry-seed");
  const draft = expired.store.getDraft(card.draftId);
  assert.ok(draft);
  expired.store.updateDraft({ ...draft, status: "approved" });
  const permit: Permit = {
    id: "permit_standing_expired_0001",
    nonce: "standing-expired-nonce-0001",
    bandId: expired.bandId,
    draftId: draft.id,
    draftHash: draft.hash,
    executor: "bander_executor",
    expiresAt: "2026-07-14T18:00:30.000Z",
  };
  expired.store.savePermit(permit);
  const requestId = "standing-expired-request-0001";
  expired.store.saveStandingRequest({
    bandId: expired.bandId,
    requestId,
    requestDigest: digestStandingRequest(fixture),
    draftId: draft.id,
    status: "executing",
    createdAt: "2026-07-14T18:00:00.000Z",
    permitId: permit.id,
  });
  expired.advance(31_000);
  const result = await postJson<{ error: { code: string } }>(
    expired.baseUrl,
    `/api/standing-bands/${expired.bandId}/run`,
    { fixtureId: fixture.id, requestId },
  );
  assert.equal(result.response.status, 409);
  assert.equal(result.payload.error.code, "permit_expired");
  assert.equal(expired.adapter.mutationCount, 0);
  assert.equal(expired.store.draftWrites, 1);
  assert.equal(expired.store.permitWrites, 1);
  assert.equal(expired.store.receiptWrites, 0);
  const band = expired.store.getBand(expired.bandId);
  assert.ok(band && band.mode === "standing");
  assert.equal(band.actionTimestamps.length, 0);
} finally {
  await expired.app.close();
}

console.log(JSON.stringify({
  status: "recovered",
  downstreamReceipt,
  brokerReceipt,
  changedContent: "rejected",
  reviewRequired: "same_card",
  expiredUndispatched: "no_write",
  perScenario: {
    drafts: 1,
    permits: 1,
    mutations: 1,
    receipts: 1,
    counterEntries: 1,
  },
}, null, 2));
