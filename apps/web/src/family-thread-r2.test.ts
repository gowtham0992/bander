import { describe, expect, it } from "vitest";
import type { ApprovalCard, DemoSandboxState } from "@bander/contracts";
import { BrowserDemoBackend } from "./backend/browser.js";
import { R2_PRESENTATION_BEAT_MS, familyThreadWorldPresentation, reduceFamilyThread } from "./family-thread-state.js";

const post = (body: Record<string, unknown> = {}): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
});

async function body<T>(backend: BrowserDemoBackend, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  return backend.request<T>(path, init);
}

describe("R2 Cross, Return, Hold state grammar", () => {
  it("does not advance the compound suggestion without its visitor event", () => {
    const confirmed = { stage: "email_confirmed" } as const;
    expect(reduceFamilyThread(confirmed, { type: "time_elapsed", milliseconds: 30_000 })).toEqual(confirmed);
    expect(reduceFamilyThread(confirmed, { type: "prepare_compound" })).toEqual({ stage: "compound_preparing" });
  });

  it("crosses Calendar before the phone and uses a presentation-only 400ms beat", () => {
    const waiting = { stage: "compound_waiting" } as const;
    const calendar = reduceFamilyThread(waiting, { type: "compound_backend_confirmed" });
    expect(calendar).toEqual({ stage: "compound_calendar_crossed" });
    expect(familyThreadWorldPresentation(calendar.stage)).toEqual({ calendar: "confirmed", phone: "quiet" });
    expect(reduceFamilyThread(calendar, { type: "compound_phone_presented" })).toEqual({ stage: "compound_confirmed" });
    expect(familyThreadWorldPresentation("compound_confirmed")).toEqual({ calendar: "confirmed", phone: "confirmed" });
    expect(R2_PRESENTATION_BEAT_MS).toBe(400);
  });

  it("returns a changed-world deal without any success state", () => {
    const returned = reduceFamilyThread({ stage: "conflict_waiting" }, { type: "conflict_returned" });
    expect(returned).toEqual({ stage: "conflict_returned" });
    expect(returned.stage).not.toMatch(/confirmed|crossed/);
    expect(familyThreadWorldPresentation(returned.stage)).toEqual({ calendar: "quiet", phone: "quiet" });
  });

  it("holds an ambiguous deal without calling it confirmed or unchanged", () => {
    const held = reduceFamilyThread({ stage: "uncertainty_waiting" }, { type: "uncertainty_held" });
    expect(held).toEqual({ stage: "uncertainty_held" });
    expect(held.stage).not.toMatch(/confirmed|unchanged|crossed/);
    expect(familyThreadWorldPresentation(held.stage)).toEqual({ calendar: "unconfirmed", phone: "quiet" });
    expect(reduceFamilyThread(held, { type: "time_elapsed", milliseconds: 30_000 })).toEqual(held);
  });
});

describe("R2 reuses existing deterministic authority paths", () => {
  it("prepares one compound Card whose delivered family text stays byte-identical and replay-safe", async () => {
    const backend = new BrowserDemoBackend();
    const proposed = await body<ApprovalCard>(backend, "/api/demo/proposals", post({ fixtureId: "add-dr-rao-appointment-and-notify-gil" }));
    expect(proposed.status).toBe(200);
    expect(proposed.body.effectPreviews.map((effect) => effect.kind)).toEqual(["calendar.create_event", "family.telegram_notification"]);
    const preview = proposed.body.effectPreviews.find((effect) => effect.kind === "family.telegram_notification");
    const approved = await body(backend, `/api/drafts/${proposed.body.draftId}/approve`, post({ draftHash: proposed.body.draftHash }));
    expect(approved.status).toBe(200);
    const after = await body<DemoSandboxState>(backend, "/api/demo/state");
    expect(after.body.calendar.filter((event) => event.title === "Appointment with Dr. Rao")).toHaveLength(1);
    expect(after.body.familyUpdates).toHaveLength(1);
    expect(after.body.familyUpdates[0]?.body).toBe(preview?.body);
    await body(backend, `/api/drafts/${proposed.body.draftId}/approve`, post({ draftHash: proposed.body.draftHash }));
    const replayed = await body<DemoSandboxState>(backend, "/api/demo/state");
    expect(replayed.body.calendar.filter((event) => event.title === "Appointment with Dr. Rao")).toHaveLength(1);
    expect(replayed.body.familyUpdates).toHaveLength(1);
  });

  it("declines the compound Card with zero Calendar and family effects", async () => {
    const backend = new BrowserDemoBackend();
    const before = await body<DemoSandboxState>(backend, "/api/demo/state");
    const proposed = await body<ApprovalCard>(backend, "/api/demo/proposals", post({ fixtureId: "add-dr-rao-appointment-and-notify-gil" }));
    await body(backend, `/api/drafts/${proposed.body.draftId}/decline`, post());
    const after = await body<DemoSandboxState>(backend, "/api/demo/state");
    expect(after.body.calendar).toEqual(before.body.calendar);
    expect(after.body.familyUpdates).toEqual([]);
  });

  it("uses the existing changed-world cancellation path with zero Bander effects", async () => {
    const backend = new BrowserDemoBackend();
    const proposed = await body<ApprovalCard>(backend, "/api/demo/proposals", post({ fixtureId: "cancel-dentist-and-notify-gil" }));
    const conflict = await body(backend, `/api/demo/drafts/${proposed.body.draftId}/approve-after-cancel-calendar-change`, post({ draftHash: proposed.body.draftHash }));
    expect(conflict.status).toBe(409);
    const after = await body<DemoSandboxState>(backend, "/api/demo/state");
    expect(after.body.calendar.some((event) => event.title === "Dentist appointment")).toBe(true);
    expect(after.body.familyUpdates).toEqual([]);
  });

  it("uses the existing typed ambiguous path without a family update or retry", async () => {
    const backend = new BrowserDemoBackend();
    const proposed = await body<ApprovalCard>(backend, "/api/demo/proposals", post({ fixtureId: "move-demo-appointment-and-notify-gil" }));
    const first = await body<{ status: string; message: string }>(backend, `/api/demo/drafts/${proposed.body.draftId}/approve-ambiguous`, post({ draftHash: proposed.body.draftHash }));
    const replay = await body<{ status: string; message: string }>(backend, `/api/demo/drafts/${proposed.body.draftId}/approve-ambiguous`, post({ draftHash: proposed.body.draftHash }));
    expect(first.body.status).toBe("calendar_outcome_ambiguous");
    expect(replay.body).toEqual(first.body);
    expect(first.body.message).toContain("I couldn’t confirm whether your calendar changed.");
    expect(first.body.message).not.toContain("nothing changed");
    expect((await body<DemoSandboxState>(backend, "/api/demo/state")).body.familyUpdates).toEqual([]);
  });
});
