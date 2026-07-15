import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import { AuthorityEngine, AuthorityStore } from "@bander/core";
import { buildBrokerApp } from "../apps/broker/src/app.js";
import { loadDraftFixtures } from "../apps/broker/src/fixtures.js";
import { MockServiceClient } from "../apps/broker/src/mock-client.js";
import {
  FileTelegramServiceStore,
  TelegramHttpApi,
  TelegramService,
} from "../apps/broker/src/telegram-service.js";
import { buildMockServices } from "../apps/mock-services/src/app.js";
import { loadVersionedSeed } from "../apps/mock-services/src/fixtures.js";
import { createHeroRuntimePaths } from "./hero-runtime.js";
import { buildOpenClawMockProvider } from "./openclaw-mock-provider.js";
import {
  applyPinnedTelegramPolicy,
  assertPinnedTelegramPolicy,
} from "./openclaw-telegram-config.js";
import { createRuntimeEnvironments } from "./process-env.js";

const dinnerRequest =
  "Move dinner with Sarah to 7:30 and tell her I’ll be 20 minutes late.";
const focusRequest = "Move my focus block to 10:30.";
const standingOptInRequest = "Handle my focus time automatically.";
const standingRequestId = "bander-hero-focus-request-0001";

async function waitForInstallation(
  store: FileTelegramServiceStore,
  timeoutMs = 10 * 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (store.read().installation) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Telegram pairing timed out. Start Hero mode again for a new link.");
}

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not reserve an OpenClaw gateway port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`OpenClaw configuration failed (${code}): ${stderr.slice(-800)}`));
    });
  });
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const banderToken = process.env.BANDER_TELEGRAM_BOT_TOKEN;
const openclawToken = process.env.OPENCLAW_TELEGRAM_BOT_TOKEN;
if (!banderToken || !openclawToken) {
  throw new Error("BANDER_TELEGRAM_BOT_TOKEN and OPENCLAW_TELEGRAM_BOT_TOKEN are required");
}

const paths = createHeroRuntimePaths();
for (const directory of [
  paths.root,
  paths.runRoot,
  paths.openclawState,
  paths.openclawHome,
  paths.workspace,
]) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

const serviceToken = randomBytes(32).toString("hex");
const mockServices = buildMockServices({ token: serviceToken, seed: loadVersionedSeed() });
const mockUrl = await mockServices.listen({ host: "127.0.0.1", port: 4311 });
const adapter = new MockServiceClient({ baseUrl: mockUrl, token: serviceToken });
const engine = new AuthorityEngine({ store: new AuthorityStore(), adapter });
const telegramStore = new FileTelegramServiceStore(paths.telegramState);
const priorInstallation = telegramStore.read().installation;
telegramStore.write({
  version: 1,
  ...(priorInstallation ? { installation: priorInstallation } : {}),
  proposals: [],
  standingCandidates: [],
  standingOutcomes: [],
});
const telegramService = new TelegramService({
  api: new TelegramHttpApi(banderToken),
  engine,
  store: telegramStore,
  mode: "hero",
});
telegramService.start();

let broker: ReturnType<typeof buildBrokerApp> | undefined;
let provider: ReturnType<typeof buildOpenClawMockProvider> | undefined;
let gateway: ChildProcess | undefined;
let gatewayLog: fs.WriteStream | undefined;
let shuttingDown = false;

try {
  if (!priorInstallation) {
    const pairing = await telegramService.createPairing();
    fs.writeFileSync(paths.pairingLink, `${pairing.link}\n`, { mode: 0o600 });
    fs.chmodSync(paths.pairingLink, 0o600);
    console.log(`Pair Bander using the private link in ${paths.pairingLink}`);
    await waitForInstallation(telegramStore);
  }
  const installation = telegramStore.read().installation;
  assert.ok(installation, "Telegram installation was not completed");

  const fixtures = loadDraftFixtures();
  broker = buildBrokerApp({
    engine,
    fixtures,
    heroMode: true,
    readHeroState: () => adapter.readDemoState(),
    proposeAgentStandingOptIn: (request) =>
      telegramService.proposeStandingOptIn(request),
    deliverAgentProposal: (card) => telegramService.deliverProposal(card),
    runAgentStandingAction: (fixture, requestId) =>
      telegramService.handleAgentAction(fixture, requestId, "openclaw-hero"),
    activateAgentStandingBand: (bandId) =>
      telegramService.activateStandingBand(bandId),
  });
  const webRoot = path.resolve("apps/web/dist");
  await broker.register(fastifyStatic, {
    root: webRoot,
    maxAge: "30d",
    immutable: true,
  });
  broker.get("/", async (_request, reply) =>
    reply.sendFile("index.html", { maxAge: 0, immutable: false }),
  );
  broker.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/") || request.url.startsWith("/mcp")) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Route not found" },
      });
    }
    return reply.sendFile("index.html", { maxAge: 0, immutable: false });
  });
  const brokerUrl = await broker.listen({ host: "127.0.0.1", port: 4310 });

  provider = buildOpenClawMockProvider({
    canonicalRequest: dinnerRequest,
    suppressBanderReplies: true,
    supportedRequests: [
      { request: dinnerRequest },
      { request: focusRequest, requestId: standingRequestId },
      { request: standingOptInRequest },
    ],
  });
  const providerUrl = await provider.app.listen({ host: "127.0.0.1", port: 4313 });

  const reference = JSON.parse(
    fs.readFileSync("openclaw/reference.openclaw.json", "utf8"),
  ) as Record<string, any>;
  reference.agents.defaults.workspace = paths.workspace;
  reference.agents.defaults.model.primary = "bander-hero/household-model";
  reference.models.providers["bander-hero"] = {
    ...reference.models.providers["bander-mock"],
    baseUrl: `${providerUrl}/v1`,
    models: [
      {
        ...reference.models.providers["bander-mock"].models[0],
        id: "household-model",
        name: "Bander household assistant",
      },
    ],
  };
  delete reference.models.providers["bander-mock"];
  reference.mcp.servers.bander.url = `${brokerUrl}/mcp`;
  reference.gateway = { mode: "local", bind: "loopback" };
  const config = applyPinnedTelegramPolicy(reference, installation);
  assertPinnedTelegramPolicy(config, installation);
  fs.writeFileSync(paths.openclawConfig, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });

  const environments = createRuntimeEnvironments(process.env);
  const openclawEnv: NodeJS.ProcessEnv = {
    ...environments.openclaw,
    HOME: paths.openclawHome,
    OPENCLAW_STATE_DIR: paths.openclawState,
    OPENCLAW_CONFIG_PATH: paths.openclawConfig,
    TELEGRAM_BOT_TOKEN: openclawToken,
    OPENCLAW_GATEWAY_TOKEN: randomBytes(32).toString("hex"),
  };
  assert.equal(openclawEnv.BANDER_TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(openclawEnv.MOCK_SERVICE_TOKEN, undefined);
  assert.equal(openclawEnv.CALENDAR_API_KEY, undefined);
  assert.equal(openclawEnv.MESSAGES_API_KEY, undefined);

  const node = path.resolve("node_modules/node/bin/node");
  const openclaw = path.resolve("node_modules/openclaw/openclaw.mjs");
  const validation = JSON.parse(
    await runCommand(node, [openclaw, "config", "validate", "--json"], openclawEnv),
  ) as { valid?: boolean };
  assert.equal(validation.valid, true, "OpenClaw rejected the pinned Hero configuration");
  const gatewayPort = await reservePort();
  gatewayLog = fs.createWriteStream(paths.gatewayLog, { flags: "a", mode: 0o600 });
  gateway = spawn(
    node,
    [
      openclaw,
      "gateway",
      "run",
      "--port",
      String(gatewayPort),
      "--bind",
      "loopback",
      "--auth",
      "token",
      "--compact",
    ],
    {
      cwd: process.cwd(),
      env: openclawEnv,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  gateway.stdout?.pipe(gatewayLog);
  gateway.stderr?.pipe(gatewayLog);
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  if (gateway.exitCode !== null) {
    throw new Error(`OpenClaw stopped during startup. See ${paths.gatewayLog}`);
  }

  console.log("Bander Hero mode is ready at http://127.0.0.1:4310");
  console.log("Press c in this terminal to make the demo dinner event change externally.");

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key) => {
      if (key === "c") {
        void adapter
          .simulateCalendarChange("event-dinner-sarah")
          .then(() => console.log("Demo Calendar changed externally."))
          .catch((error: unknown) => console.error((error as Error).message));
      }
      if (key === "\u0003") process.kill(process.pid, "SIGINT");
    });
  }

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    await stopChild(gateway);
    gatewayLog?.end();
    await provider?.app.close();
    await broker?.close();
    await mockServices.close();
    await telegramService.stop();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown().finally(() => process.exit(0));
    });
  }
  await new Promise(() => {});
} catch (error) {
  await stopChild(gateway);
  gatewayLog?.end();
  await provider?.app.close();
  await broker?.close();
  await mockServices.close();
  await telegramService.stop();
  throw error;
}
