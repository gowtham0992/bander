import type { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod/v4";
import { AuthorityError, type AuthorityEngine, type DraftFixture } from "@bander/core";

interface McpRoutesOptions {
  engine: AuthorityEngine;
  fixtures: Map<string, DraftFixture>;
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
              "Propose a seeded Calendar event start-time change",
              "Propose one seeded Messages send as part of the same deal",
              "Read only the minimal status of a previously proposed Draft",
            ],
            executionBoundary:
              "OpenClaw can propose actions but cannot approve or execute them.",
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
        "Create a review Card from a versioned local Draft fixture. This never approves or executes the action.",
      inputSchema: {
        fixtureId: z
          .string()
          .min(1)
          .max(100)
          .describe("A fixture ID returned by the Bander demo instructions"),
      },
    },
    async ({ fixtureId }) => {
      const fixture = options.fixtures.get(fixtureId);
      if (!fixture) {
        return {
          isError: true,
          content: [{ type: "text", text: "fixture_not_found: Demo fixture not found" }],
        };
      }
      try {
        const card = await options.engine.proposeFixture(
          fixture,
          "openclaw-reference",
        );
        return { content: [{ type: "text", text: JSON.stringify(card) }] };
      } catch (error) {
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
  app.post("/mcp", async (request, reply) => {
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
