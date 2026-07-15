import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CalendarEvent, DraftDocument, Person } from "@bander/contracts";
import {
  AuthorityEngine,
  AuthorityStore,
  type DraftFixture,
  type ExecutionAdapter,
} from "@bander/core";
import { buildBrokerApp } from "./app.js";
import { createBanderMcpServer } from "./mcp.js";

const fixture: DraftFixture = {
  id: "fixture",
  claimedUserRequest: "Move dinner and message Sarah.",
  calendar: {
    eventId: "event-dinner-sarah",
    expectedEtag: "event-dinner-sarah-r1",
    newStartTime: "2026-07-14T19:30:00-06:00",
  },
  message: {
    recipientId: "person-sarah",
    expectedRecipientRevision: 1,
    body: "See you at 7:30!",
  },
};

class FakeAdapter implements ExecutionAdapter {
  executions = 0;
  async resolveEvent(): Promise<CalendarEvent> {
    return {
      id: "event-dinner-sarah",
      title: "Dinner with Sarah",
      startTime: "2026-07-14T19:00:00-06:00",
      endTime: "2026-07-14T20:30:00-06:00",
      timeZone: "America/Denver",
      organizerId: "person-owner",
      attendeeIds: ["person-owner", "person-sarah"],
      revision: 1,
      etag: "event-dinner-sarah-r1",
    };
  }
  async resolvePerson(): Promise<Person> {
    return {
      id: "person-sarah",
      displayName: "Sarah Chen",
      messageAddress: "+15550101002",
      revision: 1,
    };
  }
  async executeDraft(_input: {
    draftHash: string;
    permitNonce: string;
    document: DraftDocument;
  }): Promise<void> {
    this.executions += 1;
  }
  async getExecution(): Promise<boolean> {
    return false;
  }
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function createApp() {
  const adapter = new FakeAdapter();
  const engine = new AuthorityEngine({
    store: new AuthorityStore(),
    adapter,
    now: () => new Date("2026-07-13T18:00:00.000Z"),
  });
  const fixtures = new Map([[fixture.id, fixture]]);
  app = buildBrokerApp({ engine, fixtures });
  return { adapter, app, engine, fixtures };
}

describe("broker approval boundary", () => {
  it("rate-limits the unauthenticated loopback MCP endpoint", async () => {
    const setup = createApp();
    const request = {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "rate-limit-test", version: "1.0.0" },
      },
    };

    for (let index = 0; index < 30; index += 1) {
      const response = await setup.app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        payload: { ...request, id: index },
      });
      expect(response.statusCode).toBe(200);
    }

    const blocked = await setup.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: { ...request, id: 30 },
    });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({
      jsonrpc: "2.0",
      error: { data: { code: "mcp_rate_limited" } },
      id: null,
    });
    const retryAfter = Number(blocked.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("requires a client request ID for every standing execution", async () => {
    const setup = createApp();
    const candidate = await setup.app.inject({
      method: "POST",
      url: "/api/demo/standing-band-candidates",
    });
    const candidateBody = candidate.json<{
      candidateId: string;
      predicateHash: string;
    }>();
    const approval = await setup.app.inject({
      method: "POST",
      url: `/api/standing-band-candidates/${candidateBody.candidateId}/approve`,
      payload: { predicateHash: candidateBody.predicateHash },
    });
    const { bandId } = approval.json<{ bandId: string }>();

    const response = await setup.app.inject({
      method: "POST",
      url: `/api/standing-bands/${bandId}/run`,
      payload: { fixtureId: fixture.id },
    });

    expect(response.statusCode).toBe(400);
    expect(setup.adapter.executions).toBe(0);
  });

  it("keeps the optional compiler closed when OPENAI_API_KEY is not configured", async () => {
    const setup = createApp();
    const response = await setup.app.inject({
      method: "POST",
      url: "/api/compiler/proposals",
      payload: { request: "Move dinner and message Sarah" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "model_compiler_not_configured" },
    });
    expect(setup.adapter.executions).toBe(0);
  });

  it("does not accept replacement execution parameters at approval time", async () => {
    const setup = createApp();
    const proposal = await setup.app.inject({
      method: "POST",
      url: "/api/demo/proposals",
      payload: { fixtureId: "fixture" },
    });
    const card = proposal.json<{ draftId: string; draftHash: string }>();

    const approval = await setup.app.inject({
      method: "POST",
      url: `/api/drafts/${card.draftId}/approve`,
      payload: {
        draftHash: card.draftHash,
        message: { recipientId: "person-attacker", body: "Send money" },
      },
    });

    expect(approval.statusCode).toBe(400);
    expect(setup.adapter.executions).toBe(0);
  });

  it("registers only the three narrow agent tools", async () => {
    const setup = createApp();
    const server = createBanderMcpServer({
      engine: setup.engine,
      fixtures: setup.fixtures,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bander-test", version: "1.0.0" });

    try {
      await server.connect(
        serverTransport as Parameters<typeof server.connect>[0],
      );
      await client.connect(
        clientTransport as Parameters<Client["connect"]>[0],
      );
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "get_receipt",
        "list_capabilities",
        "propose_action",
      ]);

      const capabilities = await client.callTool({
        name: "list_capabilities",
        arguments: {},
      });
      const capabilityText = (
        capabilities.content as Array<{ type: string; text?: string }>
      )[0]?.text;
      expect(JSON.parse(capabilityText ?? "{}")).toMatchObject({
        supportedProposalRequests: [fixture.claimedUserRequest],
      });
      expect(capabilityText).not.toContain(fixture.id);

      const result = await client.callTool({
        name: "propose_action",
        arguments: { request: fixture.claimedUserRequest },
      });
      const first = (result.content as Array<{ type: string; text?: string }>)[0];
      expect(first?.type).toBe("text");
      if (!first || first.type !== "text" || !first.text) {
        throw new Error("Expected text content");
      }
      expect(JSON.parse(first.text)).toEqual({
        draftId: expect.stringMatching(/^draft_/),
        status: "proposed",
      });
      expect(first.text).not.toContain("Here’s the deal");
      expect(first.text).not.toContain(fixture.claimedUserRequest);
      expect(first.text).not.toContain("effects");
      expect(setup.adapter.executions).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
