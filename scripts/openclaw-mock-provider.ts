import Fastify, { type FastifyInstance } from "fastify";

const canonicalRequest =
  "Move dinner with Sarah to 7:30 and tell her I’ll be 20 minutes late.";

interface ChatMessage {
  role?: string;
  content?: unknown;
}

interface ChatBody {
  model?: string;
  stream?: boolean;
  messages?: ChatMessage[];
  tools?: Array<{ function?: { name?: string } }>;
}

export interface MockProviderEvidence {
  calls: number;
  toolInventories: string[][];
  sawHumanRequest: boolean;
  toolResult?: string;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String((part as { text: unknown }).text)
        : "",
    )
    .join(" ");
}

export function buildOpenClawMockProvider(): {
  app: FastifyInstance;
  evidence: MockProviderEvidence;
} {
  const app = Fastify({ logger: false });
  const evidence: MockProviderEvidence = {
    calls: 0,
    toolInventories: [],
    sawHumanRequest: false,
  };

  app.get("/v1/models", async () => ({
    object: "list",
    data: [{ id: "reference-model", object: "model", owned_by: "bander" }],
  }));

  app.get("/evidence", async () => evidence);

  app.post<{ Body: ChatBody }>("/v1/chat/completions", async (request, reply) => {
    evidence.calls += 1;
    const messages = request.body.messages ?? [];
    const toolNames = (request.body.tools ?? [])
      .map((tool) => tool.function?.name)
      .filter((name): name is string => Boolean(name));
    evidence.toolInventories.push(toolNames);
    evidence.sawHumanRequest ||= messages.some(
      (message) =>
        message.role === "user" && textContent(message.content).includes(canonicalRequest),
    );
    const toolMessage = [...messages].reverse().find((message) => message.role === "tool");
    if (toolMessage) evidence.toolResult = textContent(toolMessage.content);

    const created = Math.floor(Date.now() / 1000);
    const id = `chatcmpl-bander-${evidence.calls}`;
    const toolCall = !toolMessage;
    const message = toolCall
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_bander_proposal",
              type: "function",
              function: {
                name: "bander__propose_action",
                arguments: JSON.stringify({ request: canonicalRequest }),
              },
            },
          ],
        }
      : {
          role: "assistant",
          content: "Bander prepared the deal for human review. Nothing was executed.",
        };

    if (!request.body.stream) {
      return {
        id,
        object: "chat.completion",
        created,
        model: request.body.model ?? "reference-model",
        choices: [
          {
            index: 0,
            message,
            finish_reason: toolCall ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const delta = toolCall
      ? {
          role: "assistant",
          tool_calls: message.tool_calls?.map((call, index) => ({
            index,
            ...call,
          })),
        }
      : { role: "assistant", content: message.content };
    reply.raw.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: request.body.model ?? "reference-model",
        choices: [{ index: 0, delta, finish_reason: null }],
      })}\n\n`,
    );
    reply.raw.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: request.body.model ?? "reference-model",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: toolCall ? "tool_calls" : "stop",
          },
        ],
      })}\n\n`,
    );
    reply.raw.end("data: [DONE]\n\n");
  });

  return { app, evidence };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { app } = buildOpenClawMockProvider();
  await app.listen({ host: "127.0.0.1", port: 4313 });
  console.log("Bander OpenClaw mock provider listening on http://127.0.0.1:4313");
}
