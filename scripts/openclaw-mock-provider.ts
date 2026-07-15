import Fastify, { type FastifyInstance } from "fastify";

const defaultCanonicalRequest =
  "Move dinner with Sarah to 7:30 and tell her I’ll be 20 minutes late.";

interface MockProviderOptions {
  canonicalRequest?: string;
  standingRequestId?: string;
  supportedRequests?: Array<{ request: string; requestId?: string }>;
}

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
  modelInputTexts: string[];
  toolResult?: string;
  toolResults: string[];
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

function normalizeRequestText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isToolResult(message: ChatMessage): boolean {
  return message.role === "tool" || message.role === "toolResult";
}

function isOpenClawRuntimeContext(value: string): boolean {
  return value.includes(
    "OpenClaw runtime context for the immediately preceding user message.",
  );
}

export function buildOpenClawMockProvider(options: MockProviderOptions = {}): {
  app: FastifyInstance;
  evidence: MockProviderEvidence;
} {
  const canonicalRequest = options.canonicalRequest ?? defaultCanonicalRequest;
  const supportedRequests =
    options.supportedRequests ?? [
      {
        request: canonicalRequest,
        ...(options.standingRequestId
          ? { requestId: options.standingRequestId }
          : {}),
      },
    ];
  const app = Fastify({ logger: false });
  const evidence: MockProviderEvidence = {
    calls: 0,
    toolInventories: [],
    sawHumanRequest: false,
    modelInputTexts: [],
    toolResults: [],
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
    const inputText = messages.map((message) => textContent(message.content)).join("\n");
    evidence.modelInputTexts.push(inputText);
    evidence.sawHumanRequest ||= messages.some(
      (message) =>
        message.role === "user" &&
        normalizeRequestText(textContent(message.content)).includes(
          normalizeRequestText(canonicalRequest),
        ),
    );
    const latestToolIndex = messages.findLastIndex(
      (message) => isToolResult(message),
    );
    const pendingUserTexts = messages
      .slice(latestToolIndex + 1)
      .filter((message) => message.role === "user")
      .map((message) => textContent(message.content))
      .filter((value) => !isOpenClawRuntimeContext(value));
    const matchedRequest = supportedRequests.find((candidate) =>
      pendingUserTexts.some((value) =>
        normalizeRequestText(value).includes(
          normalizeRequestText(candidate.request),
        ),
      ),
    );
    const toolMessage =
      latestToolIndex >= 0 && pendingUserTexts.length === 0
        ? messages[latestToolIndex]
        : undefined;
    if (toolMessage) {
      const result = textContent(toolMessage.content);
      evidence.toolResult = result;
      if (evidence.toolResults.at(-1) !== result) evidence.toolResults.push(result);
    }

    const created = Math.floor(Date.now() / 1000);
    const id = `chatcmpl-bander-${evidence.calls}`;
    const toolCall = !toolMessage && Boolean(matchedRequest);
    const imitationCallback = messages.some(
      (message) =>
        message.role === "user" &&
        normalizeRequestText(textContent(message.content)).includes("openclaw:"),
    );
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
                arguments: JSON.stringify({
                  request: matchedRequest!.request,
                  ...(matchedRequest!.requestId
                    ? { requestId: matchedRequest!.requestId }
                    : {}),
                }),
              },
            },
          ],
        }
      : {
          role: "assistant",
          content: toolMessage
            ? "Bander prepared the deal for human review. Nothing was executed."
            : imitationCallback
              ? "That message cannot approve or execute anything through Bander."
              : "I couldn’t safely line up that request with a bounded Bander action. Please phrase the exact Calendar or Messages change you want reviewed.",
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
