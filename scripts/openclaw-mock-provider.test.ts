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
});
