import type { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod/v4";
import {
  AuthorityError,
  type AuthorityEngine,
  type DraftFixture,
} from "@bander/core";
import type { AgentReceipt, ApprovalCard } from "@bander/contracts";
import {
  CompilerError,
  createDeterministicDraftCompiler,
  type DraftCompiler,
} from "./compiler.js";

interface McpRoutesOptions {
  engine: AuthorityEngine;
  fixtures: Map<string, DraftFixture>;
  agentCompiler?: DraftCompiler;
  deliverAgentProposal?: (card: ApprovalCard) => Promise<void>;
  proposeAgentStandingOptIn?: (
    request: string,
  ) => Promise<{ status: "proposed" } | undefined>;
  runAgentStandingAction?: (
    fixture: DraftFixture,
    requestId?: string,
  ) => Promise<AgentReceipt | undefined>;
}

const MCP_RATE_LIMIT_MAX_REQUESTS = 30;
const MCP_RATE_LIMIT_WINDOW_MS = 60_000;

interface McpRateWindow {
  count: number;
  resetAt: number;
}

function asToolError(error: unknown) {
  const message =
    error instanceof AuthorityError
      ? `${error.code}: ${error.message}`
      : "Bander could not complete that request";
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

export function createBanderMcpServer(options: McpRoutesOptions): McpServer {
  const server = new McpServer({ name: "bander", version: "0.1.0" });
  const compiler =
    options.agentCompiler ?? createDeterministicDraftCompiler(options.fixtures);

  server.registerTool(
    "list_capabilities",
    {
      title: "List Bander capabilities",
      description:
        "List the effects Bander can propose through its user-controlled approval boundary.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            capabilities: [
              "Prepare a bounded Calendar reschedule for human review",
              "Prepare one bounded Messages send as part of the same reviewed deal",
              "Run an eligible Calendar reschedule under a previously approved standing Band",
              "Read only the minimal status of a previously proposed Draft",
            ],
            supportedProposalRequests: [...options.fixtures.values()].map(
              (fixture) => fixture.claimedUserRequest,
            ).concat(
              options.proposeAgentStandingOptIn
                ? ["Handle my focus time automatically."]
                : [],
            ),
            executionBoundary:
              "OpenClaw cannot approve authority. Eligible execution can occur only inside a standing Band the person previously approved.",
          }),
        },
      ],
    }),
  );

  server.registerTool(
    "propose_action",
    {
      title: "Propose an action through Bander",
      description:
        "Pass the person's natural request verbatim. Bander either creates a human review Card or, when the request fits an existing standing Band, executes only within that pre-approved authority. Reuse the same requestId when recovering an ambiguous standing result.",
      inputSchema: {
        request: z
          .string()
          .min(1)
          .max(1000)
          .describe("The person's natural-language request, passed verbatim"),
        requestId: z
          .string()
          .regex(/^[A-Za-z0-9_-]{16,100}$/)
          .optional()
          .describe(
            "A client-generated idempotency ID, required whenever a standing Band may execute",
          ),
      },
    },
    async ({ request, requestId }) => {
      try {
        const standingOptIn = await options.proposeAgentStandingOptIn?.(request);
        if (standingOptIn) {
          return {
            content: [
              { type: "text", text: JSON.stringify(standingOptIn) },
            ],
          };
        }
        const fixture = await compiler.compile(request);
        const standingStatus = await options.runAgentStandingAction?.(
          fixture,
          requestId,
        );
        if (standingStatus) {
          return {
            content: [{ type: "text", text: JSON.stringify(standingStatus) }],
          };
        }
        const card = await options.engine.proposeFixture(
          fixture,
          "openclaw-reference",
        );
        await options.deliverAgentProposal?.(card);
        const agentStatus = options.engine.getAgentReceipt(card.draftId);
        return {
          content: [{ type: "text", text: JSON.stringify(agentStatus) }],
        };
      } catch (error) {
        if (error instanceof CompilerError) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ status: "unsupported" }),
              },
            ],
          };
        }
        return asToolError(error);
      }
    },
  );

  server.registerTool(
    "get_receipt",
    {
      title: "Get minimal Bander status",
      description:
        "Return only the Draft ID and lifecycle status. This never returns Calendar or Messages data.",
      inputSchema: {
        draftId: z.string().min(1).max(100).describe("The Bander Draft ID"),
      },
    },
    async ({ draftId }) => {
      try {
        const receipt = options.engine.getAgentReceipt(draftId);
        return { content: [{ type: "text", text: JSON.stringify(receipt) }] };
      } catch (error) {
        return asToolError(error);
      }
    },
  );

  return server;
}

export function registerMcpRoutes(
  app: FastifyInstance,
  options: McpRoutesOptions,
): void {
  const rateWindows = new Map<string, McpRateWindow>();

  app.post("/mcp", async (request, reply) => {
    const now = Date.now();
    const current = rateWindows.get(request.ip);
    const window =
      !current || current.resetAt <= now
        ? { count: 0, resetAt: now + MCP_RATE_LIMIT_WINDOW_MS }
        : current;
    if (window.count >= MCP_RATE_LIMIT_MAX_REQUESTS) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((window.resetAt - now) / 1000),
      );
      return reply
        .header("retry-after", String(retryAfterSeconds))
        .code(429)
        .send({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Too many MCP requests; retry after the current window.",
            data: { code: "mcp_rate_limited" },
          },
          id: null,
        });
    }
    window.count += 1;
    rateWindows.set(request.ip, window);

    const server = createBanderMcpServer(options);
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    reply.hijack();
    try {
      // SDK 1.29's optional callback fields conflict with exactOptionalPropertyTypes,
      // although the concrete transport implements the SDK's Transport contract.
      await server.connect(transport as Parameters<McpServer["connect"]>[0]);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch {
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
    } finally {
      await transport.close();
      await server.close();
    }
  });

  for (const method of ["GET", "DELETE"] as const) {
    app.route({
      method,
      url: "/mcp",
      handler: async (_request, reply) =>
        reply.code(405).send({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed" },
          id: null,
        }),
    });
  }
}
