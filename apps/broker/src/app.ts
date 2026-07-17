import Fastify, { type FastifyInstance } from "fastify";
import {
  AuthorityEngine,
  AuthorityError,
  type DraftFixture,
} from "@bander/core";
import type {
  AgentReceipt,
  ApprovalCard,
  DemoSandboxState,
  ScheduleReadResult,
} from "@bander/contracts";
import { CompilerError, type DraftCompiler } from "./compiler.js";
import { registerMcpRoutes } from "./mcp.js";

interface BrokerAppOptions {
  engine: AuthorityEngine;
  fixtures: Map<string, DraftFixture>;
  runtimeMode?: "sandbox" | "real";
  compiler?: DraftCompiler;
  agentCompiler?: DraftCompiler;
  deliverAgentProposal?: (card: ApprovalCard) => Promise<void>;
  deliverAgentClarification?: (message: string) => Promise<void>;
  proposeAgentStandingOptIn?: (
    request: string,
  ) => Promise<{ status: "proposed" } | undefined>;
  runAgentStandingAction?: (
    fixture: DraftFixture,
    requestId?: string,
  ) => Promise<AgentReceipt | undefined>;
  activateAgentStandingBand?: (bandId: string) => Promise<void>;
  resetDemo?: () => Promise<void>;
  simulateCalendarChange?: () => Promise<void>;
  simulateCancellationCalendarChange?: () => Promise<void>;
  prepareAmbiguousCalendarOutcome?: () => void;
  dropNextStandingRunResponseAfterCompletion?: () => boolean;
  heroMode?: boolean;
  readHeroState?: () => Promise<DemoSandboxState>;
  readDemoState?: () => Promise<DemoSandboxState>;
  readDemoSchedule?: () => Promise<ScheduleReadResult>;
  readSchedule?: (
    request: string,
  ) => Promise<
    ScheduleReadResult | { status: "clarification_required"; question: string }
  >;
}

function sendError(error: unknown, reply: { code(status: number): { send(body: unknown): unknown } }) {
  if (error instanceof AuthorityError) {
    return reply.code(error.statusCode).send({
      error: { code: error.code, message: error.message },
    });
  }
  return reply.code(500).send({
    error: { code: "internal_error", message: "Bander could not complete that request" },
  });
}

export function buildBrokerApp(options: BrokerAppOptions): FastifyInstance {
  if (options.runtimeMode === "real" && !options.readSchedule) {
    throw new Error("Real Bander requires the bounded schedule reader");
  }
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { removeAdditional: false } },
  });
  const ambiguousDemoDrafts = new Set<string>();
  const ambiguousSandboxOutcome = {
    status: "calendar_outcome_ambiguous" as const,
    message: [
      "I couldn’t confirm whether your calendar changed.",
      "No family update was sent.",
      "I won’t try this request again automatically.",
      "Please check your calendar before asking your assistant again.",
    ].join("\n"),
  };

  app.get("/api/status", async () => ({
    product: "Bander",
    status: "ready",
    runtimeMode: options.runtimeMode ?? "sandbox",
    fixtureMode: options.runtimeMode !== "real",
    calendarBackend: options.runtimeMode === "real" ? "google" : "sandbox",
    compilerKind: options.runtimeMode === "real" ? "real_calendar" : "fixture",
    modelCompiler: options.compiler ? "available" : "not_configured",
    scheduleRead:
      options.runtimeMode === "real" && options.readSchedule
        ? "available"
        : "not_configured",
    heroMode: options.heroMode === true,
  }));

  if (options.heroMode && options.readHeroState) {
    app.get("/api/hero/state", async (_request, reply) => {
      reply.header("cache-control", "no-store");
      return options.readHeroState!();
    });
  }
  if (options.runtimeMode !== "real" && options.readDemoState) {
    app.get("/api/demo/state", async (_request, reply) => {
      reply.header("cache-control", "no-store");
      return options.readDemoState!();
    });
  }

  app.post<{ Body: { request: string } }>(
    "/api/compiler/proposals",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["request"],
          properties: {
            request: { type: "string", minLength: 1, maxLength: 1000 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!options.compiler) {
        return reply.code(503).send({
          error: {
            code: "model_compiler_not_configured",
            message: "Set OPENAI_API_KEY to enable the optional GPT-5.6 compiler.",
          },
        });
      }
      try {
        const fixture = await options.compiler.compile(request.body.request);
        return await options.engine.proposeFixture(fixture, "gpt-5.6-compiler");
      } catch (error) {
        if (error instanceof CompilerError) {
          const status = error.code === "model_unavailable" ? 503 : 422;
          return reply.code(status).send({
            error: { code: error.code, message: error.message },
          });
        }
        return sendError(error, reply);
      }
    },
  );

  app.post<{ Body: { fixtureId: string } }>(
    "/api/demo/proposals",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["fixtureId"],
          properties: { fixtureId: { type: "string", minLength: 1, maxLength: 100 } },
        },
      },
    },
    async (request, reply) => {
      if (options.runtimeMode === "real") {
        return reply.code(404).send({
          error: { code: "not_found", message: "API route not found" },
        });
      }
      const fixture = options.fixtures.get(request.body.fixtureId);
      if (!fixture) {
        return reply.code(404).send({
          error: { code: "fixture_not_found", message: "Demo fixture not found" },
        });
      }
      try {
        return await options.engine.proposeFixture(fixture);
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.get("/api/demo/schedule/tomorrow", async (_request, reply) => {
    if (options.runtimeMode === "real" || !options.readDemoSchedule) {
      return reply.code(404).send({
        error: { code: "not_found", message: "API route not found" },
      });
    }
    return options.readDemoSchedule();
  });

  app.post("/api/demo/reset", async (_request, reply) => {
    if (options.runtimeMode === "real") {
      return reply.code(404).send({
        error: { code: "not_found", message: "API route not found" },
      });
    }
    if (!options.resetDemo) {
      return reply.code(501).send({
        error: { code: "demo_reset_unavailable", message: "Demo reset is unavailable" },
      });
    }
    try {
      ambiguousDemoDrafts.clear();
      await options.resetDemo();
      return reply.code(204).send();
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post<{
    Params: { draftId: string };
    Body: { draftHash: string };
  }>(
    "/api/demo/drafts/:draftId/approve-ambiguous",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["draftHash"],
          properties: { draftHash: { type: "string", pattern: "^[a-f0-9]{64}$" } },
        },
      },
    },
    async (request, reply) => {
      if (options.runtimeMode === "real" || !options.prepareAmbiguousCalendarOutcome) {
        return reply.code(404).send({ error: { code: "not_found", message: "API route not found" } });
      }
      if (ambiguousDemoDrafts.has(request.params.draftId)) return ambiguousSandboxOutcome;
      options.prepareAmbiguousCalendarOutcome();
      try {
        await options.engine.approveAndExecute(request.params.draftId, request.body.draftHash);
        return reply.code(500).send({ error: { code: "simulation_failed", message: "Ambiguous simulation unexpectedly completed" } });
      } catch (error) {
        if (error instanceof AuthorityError && error.code === "calendar_outcome_ambiguous") {
          ambiguousDemoDrafts.add(request.params.draftId);
          return ambiguousSandboxOutcome;
        }
        return sendError(error, reply);
      }
    },
  );

  app.post("/api/demo/standing-band-candidates", async (_request, reply) => {
    if (options.runtimeMode === "real") {
      return reply.code(404).send({
        error: { code: "not_found", message: "API route not found" },
      });
    }
    try {
      return options.engine.createStandingBandCandidate();
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post<{
    Params: { candidateId: string };
    Body: { predicateHash: string };
  }>(
    "/api/standing-band-candidates/:candidateId/approve",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["predicateHash"],
          properties: {
            predicateHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        },
      },
    },
    async (request, reply) => {
      if (options.runtimeMode === "real") {
        return reply.code(404).send({
          error: { code: "not_found", message: "API route not found" },
        });
      }
      try {
        const standing = await options.engine.approveStandingBand(
          request.params.candidateId,
          request.body.predicateHash,
        );
        await options.activateAgentStandingBand?.(standing.bandId);
        return standing;
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.post<{
    Params: { bandId: string };
    Body: { fixtureId: string; requestId: string };
  }>(
    "/api/standing-bands/:bandId/run",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["fixtureId", "requestId"],
          properties: {
            fixtureId: { type: "string", minLength: 1, maxLength: 100 },
            requestId: {
              type: "string",
              minLength: 16,
              maxLength: 100,
              pattern: "^[A-Za-z0-9_-]+$",
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (options.runtimeMode === "real") {
        return reply.code(404).send({
          error: { code: "not_found", message: "API route not found" },
        });
      }
      const fixture = options.fixtures.get(request.body.fixtureId);
      if (!fixture) {
        return reply.code(404).send({
          error: { code: "fixture_not_found", message: "Demo fixture not found" },
        });
      }
      try {
        const result = await options.engine.runStandingBand(
          request.params.bandId,
          fixture,
          request.body.requestId,
          "demo-agent",
        );
        if (options.dropNextStandingRunResponseAfterCompletion?.()) {
          reply.hijack();
          reply.raw.destroy();
          return reply;
        }
        return result;
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.post<{ Params: { bandId: string } }>(
    "/api/bands/:bandId/revoke",
    async (request, reply) => {
      if (options.runtimeMode === "real") {
        return reply.code(404).send({
          error: { code: "not_found", message: "API route not found" },
        });
      }
      try {
        await options.engine.revokeBand(request.params.bandId);
        return reply.code(204).send();
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.get<{ Params: { draftId: string } }>(
    "/api/drafts/:draftId/card",
    async (request, reply) => {
      try {
        return options.engine.getCard(request.params.draftId);
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.post<{ Params: { draftId: string }; Body: { draftHash: string } }>(
    "/api/drafts/:draftId/approve",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["draftHash"],
          properties: {
            draftHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        return await options.engine.approveAndExecute(
          request.params.draftId,
          request.body.draftHash,
        );
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.post<{ Params: { draftId: string }; Body: { draftHash: string } }>(
    "/api/demo/drafts/:draftId/approve-after-cancel-calendar-change",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["draftHash"],
          properties: { draftHash: { type: "string", pattern: "^[a-f0-9]{64}$" } },
        },
      },
    },
    async (request, reply) => {
      if (options.runtimeMode === "real" || !options.simulateCancellationCalendarChange) {
        return reply.code(404).send({
          error: { code: "not_found", message: "API route not found" },
        });
      }
      try {
        const authorization = await options.engine.approve(
          request.params.draftId,
          request.body.draftHash,
        );
        await options.simulateCancellationCalendarChange();
        return await options.engine.executePermit(authorization.permitId);
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.post<{ Params: { draftId: string }; Body: { draftHash: string } }>(
    "/api/demo/drafts/:draftId/approve-after-calendar-change",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["draftHash"],
          properties: { draftHash: { type: "string", pattern: "^[a-f0-9]{64}$" } },
        },
      },
    },
    async (request, reply) => {
      if (options.runtimeMode === "real") {
        return reply.code(404).send({
          error: { code: "not_found", message: "API route not found" },
        });
      }
      if (!options.simulateCalendarChange) {
        return reply.code(501).send({
          error: { code: "demo_conflict_unavailable", message: "Conflict demo is unavailable" },
        });
      }
      try {
        const authorization = await options.engine.approve(
          request.params.draftId,
          request.body.draftHash,
        );
        await options.simulateCalendarChange();
        return await options.engine.executePermit(authorization.permitId);
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.post<{ Params: { draftId: string } }>(
    "/api/drafts/:draftId/decline",
    async (request, reply) => {
      try {
        return options.engine.decline(request.params.draftId);
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.get<{ Params: { receiptId: string } }>(
    "/api/receipts/:receiptId",
    async (request, reply) => {
      try {
        return options.engine.getHumanReceipt(request.params.receiptId);
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.get<{ Params: { draftId: string } }>(
    "/api/agent/drafts/:draftId/receipt",
    async (request, reply) => {
      try {
        return options.engine.getAgentReceipt(request.params.draftId);
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  registerMcpRoutes(app, options);

  return app;
}
