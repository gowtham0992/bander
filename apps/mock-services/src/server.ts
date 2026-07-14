import { buildMockServices } from "./app.js";
import { loadVersionedSeed } from "./fixtures.js";

const token = process.env.MOCK_SERVICE_TOKEN;
if (!token) {
  throw new Error("MOCK_SERVICE_TOKEN is required");
}

const port = Number.parseInt(process.env.MOCK_SERVICE_PORT ?? "4311", 10);
const app = buildMockServices({ token, seed: loadVersionedSeed() });

await app.listen({ host: "127.0.0.1", port });
console.log(`Bander mock services listening on http://127.0.0.1:${port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
