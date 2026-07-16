import path from "node:path";
import fs from "node:fs";
import fastifyStatic from "@fastify/static";
import {
  AuthorityEngine,
  AuthorityStore,
  type DraftFixture,
  type ExecutionAdapter,
} from "@bander/core";
import { buildBrokerApp } from "./app.js";
import {
  createOpenAIDraftCompiler,
  createRealCalendarDraftCompiler,
  type DraftCompiler,
} from "./compiler.js";
import { loadDraftFixtures } from "./fixtures.js";
import {
  GoogleCalendarAdapter,
  createGoogleCalendarBoundary,
} from "./google-calendar.js";
import { loadGoogleCalendarOAuth } from "./google-oauth.js";
import { MockServiceClient } from "./mock-client.js";
import {
  OpenAISolReadScheduleIntentSelector,
  ReadScheduleService,
} from "./read-schedule.js";
import { parseRuntimeConfiguration } from "./runtime-config.js";
import {
  FileTelegramServiceStore,
  TelegramHttpApi,
  TelegramService,
} from "./telegram-service.js";

const port = Number.parseInt(process.env.BANDER_PORT ?? "4310", 10);
const configuration = parseRuntimeConfiguration(process.env);
let adapter: ExecutionAdapter;
let mockAdapter: MockServiceClient | undefined;
let fixtures: Map<string, DraftFixture>;
let compiler: DraftCompiler | undefined;
let readScheduleService: ReadScheduleService | undefined;

if (configuration.mode === "real") {
  const auth = await loadGoogleCalendarOAuth({
    clientPath: configuration.googleClientPath,
    tokenPath: configuration.googleTokenPath,
  });
  const googleAdapter = new GoogleCalendarAdapter(
    createGoogleCalendarBoundary(auth),
  );
  const authoritativeTimeZone = await googleAdapter.getAuthoritativeTimeZone();
  if (authoritativeTimeZone !== configuration.calendarTimeZone) {
    throw new Error(
      "BANDER_CALENDAR_TIME_ZONE does not match the connected primary Calendar",
    );
  }
  adapter = googleAdapter;
  fixtures = new Map();
  compiler = createRealCalendarDraftCompiler({
    apiKey: configuration.openaiApiKey,
    calendar: googleAdapter,
    calendarTimeZone: configuration.calendarTimeZone,
  });
  readScheduleService = new ReadScheduleService({
    selector: new OpenAISolReadScheduleIntentSelector(configuration.openaiApiKey),
    backend: googleAdapter,
  });
} else {
  mockAdapter = new MockServiceClient({
    baseUrl: configuration.mockServiceUrl,
    token: configuration.mockServiceToken,
  });
  adapter = mockAdapter;
  fixtures = loadDraftFixtures();
  compiler = configuration.openaiApiKey
    ? createOpenAIDraftCompiler(configuration.openaiApiKey, fixtures)
    : undefined;
}
const store = new AuthorityStore();
const engine = new AuthorityEngine({ store, adapter });
const telegramToken = configuration.telegramToken;
const telegramStore = telegramToken
  ? new FileTelegramServiceStore(configuration.telegramStatePath)
  : undefined;
const telegramService =
  telegramToken && telegramStore
    ? new TelegramService({
        api: new TelegramHttpApi(telegramToken),
        engine,
        store: telegramStore,
        ...(configuration.mode === "real" ? { mode: "real" as const } : {}),
        ...(configuration.mode === "real"
          ? {
              familyPairingPath: path.resolve(
                configuration.familyContactPairingPath,
              ),
            }
          : {}),
      })
    : undefined;
const app = buildBrokerApp({
  engine,
  fixtures,
  runtimeMode: configuration.mode,
  ...(compiler ? { compiler } : {}),
  ...(compiler ? { agentCompiler: compiler } : {}),
  ...(readScheduleService
    ? { readSchedule: (request: string) => readScheduleService.read(request) }
    : {}),
  ...(telegramService
    ? {
        deliverAgentProposal: (card) => telegramService.deliverProposal(card),
        deliverAgentClarification: (message) =>
          telegramService.deliverClarification(message),
        ...(configuration.mode === "sandbox"
          ? {
              proposeAgentStandingOptIn: (request: string) =>
                telegramService.proposeStandingOptIn(request),
              runAgentStandingAction: (
                fixture: DraftFixture,
                requestId?: string,
              ) =>
                telegramService.handleAgentAction(
                  fixture,
                  requestId,
                  "openclaw-reference",
                ),
              activateAgentStandingBand: (bandId: string) =>
                telegramService.activateStandingBand(bandId),
            }
          : {}),
      }
    : {}),
  ...(configuration.mode === "sandbox" && mockAdapter
    ? {
        resetDemo: async () => {
          engine.resetDemo();
          await mockAdapter.resetDemo();
        },
        simulateCalendarChange: () =>
          mockAdapter.simulateCalendarChange("event-dinner-sarah"),
      }
    : {}),
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

if (telegramService && telegramStore) {
  if (!telegramStore.read().installation) {
    const pairing = await telegramService.createPairing();
    const pairingPath = path.resolve(
      configuration.telegramPairingPath,
    );
    const pairingDirectory = path.dirname(pairingPath);
    fs.mkdirSync(pairingDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(pairingDirectory, 0o700);
    fs.writeFileSync(
      pairingPath,
      `${pairing.link}\nExpires: ${pairing.expiresAt}\n`,
      { mode: 0o600 },
    );
    fs.chmodSync(pairingPath, 0o600);
    console.log(`Bander Telegram pairing link written to ${pairingPath}`);
  }
  if (configuration.mode === "real") {
    await telegramService.prepareForStart();
    const family = telegramService.familyContactStatus();
    console.log(
      family.status === "connected"
        ? `Family contact: connected as ${family.displayLabel}`
        : family.status === "revoked"
          ? "Family contact: revoked"
          : "Family contact: not connected",
    );
  }
  telegramService.start();
  console.log("Bander Telegram service started");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await telegramService?.stop();
    await app.close();
    process.exit(0);
  });
}
