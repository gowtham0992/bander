import Fastify, { type FastifyInstance } from "fastify";
import {
  AuthorityEngine,
  AuthorityError,
  type DraftFixture,
} from "@bander/core";
import type { AgentReceipt, ApprovalCard } from "@bander/contracts";
import { CompilerError, type DraftCompiler } from "./compiler.js";
import { registerMcpRoutes } from "./mcp.js";

interface BrokerAppOptions {
  engine: AuthorityEngine;
  fixtures: Map<string, DraftFixture>;
  compiler?: DraftCompiler;
  agentCompiler?: DraftCompiler;
  deliverAgentProposal?: (card: ApprovalCard) => Promise<void>;
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
  dropNextStandingRunResponseAfterCompletion?: () => boolean;
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
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.get("/api/status", async () => ({
    product: "Bander",
    status: "ready",
    fixtureMode: true,
    modelCompiler: options.compiler ? "available" : "not_configured",
  }));

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

  app.post("/api/demo/reset", async (_request, reply) => {
    if (!options.resetDemo) {
      return reply.code(501).send({
        error: { code: "demo_reset_unavailable", message: "Demo reset is unavailable" },
      });
    }
    try {
      await options.resetDemo();
      return reply.code(204).send();
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post("/api/demo/standing-band-candidates", async (_request, reply) => {
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
