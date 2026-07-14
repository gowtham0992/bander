import path from "node:path";
import fastifyStatic from "@fastify/static";
import { AuthorityEngine, AuthorityStore } from "@bander/core";
import { buildBrokerApp } from "./app.js";
import { createOpenAIDraftCompiler } from "./compiler.js";
import { loadDraftFixtures } from "./fixtures.js";
import { MockServiceClient } from "./mock-client.js";

const token = process.env.MOCK_SERVICE_TOKEN;
if (!token) throw new Error("MOCK_SERVICE_TOKEN is required");

const port = Number.parseInt(process.env.BANDER_PORT ?? "4310", 10);
const adapter = new MockServiceClient({
  baseUrl: process.env.MOCK_SERVICE_URL ?? "http://127.0.0.1:4311",
  token,
});
const store = new AuthorityStore();
const engine = new AuthorityEngine({ store, adapter });
const fixtures = loadDraftFixtures();
const compiler = process.env.OPENAI_API_KEY
  ? createOpenAIDraftCompiler(process.env.OPENAI_API_KEY, fixtures)
  : undefined;
const app = buildBrokerApp({
  engine,
  fixtures,
  ...(compiler ? { compiler } : {}),
  resetDemo: async () => {
    engine.resetDemo();
    await adapter.resetDemo();
  },
  simulateCalendarChange: () =>
    adapter.simulateCalendarChange("event-dinner-sarah"),
});

if (process.env.BANDER_SERVE_WEB === "1") {
  const webRoot = path.resolve(import.meta.dirname, "../../web/dist");
  await app.register(fastifyStatic, {
    root: webRoot,
    maxAge: "30d",
    immutable: true,
  });
  app.get("/", async (_request, reply) =>
    reply.sendFile("index.html", { maxAge: 0, immutable: false }),
  );
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({
        error: { code: "not_found", message: "API route not found" },
      });
    }
    return reply.sendFile("index.html", { maxAge: 0, immutable: false });
  });
}

await app.listen({ host: "127.0.0.1", port });
console.log(`Bander broker listening on http://127.0.0.1:${port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
