import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { Band, HumanReceipt, Permit, StoredDraft } from "@bander/contracts";
import { AuthorityEngine, AuthorityStore } from "@bander/core";
import { buildBrokerApp } from "../apps/broker/src/app.js";
import { loadDraftFixtures } from "../apps/broker/src/fixtures.js";
import { MockServiceClient } from "../apps/broker/src/mock-client.js";
import {
  FileTelegramServiceStore,
  TelegramHttpApi,
  TelegramService,
  type TelegramBotApi,
  type TelegramMessage,
  type TelegramUpdate,
} from "../apps/broker/src/telegram-service.js";
import { buildMockServices } from "../apps/mock-services/src/app.js";
import { loadVersionedSeed } from "../apps/mock-services/src/fixtures.js";
import { buildOpenClawMockProvider } from "./openclaw-mock-provider.js";
import {
  applyPinnedTelegramPolicy,
  assertPinnedTelegramPolicy,
  BANDER_OPENCLAW_TOOLS,
} from "./openclaw-telegram-config.js";
import { createRuntimeEnvironments } from "./process-env.js";

const canonicalRequest =
  "Move dinner with Sarah to 7:30 and tell her I’ll be 20 minutes late.";

class CountingAuthorityStore extends AuthorityStore {
  draftWrites = 0;
  oneTimeBandWrites = 0;
  permitWrites = 0;
  receiptWrites = 0;

  override saveDraft(draft: StoredDraft): void {
    this.draftWrites += 1;
    super.saveDraft(draft);
  }

  override saveBand(band: Band): void {
    if (band.mode === "one_time") this.oneTimeBandWrites += 1;
    super.saveBand(band);
  }

  override savePermit(permit: Permit): void {
    this.permitWrites += 1;
    super.savePermit(permit);
  }

  override saveReceipt(receipt: HumanReceipt): void {
    this.receiptWrites += 1;
    super.saveReceipt(receipt);
  }
}

class CountingMockServiceClient extends MockServiceClient {
  executionCalls = 0;

  override async executeDraft(
    input: Parameters<MockServiceClient["executeDraft"]>[0],
  ): Promise<void> {
    this.executionCalls += 1;
    await super.executeDraft(input);
  }
}

class RecordingTelegramApi implements TelegramBotApi {
  readonly messages: Array<{ chatId: string; text: string; messageId: number }> = [];
  readonly callbackAnswers: Array<{ id: string; text: string }> = [];
  readonly #delegate: TelegramHttpApi;

  constructor(token: string) {
    this.#delegate = new TelegramHttpApi(token);
  }

  getMe() {
    return this.#delegate.getMe();
  }

  getChat(chatId: string) {
    return this.#delegate.getChat(chatId);
  }

  getUpdates(offset?: number, timeout?: number) {
    return this.#delegate.getUpdates(offset, timeout);
  }

  async sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: Record<string, unknown>,
  ): Promise<TelegramMessage> {
    const message = await this.#delegate.sendMessage(chatId, text, replyMarkup);
    this.messages.push({ chatId, text, messageId: message.message_id });
    return message;
  }

  async answerCallback(id: string, text: string, showAlert = true): Promise<boolean> {
    this.callbackAnswers.push({ id, text });
    if (id.startsWith("synthetic:")) return true;
    return this.#delegate.answerCallback(id, text, showAlert);
  }
}

interface PriorSpikeIdentities {
  nonOwnerId: string;
  chatId: string;
  banderBotId: string;
  openclawBotId: string;
  openclawUsername: string;
}

function loadPriorIdentities(): PriorSpikeIdentities {
  const candidates = [
    path.resolve(".bander/telegram-spike-identities.json"),
    ...fs
      .readdirSync(".bander", { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name.startsWith("telegram-privacy-spike-"),
      )
      .map((entry) => path.resolve(".bander", entry.name, "identities.json")),
  ].filter((candidate) => fs.existsSync(candidate));
  for (const candidate of candidates.reverse()) {
    const value = JSON.parse(fs.readFileSync(candidate, "utf8")) as Partial<PriorSpikeIdentities>;
    if (
      value.nonOwnerId &&
      value.chatId &&
      value.banderBotId &&
      value.openclawBotId &&
      value.openclawUsername
    ) {
      return value as PriorSpikeIdentities;
    }
  }
  throw new Error("Validated Telegram adversary identity evidence is unavailable");
}

async function waitFor(
  label: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not reserve a local port"));
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
      else reject(new Error(`Command failed (${code}): ${stderr.slice(-1000)}`));
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

function readBundleText(root: string): string {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else files.push(target);
    }
  };
  visit(root);
  return files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
}

function sameTools(tools: string[]): boolean {
  return JSON.stringify([...tools].sort()) === JSON.stringify([...BANDER_OPENCLAW_TOOLS]);
}

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const banderToken = process.env.BANDER_TELEGRAM_BOT_TOKEN;
const openclawToken = process.env.OPENCLAW_TELEGRAM_BOT_TOKEN;
if (!banderToken || !openclawToken) {
  throw new Error("Both local Telegram bot tokens are required");
}

const prior = loadPriorIdentities();
const runId = `${Date.now()}-${randomBytes(4).toString("hex")}`;
const runRoot = path.resolve(`.bander/telegram-service-verification-${runId}`);
fs.mkdirSync(runRoot, { recursive: true, mode: 0o700 });
fs.chmodSync(runRoot, 0o700);

const serviceToken = randomBytes(32).toString("hex");
const mockServices = buildMockServices({ token: serviceToken, seed: loadVersionedSeed() });
const mockUrl = await mockServices.listen({ host: "127.0.0.1", port: 0 });
const adapter = new CountingMockServiceClient({ baseUrl: mockUrl, token: serviceToken });
const authorityStore = new CountingAuthorityStore();
const engine = new AuthorityEngine({ store: authorityStore, adapter });
const telegramApi = new RecordingTelegramApi(banderToken);
const telegramStore = new FileTelegramServiceStore(path.join(runRoot, "telegram-state.json"));
const telegramService = new TelegramService({ api: telegramApi, engine, store: telegramStore });
const pairing = await telegramService.createPairing();
const pairingPath = path.join(runRoot, "pairing-link.txt");
fs.writeFileSync(pairingPath, `${pairing.link}\nExpires: ${pairing.expiresAt}\n`, {
  mode: 0o600,
});
telegramService.start();

let broker: ReturnType<typeof buildBrokerApp> | undefined;
let provider: ReturnType<typeof buildOpenClawMockProvider> | undefined;
let gateway: ChildProcess | undefined;
let gatewayLog: fs.WriteStream | undefined;

try {
  console.log(`WAITING authenticated private pairing via ${pairingPath}`);
  await waitFor(
    "private owner pairing and group selection",
    () => Boolean(telegramStore.read().installation),
    10 * 60_000,
  );
  const installation = telegramStore.read().installation!;
  assert.equal(installation.chatId, prior.chatId, "Owner selected a different group");
  assert.notEqual(installation.ownerTelegramId, prior.nonOwnerId);
  console.log("PASS pairing: private token and private group picker consumed once");

  broker = buildBrokerApp({
    engine,
    fixtures: loadDraftFixtures(),
    deliverAgentProposal: (card) => telegramService.deliverProposal(card),
  });
  const brokerUrl = await broker.listen({ host: "127.0.0.1", port: 0 });
  provider = buildOpenClawMockProvider();
  const providerUrl = await provider.app.listen({ host: "127.0.0.1", port: 0 });

  const workspace = path.join(runRoot, "workspace");
  const stateDir = path.join(runRoot, "openclaw-state");
  const home = path.join(runRoot, "openclaw-home");
  for (const directory of [workspace, stateDir, home]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const reference = JSON.parse(
    fs.readFileSync("openclaw/reference.openclaw.json", "utf8"),
  ) as Record<string, any>;
  reference.agents.defaults.workspace = workspace;
  reference.models.providers["bander-mock"].baseUrl = `${providerUrl}/v1`;
  reference.mcp.servers.bander.url = `${brokerUrl}/mcp`;
  reference.gateway = { mode: "local", bind: "loopback" };
  const config = applyPinnedTelegramPolicy(reference, installation);
  assertPinnedTelegramPolicy(config, installation);
  const configPath = path.join(runRoot, "openclaw.json");
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  const environments = createRuntimeEnvironments(process.env);
  const openclawEnv: NodeJS.ProcessEnv = {
    ...environments.openclaw,
    HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
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
  assert.equal(validation.valid, true);
  const gatewayPort = await reservePort();
  gatewayLog = fs.createWriteStream(path.join(runRoot, "openclaw-gateway.log"), {
    flags: "a",
    mode: 0o600,
  });
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
    { cwd: process.cwd(), env: openclawEnv, shell: false, stdio: ["ignore", "pipe", "pipe"] },
  );
  gateway.stdout?.pipe(gatewayLog);
  gateway.stderr?.pipe(gatewayLog);
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  assert.equal(gateway.exitCode, null);
  console.log("PASS OpenClaw: pinned policy and isolated environment validated");

  await telegramApi.sendMessage(
    installation.chatId,
    ["Real Bander service ready.", "Owner: send this natural request:", canonicalRequest].join("\n"),
  );
  console.log("WAITING owner natural request");
  await waitFor(
    "OpenClaw proposal and Bander Card",
    () => telegramStore.read().proposals.length === 1,
    5 * 60_000,
  );
  const binding = telegramStore.read().proposals[0]!;
  const card = engine.getCard(binding.draftId);
  assert.ok(provider.evidence.toolResult);
  assert.deepEqual(Object.keys(JSON.parse(provider.evidence.toolResult)).sort(), ["draftId", "status"]);
  assert.equal(JSON.parse(provider.evidence.toolResult).status, "proposed");
  console.log("PASS proposal: real service posted Card; MCP returned minimal status");

  const beforeSynthetic = {
    bands: authorityStore.oneTimeBandWrites,
    permits: authorityStore.permitWrites,
    executions: adapter.executionCalls,
  };
  const syntheticCallbacks = [
    { id: "synthetic:wrong-chat", chatId: Number(binding.chatId) - 1, messageId: binding.messageId, data: binding.callbackValue },
    { id: "synthetic:wrong-message", chatId: Number(binding.chatId), messageId: binding.messageId + 1, data: binding.callbackValue },
    { id: "synthetic:wrong-value", chatId: Number(binding.chatId), messageId: binding.messageId, data: "bander:wrong-value" },
  ];
  for (const candidate of syntheticCallbacks) {
    const update: TelegramUpdate = {
      update_id: -1,
      callback_query: {
        id: candidate.id,
        from: { id: Number(installation.ownerTelegramId), is_bot: false },
        data: candidate.data,
        message: {
          message_id: candidate.messageId,
          chat: { id: candidate.chatId, type: "supergroup" },
        },
      },
    };
    await telegramService.handleUpdate(update);
  }
  assert.deepEqual(
    {
      bands: authorityStore.oneTimeBandWrites,
      permits: authorityStore.permitWrites,
      executions: adapter.executionCalls,
    },
    beforeSynthetic,
  );
  console.log("PASS surface rejection: wrong chat, message and callback created no authority");

  console.log("WAITING non-owner tap, then two owner taps on the genuine Bander Card");
  await waitFor(
    "non-owner rejection",
    () =>
      telegramApi.callbackAnswers.some((answer) =>
        answer.text.includes("bound to its owner"),
      ),
    5 * 60_000,
  );
  assert.equal(adapter.executionCalls, 0);
  await waitFor(
    "owner execution and replay",
    () =>
      telegramApi.callbackAnswers.some((answer) => answer.text.includes("completed exactly")) &&
      telegramApi.callbackAnswers.some((answer) => answer.text.includes("Nothing ran again")),
    8 * 60_000,
  );
  const completedBinding = telegramStore.read().proposals[0]!;
  assert.equal(completedBinding.lifecycle, "executed");
  assert.equal(authorityStore.oneTimeBandWrites, 1);
  assert.equal(authorityStore.permitWrites, 1);
  assert.equal(adapter.executionCalls, 1);
  assert.equal(authorityStore.receiptWrites, 1);
  assert.ok(completedBinding.receiptId);
  const receipt = engine.getHumanReceipt(completedBinding.receiptId);
  assert.equal(
    telegramApi.messages.filter((message) => message.text.includes(`Receipt: ${receipt.id}`)).length,
    1,
  );
  console.log("PASS approval: non-owner denied; owner replay returned one Receipt and execution");

  const openclawApi = new TelegramHttpApi(openclawToken);
  const imitationData = `openclaw:${randomBytes(18).toString("base64url")}`;
  await openclawApi.sendMessage(
    installation.chatId,
    "OpenClaw imitation probe. This must not approve through Bander.",
    { inline_keyboard: [[{ text: "Imitated Bander approval", callback_data: imitationData }]] },
  );
  console.log("WAITING owner tap on OpenClaw imitation button");
  await waitFor(
    "OpenClaw imitation callback",
    () => provider!.evidence.modelInputTexts.some((text) => text.includes(imitationData)),
    5 * 60_000,
  );
  assert.equal(authorityStore.oneTimeBandWrites, 1);
  assert.equal(authorityStore.permitWrites, 1);
  assert.equal(adapter.executionCalls, 1);
  assert.equal(authorityStore.receiptWrites, 1);
  assert.ok(provider.evidence.toolInventories.every(sameTools));
  console.log("PASS imitation: OpenClaw callback created no Bander authority");

  const modelInputs = provider.evidence.modelInputTexts.join("\n");
  for (const forbidden of [
    binding.callbackValue,
    card.title,
    card.draftHash,
    ...card.allows,
    receipt.id,
    receipt.summary,
    receipt.detail,
  ]) {
    assert.equal(modelInputs.includes(forbidden), false);
  }

  await stopChild(gateway);
  gateway = undefined;
  gatewayLog.end();
  const sessions = JSON.parse(
    await runCommand(node, [openclaw, "sessions", "--json"], openclawEnv),
  ) as { sessions?: Array<{ key?: string }> };
  const sessionKey = `agent:main:telegram:group:${installation.chatId}`;
  assert.ok(sessions.sessions?.some((session) => session.key === sessionKey));
  const exportName = `privacy-${runId}`;
  await runCommand(
    node,
    [
      openclaw,
      "sessions",
      "export-trajectory",
      "--session-key",
      sessionKey,
      "--workspace",
      workspace,
      "--output",
      exportName,
      "--json",
    ],
    openclawEnv,
  );
  const bundlePath = path.join(workspace, ".openclaw", "trajectory-exports", exportName);
  const bundleText = readBundleText(bundlePath);
  for (const forbidden of [
    binding.callbackValue,
    card.title,
    card.draftHash,
    ...card.allows,
    receipt.id,
    receipt.summary,
    receipt.detail,
  ]) {
    assert.equal(bundleText.includes(forbidden), false);
  }
  assert.equal(bundleText.includes("bander__propose_action"), true);
  assert.equal(bundleText.includes(imitationData), true);

  const evidence = {
    status: "passed",
    service: "real Bander Telegram service",
    authenticatedPairing: "private single-use token plus private chat picker",
    effectiveTools: BANDER_OPENCLAW_TOOLS,
    mcpProposalFields: ["draftId", "status"],
    rejected: ["non-owner", "wrong chat", "wrong message", "wrong callback", "OpenClaw imitation"],
    authority: {
      drafts: authorityStore.draftWrites,
      bands: authorityStore.oneTimeBandWrites,
      permits: authorityStore.permitWrites,
      executions: adapter.executionCalls,
      receipts: authorityStore.receiptWrites,
    },
    privacy: {
      cardAbsentFromModelAndTrajectory: true,
      genuineCallbackAbsentFromOpenClaw: true,
      receiptAbsentFromModelAndTrajectory: true,
      banderTokenAbsentFromOpenClawEnvironment: true,
    },
    evidenceDirectory: path.relative(process.cwd(), runRoot),
  };
  fs.writeFileSync(path.join(runRoot, "result.json"), `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await stopChild(gateway);
  gatewayLog?.end();
  await telegramService.stop();
  await Promise.allSettled([broker?.close(), mockServices.close(), provider?.app.close()]);
}
