import { describe, expect, it } from "vitest";
import { AuthorityEngine, AuthorityStore } from "@bander/core";
import { SeededSandboxRuntime, versionedDraftFixtures } from "@bander/demo-sandbox";
import { buildBrokerApp } from "../../../broker/src/app.js";
import { BrowserDemoBackend } from "./browser.js";
import type { BackendResponse, DemoBackend } from "./types.js";

function serverBackend(): { backend: DemoBackend; close: () => Promise<void> } {
  const runtime = new SeededSandboxRuntime();
  const store = new AuthorityStore();
  let ids = 0;
  const engine = new AuthorityEngine({
    store,
    adapter: runtime,
    now: () => new Date("2026-07-16T18:00:00.000Z"),
    id: () => `browser-${String(++ids).padStart(4, "0")}`,
  });
  const app = buildBrokerApp({
    engine,
    fixtures: versionedDraftFixtures(),
    readDemoState: async () => runtime.state(),
    readDemoSchedule: async () => runtime.scheduleTomorrow(),
    readDemoInbox: async () => runtime.state().inbox.filter((message) => message.subject === "Lunch next week"),
    resetDemo: async () => { runtime.reset(); engine.resetDemo(); ids = 0; },
    prepareAmbiguousCalendarOutcome: () => runtime.prepareAmbiguousCalendar(),
    prepareAmbiguousEmailOutcome: () => runtime.prepareAmbiguousEmail(),
    simulateEmailThreadChange: () => runtime.prepareChangedEmailThread(),
    simulateCalendarChange: async () => runtime.simulateCalendarChange("event-dinner-sarah"),
    simulateCancellationCalendarChange: async () => runtime.simulateCalendarChange("event-dentist"),
  });
  return {
    backend: {
      kind: "http",
      async request<T>(path: string, init?: RequestInit): Promise<BackendResponse<T>> {
        const hasBody = typeof init?.body === "string";
        const method = (init?.method ?? "GET") as "GET" | "POST";
        const response = hasBody
          ? await app.inject({ method, url: path, payload: init!.body as string, headers: { "content-type": "application/json" } })
          : await app.inject({ method, url: path });
        return { status: response.statusCode, body: response.statusCode === 204 ? undefined as T : response.json<T>() };
      },
    },
    close: () => app.close(),
  };
}

async function body<T>(backend: DemoBackend, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  return backend.request<T>(path, init);
}

const post = (value?: unknown): RequestInit => ({
  method: "POST",
  ...(value === undefined ? {} : { body: JSON.stringify(value) }),
});

describe("browser/server deterministic sandbox parity", () => {
  it("matches reads, cards, receipts, state, replay, and decline for every successful deal shape", async () => {
    const server = serverBackend();
    try {
      const browser = new BrowserDemoBackend();
      for (const path of ["/api/demo/schedule/tomorrow", "/api/demo/inbox/important", "/api/demo/inbox/guided"]) {
        expect(await body(browser, path)).toEqual(await body(server.backend, path));
      }
      for (const fixtureId of [
        "move-dinner-and-notify-sarah",
        "move-demo-appointment-and-notify-gil",
        "add-lunch-with-ruth-and-notify-gil",
        "cancel-dentist-and-notify-gil",
        "reply-to-ruth-about-lunch",
        "tell-gil-dinner-is-at-six",
        "reply-to-dr-rao-about-thursday",
        "add-dr-rao-appointment-and-notify-gil",
      ]) {
        await body(browser, "/api/demo/reset", post());
        await body(server.backend, "/api/demo/reset", post());
        const browserCard = await body<{ draftId: string; draftHash: string }>(browser, "/api/demo/proposals", post({ fixtureId }));
        const serverCard = await body<{ draftId: string; draftHash: string }>(server.backend, "/api/demo/proposals", post({ fixtureId }));
        expect(browserCard).toEqual(serverCard);
        const approvalPath = `/api/drafts/${browserCard.body.draftId}/approve`;
        const approvalBody = post({ draftHash: browserCard.body.draftHash });
        const browserReceipt = await body(browser, approvalPath, approvalBody);
        const serverReceipt = await body(server.backend, approvalPath, approvalBody);
        expect(browserReceipt).toEqual(serverReceipt);
        expect(await body(browser, "/api/demo/state")).toEqual(await body(server.backend, "/api/demo/state"));
        expect(await body(browser, approvalPath, approvalBody)).toEqual(await body(server.backend, approvalPath, approvalBody));
        expect(await body(browser, "/api/demo/state")).toEqual(await body(server.backend, "/api/demo/state"));

        await body(browser, "/api/demo/reset", post());
        await body(server.backend, "/api/demo/reset", post());
        const browserDeclineCard = await body<{ draftId: string }>(browser, "/api/demo/proposals", post({ fixtureId }));
        const serverDeclineCard = await body<{ draftId: string }>(server.backend, "/api/demo/proposals", post({ fixtureId }));
        expect(browserDeclineCard).toEqual(serverDeclineCard);
        expect(await body(browser, `/api/drafts/${browserDeclineCard.body.draftId}/decline`, post())).toEqual(
          await body(server.backend, `/api/drafts/${serverDeclineCard.body.draftId}/decline`, post()),
        );
        expect(await body(browser, "/api/demo/state")).toEqual(await body(server.backend, "/api/demo/state"));
      }
    } finally { await server.close(); }
  });

  it("matches standing activation, eligible execution, review fallback, replay, and revocation", async () => {
    const server = serverBackend();
    try {
      const browser = new BrowserDemoBackend();
      const compare = async <T>(path: string, init?: RequestInit) => {
        const browserResult = await body<T>(browser, path, init);
        const serverResult = await body<T>(server.backend, path, init);
        expect(browserResult).toEqual(serverResult);
        return browserResult;
      };
      await compare("/api/demo/reset", post());
      const candidate = await compare<{ candidateId: string; predicateHash: string }>("/api/demo/standing-band-candidates", post());
      const authorization = await compare<{ bandId: string }>(`/api/standing-band-candidates/${candidate.body.candidateId}/approve`, post({ predicateHash: candidate.body.predicateHash }));
      const eligible = post({ fixtureId: "move-my-focus-block", requestId: "parity-standing-eligible" });
      await compare(`/api/standing-bands/${authorization.body.bandId}/run`, eligible);
      await compare(`/api/demo/state`);
      await compare(`/api/standing-bands/${authorization.body.bandId}/run`, eligible);
      await compare(`/api/demo/state`);
      await compare(`/api/standing-bands/${authorization.body.bandId}/run`, post({ fixtureId: "move-dinner-under-standing-band", requestId: "parity-standing-review" }));
      await compare(`/api/bands/${authorization.body.bandId}/revoke`, post());
      await compare(`/api/standing-bands/${authorization.body.bandId}/run`, post({ fixtureId: "move-my-focus-block", requestId: "parity-standing-revoked" }));
    } finally { await server.close(); }
  });

  it("matches changed-world and ambiguous terminal behavior", async () => {
    const server = serverBackend();
    try {
      const browser = new BrowserDemoBackend();
      const cases = [
        ["move-dinner-and-notify-sarah", "approve-after-calendar-change"],
        ["cancel-dentist-and-notify-gil", "approve-after-cancel-calendar-change"],
        ["reply-to-ruth-about-lunch", "approve-after-email-thread-change"],
        ["move-demo-appointment-and-notify-gil", "approve-ambiguous"],
        ["reply-to-ruth-about-lunch", "approve-email-ambiguous"],
      ] as const;
      for (const [fixtureId, action] of cases) {
        await body(browser, "/api/demo/reset", post());
        await body(server.backend, "/api/demo/reset", post());
        const browserCard = await body<{ draftId: string; draftHash: string }>(browser, "/api/demo/proposals", post({ fixtureId }));
        const serverCard = await body<{ draftId: string; draftHash: string }>(server.backend, "/api/demo/proposals", post({ fixtureId }));
        expect(browserCard).toEqual(serverCard);
        const browserResult = await body(browser, `/api/demo/drafts/${browserCard.body.draftId}/${action}`, post({ draftHash: browserCard.body.draftHash }));
        const serverResult = await body(server.backend, `/api/demo/drafts/${serverCard.body.draftId}/${action}`, post({ draftHash: serverCard.body.draftHash }));
        expect(browserResult).toEqual(serverResult);
        expect(await body(browser, "/api/demo/state")).toEqual(await body(server.backend, "/api/demo/state"));
        if (action.includes("ambiguous")) {
          expect(await body(browser, `/api/demo/drafts/${browserCard.body.draftId}/${action}`, post({ draftHash: browserCard.body.draftHash }))).toEqual(
            await body(server.backend, `/api/demo/drafts/${serverCard.body.draftId}/${action}`, post({ draftHash: serverCard.body.draftHash })),
          );
        }
      }
    } finally { await server.close(); }
  });
});
