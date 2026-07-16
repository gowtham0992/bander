import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { CalendarEvent, DraftDocument, ObservedExecutionResult, Person } from "@bander/contracts";
import { AuthorityEngine, AuthorityStore, ExecutionAmbiguousError, renderFamilyNotificationDocument, type ExecutionAdapter } from "@bander/core";
import { buildBrokerApp } from "./app.js";
import { loadDraftFixtures } from "./fixtures.js";

class NoopAdapter implements ExecutionAdapter {
  async resolveEvent(): Promise<CalendarEvent> { throw new Error("not used"); }
  async resolvePerson(): Promise<Person> { throw new Error("not used"); }
  async executeDraft(_input: { draftHash: string; permitNonce: string; document: DraftDocument }): Promise<void> { throw new Error("not used"); }
  async getExecution(): Promise<boolean> { return false; }
}

class SandboxAdapter implements ExecutionAdapter {
  executions = 0;
  familyUpdates: string[] = [];
  ambiguousNext = false;
  async resolveEvent(): Promise<CalendarEvent> {
    return { id: "event-demo-appointment", title: "Bander Demo Appointment", startTime: "2026-07-17T13:00:00-06:00", endTime: "2026-07-17T14:00:00-06:00", timeZone: "America/Denver", organizerId: "person-owner", attendeeIds: ["person-owner"], revision: 1, etag: "event-demo-appointment-r1" };
  }
  async resolvePerson(): Promise<Person> { throw new Error("not used"); }
  async executeDraft(input: { draftHash: string; permitNonce: string; document: DraftDocument }): Promise<ObservedExecutionResult> {
    this.executions += 1;
    if (this.ambiguousNext) { this.ambiguousNext = false; throw new ExecutionAmbiguousError(); }
    const calendar = input.document.effects.find((effect) => effect.type === "calendar.reschedule_event")!;
    const family = input.document.effects.find((effect) => effect.type === "family.telegram_notification")!;
    this.familyUpdates.push(renderFamilyNotificationDocument(family.document));
    return { calendar: { status: "committed", completed: { startTime: calendar.changes.startTime, endTime: calendar.changes.endTime, timeZone: calendar.expected.timeZone } }, familyNotification: { status: "delivered" } };
  }
  async getExecution(): Promise<boolean> { return false; }
}

describe("Checkpoint 6A deterministic sandbox", () => {
  it("schedule_read_sandbox_creates_zero_authority", async () => {
    const store = new AuthorityStore();
    const app = buildBrokerApp({
      engine: new AuthorityEngine({ store, adapter: new NoopAdapter() }),
      fixtures: loadDraftFixtures(),
      ...({ readDemoSchedule: async () => ({
        requestedRange: { startLocalDate: "2026-07-17", endLocalDateExclusive: "2026-07-18" },
        timeZone: "America/Denver",
        events: [{ title: "Dentist", allDay: false, start: { localDate: "2026-07-17", localTime: "09:00" }, end: { localDate: "2026-07-17", localTime: "10:00" } }],
        empty: false,
        truncated: false,
        maxEvents: 12,
      }) } as object),
    } as Parameters<typeof buildBrokerApp>[0]);
    const saveDraft = vi.spyOn(store, "saveDraft");
    const saveBand = vi.spyOn(store, "saveBand");
    const savePermit = vi.spyOn(store, "savePermit");
    const saveReceipt = vi.spyOn(store, "saveReceipt");
    const response = await app.inject({ method: "GET", url: "/api/demo/schedule/tomorrow" });
    expect(response.statusCode).toBe(200);
    expect(saveDraft).not.toHaveBeenCalled();
    expect(saveBand).not.toHaveBeenCalled();
    expect(savePermit).not.toHaveBeenCalled();
    expect(saveReceipt).not.toHaveBeenCalled();
    await app.close();
  });

  it("sandbox_compound_uses_family_notification_not_legacy_message", () => {
    const fixture = loadDraftFixtures().get("move-demo-appointment-and-notify-gil");
    expect(fixture?.familyNotification).toBeDefined();
    expect(fixture?.message).toBeUndefined();
  });

  it("sandbox_card_text_equals_family_phone_text_and_replay_is_safe", async () => {
    const adapter = new SandboxAdapter();
    const engine = new AuthorityEngine({ store: new AuthorityStore(), adapter, now: () => new Date("2026-07-16T18:00:00.000Z") });
    const fixture = loadDraftFixtures().get("move-demo-appointment-and-notify-gil")!;
    const card = await engine.proposeFixture(fixture);
    const preview = card.effectPreviews.find((effect) => effect.kind === "family.telegram_notification")!;
    const first = await engine.approveAndExecute(card.draftId, card.draftHash);
    const replay = await engine.approveAndExecute(card.draftId, card.draftHash);
    expect(preview.kind === "family.telegram_notification" && preview.body).toBe(adapter.familyUpdates[0]);
    expect(first.familyNotification?.body).toBe(adapter.familyUpdates[0]);
    expect(replay.id).toBe(first.id);
    expect(adapter.executions).toBe(1);
    expect(adapter.familyUpdates).toHaveLength(1);
  });

  it("sandbox_ambiguous_outcome_never_says_nothing_changed_and_sends_no_family_update", async () => {
    const adapter = new SandboxAdapter();
    const engine = new AuthorityEngine({ store: new AuthorityStore(), adapter, now: () => new Date("2026-07-16T18:00:00.000Z") });
    const fixtures = loadDraftFixtures();
    const app = buildBrokerApp({ engine, fixtures, prepareAmbiguousCalendarOutcome: () => { adapter.ambiguousNext = true; } });
    const proposed = await app.inject({ method: "POST", url: "/api/demo/proposals", payload: { fixtureId: "move-demo-appointment-and-notify-gil" } });
    const card = proposed.json<{ draftId: string; draftHash: string }>();
    const approve = () => app.inject({ method: "POST", url: `/api/demo/drafts/${card.draftId}/approve-ambiguous`, payload: { draftHash: card.draftHash } });
    const first = await approve();
    const replay = await approve();
    expect(first.json().message).not.toContain("nothing changed");
    expect(first.json().message).toContain("No family update was sent.");
    expect(replay.json()).toEqual(first.json());
    expect(adapter.executions).toBe(1);
    expect(adapter.familyUpdates).toHaveLength(0);
    await app.close();
  });

  it("sandbox_is_visibly_labelled_seeded_and_not_live", () => {
    const source = readFileSync(new URL("../../web/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain("Deterministic sandbox — uses seeded data and does not connect to Google, Telegram, or OpenAI.");
  });
});
