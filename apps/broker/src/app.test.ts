import { afterEach, describe, expect, it, vi } from "vitest";
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
import { CompilerError } from "./compiler.js";
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
  const authorityStore = new AuthorityStore();
  const engine = new AuthorityEngine({
    store: authorityStore,
    adapter,
    now: () => new Date("2026-07-13T18:00:00.000Z"),
  });
  const fixtures = new Map([[fixture.id, fixture]]);
  app = buildBrokerApp({ engine, fixtures });
  return { adapter, app, authorityStore, engine, fixtures };
}

describe("broker approval boundary", () => {
  it("keeps real mode Calendar-only and makes sandbox routes unreachable", async () => {
    const setup = createApp();
    await setup.app.close();
    app = buildBrokerApp({
      engine: setup.engine,
      fixtures: new Map(),
      runtimeMode: "real",
      compiler: {
        compile: async () => fixture,
      },
      agentCompiler: {
        compile: async () => fixture,
      },
      readSchedule: async () => ({
        requestedRange: {
          startLocalDate: "2026-07-17",
          endLocalDateExclusive: "2026-07-18",
        },
        timeZone: "America/Denver",
        events: [],
        empty: true,
        truncated: false,
        maxEvents: 50,
      }),
    });

    const status = await app.inject({ method: "GET", url: "/api/status" });
    const demo = await app.inject({
      method: "POST",
      url: "/api/demo/proposals",
      payload: { fixtureId: fixture.id },
    });
    const standing = await app.inject({
      method: "POST",
      url: "/api/demo/standing-band-candidates",
    });

    expect(status.json()).toMatchObject({
      runtimeMode: "real",
      fixtureMode: false,
      modelCompiler: "available",
    });
    expect(demo.statusCode).toBe(404);
    expect(standing.statusCode).toBe(404);
    expect(setup.adapter.executions).toBe(0);
  });

  it("advertises no Messages, fixtures or standing authority in real MCP mode", async () => {
    const setup = createApp();
    const server = createBanderMcpServer({
      engine: setup.engine,
      fixtures: new Map(),
      runtimeMode: "real",
      agentCompiler: { compile: async () => fixture },
      readSchedule: async () => ({
        requestedRange: {
          startLocalDate: "2026-07-17",
          endLocalDateExclusive: "2026-07-18",
        },
        timeZone: "America/Denver",
        events: [],
        empty: true,
        truncated: false,
        maxEvents: 50,
      }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bander-real-test", version: "1.0.0" });

    try {
      await server.connect(serverTransport as Parameters<typeof server.connect>[0]);
      await client.connect(clientTransport as Parameters<Client["connect"]>[0]);
      const tools = await client.listTools();
      const capabilities = await client.callTool({
        name: "list_capabilities",
        arguments: {},
      });
      const text = (
        capabilities.content as Array<{ type: string; text?: string }>
      )[0]?.text ?? "";

      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "get_receipt",
        "list_capabilities",
        "propose_action",
        "read_schedule",
      ]);
      expect(text).toContain("Calendar");
      expect(text).toContain("what is coming up");
      expect(text).not.toContain("Messages");
      expect(text).not.toContain("standing");
      expect(text).not.toContain(fixture.claimedUserRequest);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reads schedule facts through the real MCP tool with zero authority state", async () => {
    const setup = createApp();
    const storeWrites = [
      vi.spyOn(setup.authorityStore, "saveDraft"),
      vi.spyOn(setup.authorityStore, "saveBand"),
      vi.spyOn(setup.authorityStore, "savePermit"),
      vi.spyOn(setup.authorityStore, "saveReceipt"),
      vi.spyOn(setup.authorityStore, "saveStandingCandidate"),
      vi.spyOn(setup.authorityStore, "saveStandingRequest"),
    ];
    const proposal = vi.spyOn(setup.engine, "proposeFixture");
    const readSchedule = vi.fn(async (request: string) => ({
      requestedRange: {
        startLocalDate: "2026-07-17",
        endLocalDateExclusive: "2026-07-18",
      },
      timeZone: "America/Denver",
      events: [
        {
          title: "Quoted untrusted event title",
          allDay: false as const,
          start: { localDate: "2026-07-17", localTime: "09:00" },
          end: { localDate: "2026-07-17", localTime: "10:00" },
        },
      ],
      empty: false,
      truncated: false,
      maxEvents: 50,
    }));
    const server = createBanderMcpServer({
      engine: setup.engine,
      fixtures: new Map(),
      runtimeMode: "real",
      agentCompiler: { compile: async () => fixture },
      readSchedule,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bander-read-test", version: "1.0.0" });

    try {
      await server.connect(serverTransport as Parameters<typeof server.connect>[0]);
      await client.connect(clientTransport as Parameters<Client["connect"]>[0]);
      const result = await client.callTool({
        name: "read_schedule",
        arguments: { request: "What’s on my calendar tomorrow?" },
      });
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";

      expect(readSchedule).toHaveBeenCalledWith("What’s on my calendar tomorrow?");
      expect(JSON.parse(text)).toMatchObject({
        timeZone: "America/Denver",
        events: [{ title: "Quoted untrusted event title" }],
      });
      expect(text).not.toMatch(
        /calendarId|eventId|etag|credential|oauth|draft|permit|receipt|callback/i,
      );
      expect(storeWrites.every((write) => write.mock.calls.length === 0)).toBe(true);
      expect(proposal).not.toHaveBeenCalled();
      expect(setup.adapter.executions).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not accept an agent-selected Calendar or account parameter", async () => {
    const setup = createApp();
    const readSchedule = vi.fn(async () => ({
      requestedRange: {
        startLocalDate: "2026-07-17",
        endLocalDateExclusive: "2026-07-18",
      },
      timeZone: "America/Denver",
      events: [],
      empty: true,
      truncated: false,
      maxEvents: 50,
    }));
    const server = createBanderMcpServer({
      engine: setup.engine,
      fixtures: new Map(),
      runtimeMode: "real",
      agentCompiler: { compile: async () => fixture },
      readSchedule,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bander-read-abuse", version: "1.0.0" });

    try {
      await server.connect(serverTransport as Parameters<typeof server.connect>[0]);
      await client.connect(clientTransport as Parameters<Client["connect"]>[0]);
      const result = await client.callTool({
        name: "read_schedule",
        arguments: {
          request: "What’s tomorrow?",
          calendarId: "someone-else@example.invalid",
        },
      });
      expect(result.isError).toBe(true);
      expect(readSchedule).not.toHaveBeenCalled();
      expect(setup.adapter.executions).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("serves sanitized Hero state only when Hero mode is explicitly enabled", async () => {
    const setup = createApp();
    const verificationResponse = await setup.app.inject({
      method: "GET",
      url: "/api/hero/state",
    });
    await setup.app.close();
    const heroState = {
      calendar: [
        {
          title: "Dinner with Sarah",
          startTime: "2026-07-14T19:00:00-06:00",
          endTime: "2026-07-14T20:30:00-06:00",
          timeZone: "America/Denver",
        },
      ],
      messages: [],
    };
    app = buildBrokerApp({
      engine: setup.engine,
      fixtures: setup.fixtures,
      heroMode: true,
      readHeroState: async () => heroState,
    });
    const heroResponse = await app.inject({ method: "GET", url: "/api/hero/state" });

    expect(verificationResponse.statusCode).toBe(404);
    expect(heroResponse.statusCode).toBe(200);
    expect(heroResponse.headers["cache-control"]).toBe("no-store");
    expect(heroResponse.json()).toEqual(heroState);
    expect(heroResponse.body).not.toContain("etag");
    expect(heroResponse.body).not.toContain("draftId");
  });
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
    let deliveredCard: { draftId: string; draftHash: string } | undefined;
    const server = createBanderMcpServer({
      engine: setup.engine,
      fixtures: setup.fixtures,
      deliverAgentProposal: async (card) => {
        deliveredCard = card;
      },
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
      expect(deliveredCard).toMatchObject({
        draftId: JSON.parse(first.text).draftId,
        draftHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(setup.adapter.executions).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("decline_details_do_not_enter_agent_trajectory", async () => {
    const setup = createApp();
    const server = createBanderMcpServer({
      engine: setup.engine,
      fixtures: setup.fixtures,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bander-decline-test", version: "1.0.0" });

    try {
      await server.connect(serverTransport as Parameters<typeof server.connect>[0]);
      await client.connect(clientTransport as Parameters<Client["connect"]>[0]);
      const proposal = await client.callTool({
        name: "propose_action",
        arguments: { request: fixture.claimedUserRequest },
      });
      const proposalText = (
        proposal.content as Array<{ type: string; text?: string }>
      )[0]?.text;
      const draftId = JSON.parse(proposalText ?? "{}").draftId as string;
      setup.engine.decline(draftId);

      const status = await client.callTool({
        name: "get_receipt",
        arguments: { draftId },
      });
      const statusText = (
        status.content as Array<{ type: string; text?: string }>
      )[0]?.text ?? "";

      expect(JSON.parse(statusText)).toEqual({ draftId, status: "declined" });
      expect(statusText).not.toContain("Nothing changed");
      expect(statusText).not.toContain("OpenClaw again");
      expect(setup.adapter.executions).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns a minimal non-error status for unsupported wording", async () => {
    const setup = createApp();
    const delivered: string[] = [];
    const server = createBanderMcpServer({
      engine: setup.engine,
      fixtures: setup.fixtures,
      agentCompiler: {
        compile: async () => {
          throw new CompilerError(
            "clarification_required",
            "model-authored detail that must stay internal",
          );
        },
      },
      deliverAgentClarification: async (message) => {
        delivered.push(message);
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bander-unsupported-test", version: "1.0.0" });

    try {
      await server.connect(serverTransport as Parameters<typeof server.connect>[0]);
      await client.connect(clientTransport as Parameters<Client["connect"]>[0]);
      const result = await client.callTool({
        name: "propose_action",
        arguments: { request: "Please do something unsupported" },
      });
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";

      expect(result.isError).not.toBe(true);
      expect(JSON.parse(text)).toEqual({ status: "clarification_required" });
      expect(text).not.toContain("model-authored detail");
      expect(delivered).toEqual([]);
      expect(setup.adapter.executions).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("delivers only a deterministic clarification while returning minimal agent status", async () => {
    const setup = createApp();
    const proposeFixture = vi.spyOn(setup.engine, "proposeFixture");
    const delivered: string[] = [];
    const safeMessage =
      "What date should I move “Bander Demo Appointment” to?\nNothing happened.";
    const server = createBanderMcpServer({
      engine: setup.engine,
      fixtures: setup.fixtures,
      agentCompiler: {
        compile: async () => {
          throw new CompilerError(
            "clarification_required",
            "internal compiler detail",
            safeMessage,
          );
        },
      },
      deliverAgentClarification: async (message) => {
        delivered.push(message);
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bander-clarification-test", version: "1.0.0" });

    try {
      await server.connect(serverTransport as Parameters<typeof server.connect>[0]);
      await client.connect(clientTransport as Parameters<Client["connect"]>[0]);
      const result = await client.callTool({
        name: "propose_action",
        arguments: { request: "Move it" },
      });
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";

      expect(JSON.parse(text)).toEqual({ status: "clarification_required" });
      expect(text).not.toContain(safeMessage);
      expect(delivered).toEqual([safeMessage]);
      expect(proposeFixture).not.toHaveBeenCalled();
      expect(setup.adapter.executions).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("passes a client request ID into standing execution and returns only minimal status", async () => {
    const setup = createApp();
    let receivedRequestId: string | undefined;
    let delivered = false;
    const server = createBanderMcpServer({
      engine: setup.engine,
      fixtures: setup.fixtures,
      deliverAgentProposal: async () => {
        delivered = true;
      },
      runAgentStandingAction: async (_fixture, requestId) => {
        receivedRequestId = requestId;
        return { draftId: "draft_standing_mcp_0001", status: "executed" };
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bander-standing-test", version: "1.0.0" });

    try {
      await server.connect(
        serverTransport as Parameters<typeof server.connect>[0],
      );
      await client.connect(
        clientTransport as Parameters<Client["connect"]>[0],
      );
      const result = await client.callTool({
        name: "propose_action",
        arguments: {
          request: fixture.claimedUserRequest,
          requestId: "openclaw-standing-request-0001",
        },
      });
      const first = (result.content as Array<{ type: string; text?: string }>)[0];
      expect(JSON.parse(first?.text ?? "{}")).toEqual({
        draftId: "draft_standing_mcp_0001",
        status: "executed",
      });
      expect(receivedRequestId).toBe("openclaw-standing-request-0001");
      expect(delivered).toBe(false);
      expect(first?.text).not.toContain("Focus block");
      expect(first?.text).not.toContain("Receipt");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("standing_activation_details_do_not_enter_agent_trajectory", async () => {
    const setup = createApp();
    let receivedRequest: string | undefined;
    const server = createBanderMcpServer({
      engine: setup.engine,
      fixtures: setup.fixtures,
      agentCompiler: {
        compile: async () => {
          throw new Error("standing opt-in must be handled before action compilation");
        },
      },
      proposeAgentStandingOptIn: async (request) => {
        receivedRequest = request;
        return { status: "proposed" };
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bander-standing-opt-in", version: "1.0.0" });

    try {
      await server.connect(serverTransport as Parameters<typeof server.connect>[0]);
      await client.connect(clientTransport as Parameters<Client["connect"]>[0]);
      const tools = await client.listTools();
      const result = await client.callTool({
        name: "propose_action",
        arguments: { request: "Handle my focus time automatically." },
      });
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";

      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "get_receipt",
        "list_capabilities",
        "propose_action",
      ]);
      expect(receivedRequest).toBe("Handle my focus time automatically.");
      expect(JSON.parse(text)).toEqual({ status: "proposed" });
      expect(text).not.toContain("predicate");
      expect(setup.adapter.executions).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
