import { AuthorityEngine, AuthorityError, AuthorityStore } from "@bander/core";
import { SeededSandboxRuntime, versionedDraftFixtures } from "@bander/demo-sandbox";
import type { BackendResponse, DemoBackend } from "./types.js";

const ambiguousCalendarMessage = [
  "I couldn’t confirm whether your calendar changed.",
  "No family update was sent.",
  "I won’t try this request again automatically.",
  "Please check your calendar before asking your assistant again.",
].join("\n");

const ambiguousEmailMessage = [
  "I couldn’t confirm whether the approved email reply was sent.",
  "I won’t send it again automatically.",
  "Please check your Sent folder before asking your assistant again.",
].join("\n");

function parseBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") return {};
  const value = JSON.parse(init.body) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid sandbox request body");
  return value as Record<string, unknown>;
}

export class BrowserDemoBackend implements DemoBackend {
  readonly kind = "browser" as const;
  readonly #runtime: SeededSandboxRuntime;
  readonly #fixtures = versionedDraftFixtures();
  #store!: AuthorityStore;
  #engine!: AuthorityEngine;
  #idCounter = 0;
  readonly #ambiguousCalendarDrafts = new Set<string>();
  readonly #ambiguousEmailDrafts = new Set<string>();

  constructor() {
    this.#runtime = new SeededSandboxRuntime();
    this.#reset();
  }

  async request<T>(path: string, init?: RequestInit): Promise<BackendResponse<T>> {
    try {
      return await this.#route(path, init) as BackendResponse<T>;
    } catch (error) {
      if (error instanceof AuthorityError) {
        return { status: error.statusCode, body: { error: { code: error.code, message: error.message } } as T };
      }
      return { status: 500, body: { error: { code: "internal_error", message: "Bander could not complete that sandbox step" } } as T };
    }
  }

  async #route(path: string, init?: RequestInit): Promise<BackendResponse<unknown>> {
    const method = init?.method ?? "GET";
    const body = parseBody(init);
    if (method === "GET" && path === "/api/status") {
      return this.#ok({ fixtureMode: true, modelCompiler: "not_configured", heroMode: false, runtimeMode: "sandbox", browserOnly: true });
    }
    if (method === "POST" && path === "/api/demo/reset") {
      this.#reset();
      return { status: 204, body: undefined };
    }
    if (method === "GET" && (path === "/api/demo/state" || path === "/api/hero/state")) return this.#ok(this.#runtime.state());
    if (method === "GET" && path === "/api/demo/schedule/tomorrow") return this.#ok(this.#runtime.scheduleTomorrow());
    if (method === "GET" && path === "/api/demo/inbox/important") return this.#ok({ messages: this.#runtime.state().inbox.filter((message) => message.subject === "Lunch next week"), seeded: true });
    if (method === "GET" && path === "/api/demo/inbox/guided") return this.#ok({ messages: this.#runtime.state().inbox.filter((message) => message.subject === "Appointment options"), seeded: true });
    if (method === "POST" && path === "/api/demo/proposals") {
      const fixture = this.#fixtures.get(String(body.fixtureId ?? ""));
      if (!fixture) return this.#error(404, "fixture_not_found", "Demo fixture not found");
      return this.#ok(await this.#engine.proposeFixture(fixture));
    }
    if (method === "POST" && path === "/api/demo/standing-band-candidates") return this.#ok(this.#engine.createStandingBandCandidate());
    if (method === "POST" && path === "/api/compiler/proposals") return this.#error(503, "model_compiler_not_configured", "The browser sandbox never calls a model");

    const standingApproval = path.match(/^\/api\/standing-band-candidates\/([^/]+)\/approve$/);
    if (method === "POST" && standingApproval) return this.#ok(await this.#engine.approveStandingBand(decodeURIComponent(standingApproval[1]!), String(body.predicateHash ?? "")));
    const standingRun = path.match(/^\/api\/standing-bands\/([^/]+)\/run$/);
    if (method === "POST" && standingRun) {
      const fixture = this.#fixtures.get(String(body.fixtureId ?? ""));
      if (!fixture) return this.#error(404, "fixture_not_found", "Demo fixture not found");
      return this.#ok(await this.#engine.runStandingBand(decodeURIComponent(standingRun[1]!), fixture, String(body.requestId ?? "")));
    }
    const revokeBand = path.match(/^\/api\/bands\/([^/]+)\/revoke$/);
    if (method === "POST" && revokeBand) {
      await this.#engine.revokeBand(decodeURIComponent(revokeBand[1]!));
      return { status: 204, body: undefined };
    }
    const decline = path.match(/^\/api\/drafts\/([^/]+)\/decline$/);
    if (method === "POST" && decline) return this.#ok(this.#engine.decline(decodeURIComponent(decline[1]!)));

    const approval = path.match(/^\/api\/(?:demo\/)?drafts\/([^/]+)\/(approve(?:-[a-z-]+)?)$/);
    if (method === "POST" && approval) {
      const draftId = decodeURIComponent(approval[1]!);
      const action = approval[2]!;
      const hash = String(body.draftHash ?? "");
      if (action === "approve-ambiguous") {
        if (this.#ambiguousCalendarDrafts.has(draftId)) return this.#ok({ status: "calendar_outcome_ambiguous", message: ambiguousCalendarMessage });
        this.#runtime.prepareAmbiguousCalendar();
        try { await this.#engine.approveAndExecute(draftId, hash); }
        catch (error) {
          if (error instanceof AuthorityError && error.code === "calendar_outcome_ambiguous") {
            this.#ambiguousCalendarDrafts.add(draftId);
            return this.#ok({ status: error.code, message: ambiguousCalendarMessage });
          }
          throw error;
        }
      }
      if (action === "approve-email-ambiguous") {
        if (this.#ambiguousEmailDrafts.has(draftId)) return this.#ok({ status: "email_outcome_ambiguous", message: ambiguousEmailMessage });
        this.#runtime.prepareAmbiguousEmail();
        try { await this.#engine.approveAndExecute(draftId, hash); }
        catch (error) {
          if (error instanceof AuthorityError && error.code === "email_outcome_ambiguous") {
            this.#ambiguousEmailDrafts.add(draftId);
            return this.#ok({ status: error.code, message: ambiguousEmailMessage });
          }
          throw error;
        }
      }
      if (action === "approve-after-email-thread-change") this.#runtime.prepareChangedEmailThread();
      if (action === "approve-after-calendar-change" || action === "approve-after-cancel-calendar-change") {
        const authorization = await this.#engine.approve(draftId, hash);
        this.#runtime.simulateCalendarChange(action.includes("cancel") ? "event-dentist" : "event-dinner-sarah");
        return this.#ok(await this.#engine.executePermit(authorization.permitId));
      }
      return this.#ok(await this.#engine.approveAndExecute(draftId, hash));
    }
    return this.#error(404, "not_found", "Sandbox route not found");
  }

  #reset(): void {
    this.#runtime.reset();
    this.#store = new AuthorityStore();
    this.#idCounter = 0;
    this.#ambiguousCalendarDrafts.clear();
    this.#ambiguousEmailDrafts.clear();
    this.#engine = new AuthorityEngine({
      store: this.#store,
      adapter: this.#runtime,
      now: () => new Date("2026-07-16T18:00:00.000Z"),
      id: () => `browser-${String(++this.#idCounter).padStart(4, "0")}`,
    });
  }

  #ok<T>(body: T): BackendResponse<T> { return { status: 200, body }; }
  #error<T>(status: number, code: string, message: string): BackendResponse<T> {
    return { status, body: { error: { code, message } } as T };
  }
}
