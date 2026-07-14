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

class RecoveryCalendarAdapter implements ExecutionAdapter {
  event = structuredClone(focusEvent);
  loseNextResponseAfterCommit = true;
  mutationCount = 0;
  reconciliationCount = 0;
  readonly operations = new Map<string, string>();

  async resolveEvent(id: string): Promise<CalendarEvent> {
    assert.equal(id, this.event.id);
    return structuredClone(this.event);
  }

  async resolvePerson(_id: string): Promise<Person> {
    throw new Error("The Calendar-only recovery fixture resolves no person");
  }

  async executeDraft(input: {
    draftHash: string;
    permitNonce: string;
    document: DraftDocument;
  }): Promise<void> {
    const existingHash = this.operations.get(input.permitNonce);
    if (existingHash !== undefined) {
      assert.equal(existingHash, input.draftHash);
      return;
    }

    const effect = input.document.effects[0];
    assert.equal(effect?.type, "calendar.reschedule_event");
    if (effect?.type !== "calendar.reschedule_event") return;
    assert.equal(this.event.etag, effect.expected.etag);

    this.event = {
      ...this.event,
      startTime: effect.changes.startTime,
      endTime: effect.changes.endTime,
      revision: this.event.revision + 1,
      etag: `${this.event.id}-r${this.event.revision + 1}`,
    };
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

class CountingAuthorityStore extends AuthorityStore {
  oneTimeBandWrites = 0;
  permitWrites = 0;
  receiptWrites = 0;
  lastPermitId: string | undefined;

  override saveBand(band: Band): void {
    if (band.mode === "one_time") this.oneTimeBandWrites += 1;
    super.saveBand(band);
  }

  override savePermit(permit: Permit): void {
    this.permitWrites += 1;
    this.lastPermitId = permit.id;
    super.savePermit(permit);
  }

  override saveReceipt(receipt: HumanReceipt): void {
    this.receiptWrites += 1;
    super.saveReceipt(receipt);
  }
}

async function postJson<T>(baseUrl: string, path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as T;
  return { response, payload };
}

const adapter = new RecoveryCalendarAdapter();
const store = new CountingAuthorityStore();
let id = 0;
const engine = new AuthorityEngine({
  store,
  adapter,
  now: () => new Date("2026-07-14T18:00:00.000Z"),
  id: () => `http-recovery-${++id}`,
});
const app = buildBrokerApp({
  engine,
  fixtures: loadDraftFixtures(),
});

try {
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const proposal = await postJson<{ draftId: string; draftHash: string }>(
    baseUrl,
    "/api/demo/proposals",
    { fixtureId: "move-my-focus-block" },
  );
  assert.equal(proposal.response.status, 200);

  const approvalPath = `/api/drafts/${proposal.payload.draftId}/approve`;
  const approvalBody = { draftHash: proposal.payload.draftHash };
  const first = await postJson<{ error: { code: string } }>(
    baseUrl,
    approvalPath,
    approvalBody,
  );
  assert.equal(first.response.status, 500);
  assert.equal(first.payload.error.code, "internal_error");

  const retry = await postJson<HumanReceipt>(baseUrl, approvalPath, approvalBody);
  assert.equal(retry.response.status, 200, "same-hash approval retry must reconcile");
  const repeated = await postJson<HumanReceipt>(baseUrl, approvalPath, approvalBody);
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.payload.id, retry.payload.id);

  assert.equal(adapter.mutationCount, 1, "Calendar must mutate exactly once");
  assert.equal(adapter.operations.size, 1, "exactly one downstream operation must exist");
  assert.equal(adapter.reconciliationCount, 1, "the ambiguous operation must reconcile once");
  assert.equal(store.oneTimeBandWrites, 1, "retry must not mint another Band");
  assert.equal(store.permitWrites, 1, "retry must not mint another Permit");
  assert.equal(store.receiptWrites, 1, "retries must return one truthful Receipt");
  assert.ok(store.lastPermitId);
  const permit = store.getPermit(store.lastPermitId);
  assert.ok(permit?.consumedAt, "the internal Permit must be consumed");
  assert.equal(permit.receiptId, retry.payload.id);

  console.log(
    JSON.stringify(
      {
        status: "recovered",
        calendarMutations: adapter.mutationCount,
        bandsMinted: store.oneTimeBandWrites,
        permitsMinted: store.permitWrites,
        receiptsCreated: store.receiptWrites,
        receiptId: retry.payload.id,
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
}
