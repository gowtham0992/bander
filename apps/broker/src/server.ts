import path from "node:path";
import fs from "node:fs";
import fastifyStatic from "@fastify/static";
import {
  AuthorityEngine,
  AuthorityStore,
  ExecutionAmbiguousError,
  ExecutionConflictError,
  ExecutionEmailRejectedError,
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
import { loadGoogleGmailOAuth } from "./google-gmail-oauth.js";
import { GoogleGmailBoundary } from "./google-gmail.js";
import { GmailReplyAdapter, GmailReplyError } from "./gmail.js";
import {
  GmailReadService,
  OpenAISolGmailReadIntentSelector,
} from "./gmail-read.js";
import {
  OpenAISolProductIntentRouter,
  RealProductDraftCompiler,
} from "./product-compiler.js";
import { MockServiceClient } from "./mock-client.js";
import { CompoundExecutionAdapter } from "./compound-action.js";
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
let readInboxService: GmailReadService | undefined;
let realGoogleAdapter: GoogleCalendarAdapter | undefined;
let realGmailBoundary: GoogleGmailBoundary | undefined;
let telegramService: TelegramService | undefined;

if (configuration.mode === "real") {
  const auth = await loadGoogleCalendarOAuth({
    clientPath: configuration.googleClientPath,
    tokenPath: configuration.googleTokenPath,
  });
  const googleAdapter = new GoogleCalendarAdapter(
    createGoogleCalendarBoundary(auth),
  );
  const gmailAuth = await loadGoogleGmailOAuth({
    clientPath: configuration.gmailClientPath,
    tokenPath: configuration.gmailTokenPath,
  });
  const gmailBoundary = new GoogleGmailBoundary(
    gmailAuth,
    configuration.calendarTimeZone,
    { dropSuccessfulSendResponseOnce: configuration.gmailDropSuccessfulResponseForEvidence },
  );
  realGmailBoundary = gmailBoundary;
  const gmailReply = new GmailReplyAdapter(gmailBoundary);
  realGoogleAdapter = googleAdapter;
  const authoritativeTimeZone = await googleAdapter.getAuthoritativeTimeZone();
  if (authoritativeTimeZone !== configuration.calendarTimeZone) {
    throw new Error(
      "BANDER_CALENDAR_TIME_ZONE does not match the connected primary Calendar",
    );
  }
  adapter = new CompoundExecutionAdapter({
    calendar: googleAdapter,
    deliver: async (input) => {
      if (!telegramService) {
        throw new Error("Real family delivery is not configured");
      }
      return telegramService.deliverBoundFamilyNotification(input);
    },
    reply: async ({ requestId, effect }) => {
      try {
        return await gmailReply.execute(requestId, effect);
      } catch (error) {
        if (error instanceof GmailReplyError) {
          if (error.code === "thread_changed") throw new ExecutionConflictError("email");
          if (error.code === "send_ambiguous") throw new ExecutionAmbiguousError("email");
          if (error.code === "send_rejected") throw new ExecutionEmailRejectedError();
        }
        throw error;
      }
    },
  });
  fixtures = new Map();
  readScheduleService = new ReadScheduleService({
    selector: new OpenAISolReadScheduleIntentSelector(configuration.openaiApiKey),
    backend: googleAdapter,
  });
  readInboxService = new GmailReadService({
    selector: new OpenAISolGmailReadIntentSelector(configuration.openaiApiKey),
    backend: gmailBoundary,
    timeZone: configuration.calendarTimeZone,
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
telegramService =
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
if (configuration.mode === "real") {
  if (!telegramService || !realGoogleAdapter) {
    throw new Error("Real Bander requires its independently paired Telegram service");
  }
  const calendarCompiler = createRealCalendarDraftCompiler({
    apiKey: configuration.openaiApiKey,
    calendar: realGoogleAdapter,
    calendarTimeZone: configuration.calendarTimeZone,
    familyContacts: {
      resolve: (alias) => telegramService!.resolveFamilyContactAlias(alias),
      activeDisplayLabel: () => {
        const status = telegramService!.familyContactStatus();
        return status.status === "connected" ? status.displayLabel : undefined;
      },
    },
  });
  if (!realGmailBoundary) throw new Error("Real Bander requires its Gmail boundary");
  compiler = new RealProductDraftCompiler({
    router: new OpenAISolProductIntentRouter(configuration.openaiApiKey, configuration.calendarTimeZone),
    calendar: calendarCompiler,
    gmail: realGmailBoundary,
    familyContacts: {
      resolve: (alias) => telegramService!.resolveFamilyContactAlias(alias),
      activeDisplayLabel: () => {
        const status = telegramService!.familyContactStatus();
        return status.status === "connected" ? status.displayLabel : undefined;
      },
    },
  });
}
const app = buildBrokerApp({
  engine,
  fixtures,
  runtimeMode: configuration.mode,
  ...(compiler ? { compiler } : {}),
  ...(compiler ? { agentCompiler: compiler } : {}),
  ...(readScheduleService
    ? { readSchedule: (request: string) => readScheduleService.read(request) }
    : {}),
  ...(readInboxService
    ? { readInbox: (request: string) => readInboxService.read(request) }
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
        readDemoState: () => mockAdapter.readDemoState(),
        simulateCalendarChange: () =>
          mockAdapter.simulateCalendarChange("event-dinner-sarah"),
        simulateCancellationCalendarChange: () =>
          mockAdapter.simulateCalendarChange("event-dentist"),
        prepareAmbiguousCalendarOutcome: () =>
          mockAdapter.prepareAmbiguousCalendarOutcome(),
        prepareAmbiguousEmailOutcome: () =>
          mockAdapter.prepareAmbiguousEmailOutcome(),
        simulateEmailThreadChange: () =>
          mockAdapter.simulateEmailThreadChange(),
        readDemoInbox: async () => (await mockAdapter.readDemoState()).inbox.filter((message) => message.subject === "Lunch next week"),
        readDemoSchedule: async () => {
          const state = await mockAdapter.readDemoState();
          const events = state.calendar
            .filter((event) => event.startTime.startsWith("2026-07-17"))
            .map((event) => ({
              title: event.title,
              allDay: false as const,
              start: { localDate: "2026-07-17", localTime: event.startTime.slice(11, 16) },
              end: { localDate: "2026-07-17", localTime: event.endTime.slice(11, 16) },
            }));
          return {
            requestedRange: {
              startLocalDate: "2026-07-17",
              endLocalDateExclusive: "2026-07-18",
            },
            timeZone: "America/Denver",
            events,
            empty: events.length === 0,
            truncated: false,
            maxEvents: 12,
          };
        },
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
