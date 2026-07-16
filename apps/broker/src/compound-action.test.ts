import { describe, expect, it } from "vitest";
import { AuthorityEngine, AuthorityStore, type DraftFixture, type ExecutionAdapter } from "@bander/core";
import type { CalendarEvent, DraftDocument } from "@bander/contracts";
import {
  CompoundExecutionAdapter,
  compoundDeliveryRequestId,
  type BoundFamilyNotificationDelivery,
} from "./compound-action.js";
import { renderFamilyNotification } from "./family-notification.js";

const event: CalendarEvent = {
  id: "event-1",
  title: "Bander Demo Appointment",
  startTime: "2026-07-17T19:00:00.000Z",
  endTime: "2026-07-17T20:00:00.000Z",
  timeZone: "America/Denver",
  organizerId: "google-primary-owner",
  attendeeIds: [],
  revision: 1,
  etag: '"etag-1"',
};

const document = {
  kind: "calendar_transition" as const,
  eventTitle: "Bander Demo Appointment",
  newStartTime: "2026-07-18T22:00:00.000Z",
  newEndTime: "2026-07-18T23:00:00.000Z",
  timeZone: "America/Denver",
};

function fixture(): DraftFixture {
  return {
    id: "compound",
    claimedUserRequest:
      "Move Bander Demo Appointment to July 18 at 4 PM and let my son know.",
    calendar: {
      eventId: event.id,
      expectedEtag: event.etag,
      newStartTime: document.newStartTime,
    },
    familyNotification: {
      installationId: "installation-opaque",
      contactId: "contact-opaque",
      pairingRevision: "a".repeat(64),
      displayLabel: "Gil",
      document,
    },
  };
}

class CalendarAdapter implements ExecutionAdapter {
  executions = 0;
  conflict = false;
  failure = false;
  loseResponseAfterCommit = false;
  order: string[] = [];
  async resolveEvent() { return structuredClone(event); }
  async resolvePerson(): Promise<never> { throw new Error("unused"); }
  async executeDraft(_input: { draftHash: string; permitNonce: string; document: DraftDocument }) {
    this.order.push("calendar");
    if (this.conflict) {
      const { ExecutionConflictError } = await import("@bander/core");
      throw new ExecutionConflictError();
    }
    if (this.failure) throw new Error("calendar unavailable");
    this.executions += 1;
    const result = {
      calendar: {
        status: "committed" as const,
        completed: {
          startTime: document.newStartTime,
          endTime: document.newEndTime,
          timeZone: document.timeZone,
        },
      },
    };
    if (this.loseResponseAfterCommit) throw new Error("compound response lost");
    return result;
  }
  async getExecution() {
    return this.executions > 0
      ? {
          calendar: {
            status: "observed_target" as const,
            completed: {
              startTime: document.newStartTime,
              endTime: document.newEndTime,
              timeZone: document.timeZone,
            },
          },
        }
      : false;
  }
}

function setup(status: "delivered" | "ambiguous" = "delivered") {
  const calendar = new CalendarAdapter();
  const sends: BoundFamilyNotificationDelivery[] = [];
  const adapter = new CompoundExecutionAdapter({
    calendar,
    deliver: async (input) => {
      calendar.order.push("notification");
      sends.push(structuredClone(input));
      return { status };
    },
  });
  const engine = new AuthorityEngine({
    store: new AuthorityStore(),
    adapter,
    now: () => new Date("2026-07-16T18:00:00.000Z"),
    id: (() => {
      let value = 0;
      return () => `id-${++value}`;
    })(),
  });
  return { calendar, sends, engine };
}

describe("real compound Calendar and family notification deal", () => {
  it("compound_replay_reuses_the_same_delivery_identity", () => {
    const first = compoundDeliveryRequestId("draft-hash", "permit-nonce");
    const replay = compoundDeliveryRequestId("draft-hash", "permit-nonce");
    expect(replay).toBe(first);
    expect(compoundDeliveryRequestId("changed-hash", "permit-nonce")).not.toBe(first);
  });
  it("compound_request_creates_one_card_with_two_effects", async () => {
    const { engine } = setup();
    const card = await engine.proposeFixture(fixture());
    expect(card.effectPreviews).toHaveLength(2);
    expect(card.effectPreviews[1]).toMatchObject({
      kind: "family.telegram_notification",
      recipientDisplayName: "Gil",
      body: renderFamilyNotification(document),
    });
  });

  it("compound_draft_binds_exact_contact_pairing_at_proposal", async () => {
    const { engine } = setup();
    const card = await engine.proposeFixture(fixture());
    const stored = engine.getCard(card.draftId);
    expect(stored.draftHash).toBe(card.draftHash);
    expect(JSON.stringify(stored)).not.toContain("telegramUserId");
    expect(JSON.stringify(stored)).not.toContain("privateChatId");
  });

  it("card_notification_text_equals_delivered_text", async () => {
    const { engine, sends } = setup();
    const card = await engine.proposeFixture(fixture());
    await engine.approveAndExecute(card.draftId, card.draftHash);
    const preview = card.effectPreviews[1];
    expect(preview?.kind).toBe("family.telegram_notification");
    if (preview?.kind !== "family.telegram_notification") throw new Error("missing preview");
    expect(preview.body).toBe(renderFamilyNotification(sends[0]!.document));
  });

  it("calendar_conflict_sends_zero_family_messages", async () => {
    const { engine, calendar, sends } = setup();
    calendar.conflict = true;
    const card = await engine.proposeFixture(fixture());
    await expect(engine.approveAndExecute(card.draftId, card.draftHash)).rejects.toMatchObject({ code: "conflict" });
    expect(sends).toHaveLength(0);
    expect(calendar.order).toEqual(["calendar"]);
  });

  it("calendar_failure_sends_zero_family_messages", async () => {
    const { engine, calendar, sends } = setup();
    calendar.failure = true;
    const card = await engine.proposeFixture(fixture());
    await expect(engine.approveAndExecute(card.draftId, card.draftHash)).rejects.toThrow("calendar unavailable");
    expect(sends).toHaveLength(0);
    expect(calendar.order).toEqual(["calendar"]);
  });

  it("successful_compound_approval_mutates_once_and_sends_once", async () => {
    const { engine, calendar, sends } = setup();
    const card = await engine.proposeFixture(fixture());
    const receipt = await engine.approveAndExecute(card.draftId, card.draftHash);
    expect(calendar.executions).toBe(1);
    expect(sends).toHaveLength(1);
    expect(calendar.order).toEqual(["calendar", "notification"]);
    expect(receipt.familyNotification).toMatchObject({ status: "delivered", recipientDisplayName: "Gil" });
  });

  it("confirmed_compound_replay_mutates_nothing_and_sends_nothing", async () => {
    const { engine, calendar, sends } = setup();
    const card = await engine.proposeFixture(fixture());
    const first = await engine.approveAndExecute(card.draftId, card.draftHash);
    const replay = await engine.approveAndExecute(card.draftId, card.draftHash);
    expect(replay).toEqual(first);
    expect(calendar.executions).toBe(1);
    expect(sends).toHaveLength(1);
  });

  it("concurrent_compound_approval_mutates_once_and_sends_once", async () => {
    const { engine, calendar, sends } = setup();
    const card = await engine.proposeFixture(fixture());
    const [first, second] = await Promise.all([
      engine.approveAndExecute(card.draftId, card.draftHash),
      engine.approveAndExecute(card.draftId, card.draftHash),
    ]);
    expect(second).toEqual(first);
    expect(calendar.executions).toBe(1);
    expect(sends).toHaveLength(1);
  });

  it("ambiguous_family_delivery_produces_truthful_partial_receipt", async () => {
    const { engine } = setup("ambiguous");
    const card = await engine.proposeFixture(fixture());
    const receipt = await engine.approveAndExecute(card.draftId, card.draftHash);
    expect(receipt.familyNotification?.status).toBe("ambiguous");
    expect(receipt.detail).toContain("could not confirm");
    expect(receipt.detail).not.toContain("was notified");
  });

  it("ambiguous_family_delivery_is_never_retried", async () => {
    const { engine, calendar, sends } = setup("ambiguous");
    const card = await engine.proposeFixture(fixture());
    const first = await engine.approveAndExecute(card.draftId, card.draftHash);
    const replay = await engine.approveAndExecute(card.draftId, card.draftHash);
    expect(replay).toEqual(first);
    expect(calendar.executions).toBe(1);
    expect(sends).toHaveLength(1);
  });

  it("committed_calendar_with_lost_compound_response_resumes_bound_delivery_once", async () => {
    const { engine, calendar, sends } = setup();
    calendar.loseResponseAfterCommit = true;
    const card = await engine.proposeFixture(fixture());
    await expect(engine.approveAndExecute(card.draftId, card.draftHash)).rejects.toThrow("compound response lost");
    calendar.loseResponseAfterCommit = false;
    const receipt = await engine.approveAndExecute(card.draftId, card.draftHash);
    expect(receipt.familyNotification?.status).toBe("delivered");
    expect(calendar.executions).toBe(1);
    expect(sends).toHaveLength(1);
  });

  it("changed_hash_cannot_reuse_compound_execution", async () => {
    const { engine, calendar, sends } = setup();
    const card = await engine.proposeFixture(fixture());
    await expect(engine.approveAndExecute(card.draftId, "0".repeat(64))).rejects.toMatchObject({ code: "draft_hash_mismatch" });
    expect(calendar.executions).toBe(0);
    expect(sends).toHaveLength(0);
  });
});
