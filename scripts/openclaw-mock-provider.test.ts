import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildOpenClawMockProvider } from "./openclaw-mock-provider.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("deterministic OpenClaw provider", () => {
  it("recognizes the natural request with an ordinary apostrophe", async () => {
    const provider = buildOpenClawMockProvider();
    app = provider.app;
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "reference-model",
        stream: false,
        messages: [
          {
            role: "user",
            content:
              "Move dinner with Sarah to 7:30 and tell her I'll be 20 minutes late.",
          },
          {
            role: "user",
            content: "Synthetic channel context appended after the human message.",
          },
        ],
        tools: [
          { function: { name: "bander__propose_action" } },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: "bander__propose_action" } },
            ],
          },
        },
      ],
    });
    expect(provider.evidence.sawHumanRequest).toBe(true);
  });

  it("answers an unsupported natural request with a friendly clarification", async () => {
    const provider = buildOpenClawMockProvider();
    app = provider.app;
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "reference-model",
        stream: false,
        messages: [
          { role: "user", content: "Book me a flight to Tokyo tomorrow." },
        ],
        tools: [{ function: { name: "bander__propose_action" } }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      choices: [
        {
          message: {
            content:
              "I couldn’t safely line up that request with a bounded Bander action. Please phrase the exact Calendar or Messages change you want reviewed.",
          },
        },
      ],
    });
    expect(provider.evidence.toolInventories[0]).toEqual([
      "bander__propose_action",
    ]);
  });

  it("can propose a new request after an earlier tool result in the same session", async () => {
    const secondRequest = "Move my focus block to 10:30.";
    const provider = buildOpenClawMockProvider({
      supportedRequests: [
        {
          request:
            "Move dinner with Sarah to 7:30 and tell her I’ll be 20 minutes late.",
        },
        { request: secondRequest, requestId: "provider-standing-request-0001" },
      ],
    });
    app = provider.app;
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "reference-model",
        stream: false,
        messages: [
          { role: "user", content: "Move dinner with Sarah to 7:30 and tell her I’ll be 20 minutes late." },
          { role: "assistant", content: null },
          { role: "toolResult", content: '{"draftId":"draft_old","status":"proposed"}' },
          {
            role: "user",
            content:
              "OpenClaw runtime context for the immediately preceding user message.\nInternal context.",
          },
          { role: "assistant", content: "Bander prepared the deal." },
          { role: "user", content: secondRequest },
        ],
        tools: [{ function: { name: "bander__propose_action" } }],
      },
    });

    const argumentsText = response.json().choices[0].message.tool_calls[0].function.arguments;
    expect(JSON.parse(argumentsText)).toEqual({
      request: secondRequest,
      requestId: "provider-standing-request-0001",
    });
  });

  it("recognizes a completed tool turn despite OpenClaw's runtime-context wrapper", async () => {
    const provider = buildOpenClawMockProvider();
    app = provider.app;
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "reference-model",
        stream: false,
        messages: [
          { role: "user", content: "Move dinner with Sarah to 7:30 and tell her I’ll be 20 minutes late." },
          { role: "assistant", content: null },
          { role: "toolResult", content: '{"draftId":"draft_new","status":"proposed"}' },
          {
            role: "user",
            content:
              "OpenClaw runtime context for the immediately preceding user message.\nInternal context.",
          },
        ],
        tools: [{ function: { name: "bander__propose_action" } }],
      },
    });

    expect(response.json()).toMatchObject({
      choices: [
        {
          message: {
            content: "Bander prepared the deal for human review. Nothing was executed.",
          },
        },
      ],
    });
    expect(provider.evidence.toolResults).toEqual([
      '{"draftId":"draft_new","status":"proposed"}',
    ]);
  });

  it("does not mistake a later unsupported request for an old tool completion", async () => {
    const provider = buildOpenClawMockProvider();
    app = provider.app;
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "reference-model",
        stream: false,
        messages: [
          { role: "user", content: "Move dinner with Sarah to 7:30 and tell her I’ll be 20 minutes late." },
          { role: "toolResult", content: '{"draftId":"draft_old","status":"proposed"}' },
          { role: "assistant", content: "Bander prepared the deal." },
          { role: "user", content: "Book me a flight to Tokyo tomorrow." },
        ],
        tools: [{ function: { name: "bander__propose_action" } }],
      },
    });

    expect(response.json()).toMatchObject({
      choices: [
        {
          message: {
            content:
              "I couldn’t safely line up that request with a bounded Bander action. Please phrase the exact Calendar or Messages change you want reviewed.",
          },
        },
      ],
    });
  });
});
