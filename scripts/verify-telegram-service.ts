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
  type TelegramInstallation,
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

const oneTimeRequest =
  "Move dinner with Sarah to 7:30 and tell her I’ll be 20 minutes late.";
const standingRequest = "Move my focus block to 10:30.";
const standingOptInRequest = "Handle my focus time automatically.";
const standingRequestId = "openclaw-telegram-standing-0001";
const conflictExplanation =
  "Stopped — your calendar changed\nI didn’t move the event or send the message.\nAsk OpenClaw to check again.";
const declineExplanation =
  "Nothing changed.\nAsk OpenClaw again if you want something different.";
const scenario =
  process.env.BANDER_TELEGRAM_VERIFY_SCENARIO === "conflict" ||
  process.env.BANDER_TELEGRAM_VERIFY_SCENARIO === "standing"
    ? process.env.BANDER_TELEGRAM_VERIFY_SCENARIO
    : "success";
const canonicalRequest = scenario === "standing" ? standingRequest : oneTimeRequest;

class CountingAuthorityStore extends AuthorityStore {
  draftWrites = 0;
  oneTimeBandWrites = 0;
  standingBandWrites = 0;
  permitWrites = 0;
  receiptWrites = 0;

  override saveDraft(draft: StoredDraft): void {
    this.draftWrites += 1;
    super.saveDraft(draft);
  }

  override saveBand(band: Band): void {
    if (band.mode === "one_time") this.oneTimeBandWrites += 1;
    if (band.mode === "standing") this.standingBandWrites += 1;
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

function loadAuthenticatedInstallation(): TelegramInstallation | undefined {
  const candidates = fs
    .readdirSync(".bander", { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith("telegram-service-verification-"),
    )
    .map((entry) => path.resolve(".bander", entry.name, "telegram-state.json"))
    .filter((candidate) => fs.existsSync(candidate))
    .sort()
    .reverse();
  for (const candidate of candidates) {
    const state = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
      installation?: TelegramInstallation;
    };
    if (state.installation) return state.installation;
  }
  return undefined;
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
const runRoot = path.resolve(
  `.bander/telegram-service-verification-${scenario}-${runId}`,
);
fs.mkdirSync(runRoot, { recursive: true, mode: 0o700 });
fs.chmodSync(runRoot, 0o700);

const serviceToken = randomBytes(32).toString("hex");
const mockServices = buildMockServices({ token: serviceToken, seed: loadVersionedSeed() });
const mockUrl = await mockServices.listen({ host: "127.0.0.1", port: 0 });
const adapter = new CountingMockServiceClient({ baseUrl: mockUrl, token: serviceToken });
const authorityStore = new CountingAuthorityStore();
const engine = new AuthorityEngine({ store: authorityStore, adapter });
const fixtures = loadDraftFixtures();
const telegramApi = new RecordingTelegramApi(banderToken);
const telegramStore = new FileTelegramServiceStore(path.join(runRoot, "telegram-state.json"));
const telegramService = new TelegramService({ api: telegramApi, engine, store: telegramStore });
const reusedInstallation =
  process.env.BANDER_TELEGRAM_FORCE_FRESH_PAIRING === "1"
    ? undefined
    : loadAuthenticatedInstallation();
let pairingPath: string | undefined;
if (reusedInstallation) {
  telegramStore.write({
    version: 1,
    installation: reusedInstallation,
    proposals: [],
    standingCandidates: [],
    standingOutcomes: [],
  });
} else {
  const pairing = await telegramService.createPairing();
  pairingPath = path.join(runRoot, "pairing-link.txt");
  fs.writeFileSync(
    pairingPath,
    `${pairing.link}\nExpires: ${pairing.expiresAt}\n`,
    { mode: 0o600 },
  );
}
telegramService.start();

let broker: ReturnType<typeof buildBrokerApp> | undefined;
let provider: ReturnType<typeof buildOpenClawMockProvider> | undefined;
let gateway: ChildProcess | undefined;
let gatewayLog: fs.WriteStream | undefined;

try {
  if (pairingPath) {
    console.log(`WAITING authenticated private pairing via ${pairingPath}`);
    await waitFor(
      "private owner pairing and group selection",
      () => Boolean(telegramStore.read().installation),
      10 * 60_000,
    );
    console.log("PASS pairing: private token and private group picker consumed once");
  } else {
    console.log("PASS pairing: reused the previously authenticated installation");
  }
  const installation = telegramStore.read().installation!;
  assert.equal(installation.chatId, prior.chatId, "Owner selected a different group");
  assert.notEqual(installation.ownerTelegramId, prior.nonOwnerId);

  let standingBandId: string | undefined;

  broker = buildBrokerApp({
    engine,
    fixtures,
    proposeAgentStandingOptIn: (request) =>
      telegramService.proposeStandingOptIn(request),
    deliverAgentProposal: (card) => telegramService.deliverProposal(card),
    runAgentStandingAction: (fixture, requestId) =>
      telegramService.handleAgentAction(
        fixture,
        requestId,
        "openclaw-reference",
      ),
    activateAgentStandingBand: (bandId) =>
      telegramService.activateStandingBand(bandId),
  });
  const brokerUrl = await broker.listen({ host: "127.0.0.1", port: 0 });
  provider = buildOpenClawMockProvider(
    scenario === "standing"
      ? {
          canonicalRequest: standingRequest,
          supportedRequests: [
            { request: standingOptInRequest },
            { request: standingRequest, requestId: standingRequestId },
          ],
        }
      : scenario === "success"
        ? {
            canonicalRequest: oneTimeRequest,
            supportedRequests: [
              { request: oneTimeRequest },
              { request: standingRequest },
            ],
          }
        : {},
  );
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

  if (scenario === "standing") {
    await telegramApi.sendMessage(
      installation.chatId,
      [
        "Owner: first ask OpenClaw to prepare automatic handling:",
        standingOptInRequest,
      ].join("\n"),
    );
    console.log("WAITING owner natural standing opt-in request");
    await waitFor(
      "OpenClaw standing candidate and Bander opt-in message",
      () =>
        telegramStore.read().standingCandidates.length === 1 &&
        provider!.evidence.toolResults.some((value) => {
          try {
            return JSON.parse(value).status === "proposed";
          } catch {
            return false;
          }
        }),
      5 * 60_000,
    );
    const activation = telegramStore.read().standingCandidates[0]!;
    const activationMessage = telegramApi.messages.find(
      (message) => message.messageId === activation.messageId,
    );
    assert.ok(activationMessage);
    for (const clause of [
      "Move events you organize and attend alone",
      "Keep them the same length",
      "Keep them within weekdays, 9 AM–5 PM",
      "Make at most 3 automatic moves per day",
      "Never message anyone or spend money",
    ]) {
      assert.equal(activationMessage.text.includes(clause), true);
    }
    assert.equal(authorityStore.standingBandWrites, 0);
    assert.equal(adapter.executionCalls, 0);

    const deniedActivations = [
      {
        id: "synthetic:activation-non-owner",
        fromId: Number(prior.nonOwnerId),
        chatId: Number(activation.chatId),
        messageId: activation.messageId,
        botId: Number(activation.botTelegramId),
        data: activation.approveCallbackValue,
      },
      {
        id: "synthetic:activation-wrong-chat",
        fromId: Number(installation.ownerTelegramId),
        chatId: Number(activation.chatId) - 1,
        messageId: activation.messageId,
        botId: Number(activation.botTelegramId),
        data: activation.approveCallbackValue,
      },
      {
        id: "synthetic:activation-wrong-message",
        fromId: Number(installation.ownerTelegramId),
        chatId: Number(activation.chatId),
        messageId: activation.messageId + 1,
        botId: Number(activation.botTelegramId),
        data: activation.approveCallbackValue,
      },
      {
        id: "synthetic:activation-wrong-bot",
        fromId: Number(installation.ownerTelegramId),
        chatId: Number(activation.chatId),
        messageId: activation.messageId,
        botId: Number(activation.botTelegramId) + 1,
        data: activation.approveCallbackValue,
      },
      {
        id: "synthetic:activation-wrong-control",
        fromId: Number(installation.ownerTelegramId),
        chatId: Number(activation.chatId),
        messageId: activation.messageId,
        botId: Number(activation.botTelegramId),
        data: "bander-auto:wrong-value",
      },
    ];
    for (const denied of deniedActivations) {
      await telegramService.handleUpdate({
        update_id: -1,
        callback_query: {
          id: denied.id,
          from: { id: denied.fromId, is_bot: false },
          data: denied.data,
          message: {
            message_id: denied.messageId,
            from: { id: denied.botId, is_bot: true },
            chat: { id: denied.chatId, type: "supergroup" },
          },
        },
      });
    }
    assert.equal(authorityStore.standingBandWrites, 0);
    console.log(
      "PASS standing opt-in rejection: wrong user, chat, message, bot and callback created no authority",
    );

    console.log("WAITING owner tap on genuine Turn on automatic");
    await waitFor(
      "owner Telegram standing activation",
      () => telegramStore.read().standingCandidates[0]?.lifecycle === "activated",
      5 * 60_000,
    );
    standingBandId = telegramStore.read().standingBand?.bandId;
    assert.ok(standingBandId);
    await telegramService.handleUpdate({
      update_id: -1,
      callback_query: {
        id: "synthetic:activation-owner-replay",
        from: { id: Number(installation.ownerTelegramId), is_bot: false },
        data: activation.approveCallbackValue,
        message: {
          message_id: activation.messageId,
          from: { id: Number(activation.botTelegramId), is_bot: true },
          chat: { id: Number(activation.chatId), type: "supergroup" },
        },
      },
    });
    assert.equal(authorityStore.standingBandWrites, 1);
    assert.equal(
      telegramApi.messages.filter((message) =>
        message.text.startsWith("Automatic handling is on."),
      ).length,
      1,
    );
    const activatedBand = authorityStore.getBand(standingBandId);
    assert.ok(activatedBand && activatedBand.mode === "standing");
    authorityStore.updateBand({
      ...activatedBand,
      actionTimestamps: [new Date(Date.now() - 60 * 60_000).toISOString()],
    });
    console.log(
      "PASS standing opt-in: Telegram-only owner activation minted one replay-safe authority",
    );

    const standingFixture = fixtures.get("move-my-focus-block");
    assert.ok(standingFixture);
    await telegramApi.sendMessage(
      installation.chatId,
      [
        "Real Bander standing service ready.",
        "Owner: send this natural request:",
        standingRequest,
      ].join("\n"),
    );
    console.log("WAITING owner natural standing request");
    await waitFor(
      "OpenClaw standing execution and Bander outcome",
      () =>
        telegramStore.read().standingOutcomes.length === 1 &&
        provider!.evidence.toolResults.some((value) => {
          try {
            return JSON.parse(value).status === "executed";
          } catch {
            return false;
          }
        }),
      5 * 60_000,
    );
    const outcome = telegramStore.read().standingOutcomes[0]!;
    const receipt = engine.getHumanReceipt(outcome.receiptId);
    const executedToolResult = provider.evidence.toolResults.findLast((value) => {
      try {
        return JSON.parse(value).status === "executed";
      } catch {
        return false;
      }
    });
    assert.ok(executedToolResult);
    const agentStatus = JSON.parse(executedToolResult) as Record<
      string,
      unknown
    >;
    assert.deepEqual(Object.keys(agentStatus).sort(), ["draftId", "status"]);
    assert.deepEqual(agentStatus, {
      draftId: outcome.draftId,
      status: "executed",
    });
    assert.equal(outcome.lifecycle, "delivered");
    assert.ok(outcome.messageId);
    const outcomeMessages = telegramApi.messages.filter((message) =>
      message.text.startsWith("Handled automatically ✓"),
    );
    assert.equal(outcomeMessages.length, 1);
    const outcomeText = outcomeMessages[0]!.text;
    assert.match(outcomeText, /“Focus block”/);
    assert.match(
      outcomeText,
      /Wed, Jul 15, 10:00–11:00 AM MDT → Wed, Jul 15, 10:30–11:30 AM MDT/,
    );
    assert.match(outcomeText, /No one was messaged/);
    assert.match(outcomeText, /2 of 3 automatic moves used today\./);
    assert.equal(authorityStore.draftWrites, 1);
    assert.equal(authorityStore.standingBandWrites, 1);
    assert.equal(authorityStore.permitWrites, 1);
    assert.equal(adapter.executionCalls, 1);
    assert.equal(authorityStore.receiptWrites, 1);
    const completedBand = authorityStore.getBand(standingBandId);
    assert.ok(completedBand && completedBand.mode === "standing");
    assert.equal(completedBand.actionTimestamps.length, 2);
    console.log(
      "PASS standing execution: minimal MCP status, one effect, one Receipt, counter 2 of 3",
    );

    const deniedCallbacks = [
      {
        id: "synthetic:standing-non-owner",
        fromId: Number(prior.nonOwnerId),
        chatId: Number(outcome.chatId),
        messageId: outcome.messageId,
        data: outcome.callbackValue,
      },
      {
        id: "synthetic:standing-wrong-chat",
        fromId: Number(installation.ownerTelegramId),
        chatId: Number(outcome.chatId) - 1,
        messageId: outcome.messageId,
        data: outcome.callbackValue,
      },
      {
        id: "synthetic:standing-wrong-message",
        fromId: Number(installation.ownerTelegramId),
        chatId: Number(outcome.chatId),
        messageId: outcome.messageId + 1,
        data: outcome.callbackValue,
      },
      {
        id: "synthetic:standing-wrong-callback",
        fromId: Number(installation.ownerTelegramId),
        chatId: Number(outcome.chatId),
        messageId: outcome.messageId,
        data: "bander-off:wrong-value",
      },
    ];
    for (const denied of deniedCallbacks) {
      await telegramService.handleUpdate({
        update_id: -1,
        callback_query: {
          id: denied.id,
          from: { id: denied.fromId, is_bot: false },
          data: denied.data,
          message: {
            message_id: denied.messageId,
            chat: { id: denied.chatId, type: "supergroup" },
          },
        },
      });
    }
    assert.equal(authorityStore.getBand(standingBandId)?.status, "active");
    assert.equal(adapter.executionCalls, 1);
    console.log("PASS standing surface rejection: wrong user, chat, message and callback denied");

    console.log("WAITING owner tap on the genuine Bander Turn off button");
    await waitFor(
      "owner standing revoke",
      () =>
        telegramApi.callbackAnswers.some((answer) =>
          answer.text.includes("Automatic handling is off"),
        ),
      5 * 60_000,
    );
    const revokedAt = telegramStore.read().standingOutcomes[0]?.revokedAt;
    assert.ok(revokedAt);
    await telegramService.handleUpdate({
      update_id: -1,
      callback_query: {
        id: "synthetic:standing-owner-replay",
        from: { id: Number(installation.ownerTelegramId), is_bot: false },
        data: outcome.callbackValue,
        message: {
          message_id: outcome.messageId,
          chat: { id: Number(outcome.chatId), type: "supergroup" },
        },
      },
    });
    assert.equal(telegramStore.read().standingOutcomes[0]?.revokedAt, revokedAt);
    assert.equal(authorityStore.getBand(standingBandId)?.status, "revoked");
    assert.equal(telegramStore.read().standingBand, undefined);
    assert.equal(
      telegramApi.messages.filter((message) =>
        message.text.startsWith("Automatic handling is off."),
      ).length,
      1,
    );
    assert.equal(adapter.executionCalls, 1);
    assert.equal(authorityStore.receiptWrites, 1);
    console.log("PASS standing revoke: idempotent, detached, and consumer opt-out delivered");

    await telegramApi.sendMessage(
      installation.chatId,
      [
        "Owner: send the same request again. It must become a one-time deal:",
        standingRequest,
      ].join("\n"),
    );
    console.log("WAITING next owner request to become a one-time Bander Card");
    await waitFor(
      "post-revoke one-time proposal",
      () =>
        telegramStore.read().proposals.length === 1 &&
        provider!.evidence.toolResults.some((value) => {
          try {
            return JSON.parse(value).status === "proposed";
          } catch {
            return false;
          }
        }),
      5 * 60_000,
    );
    const oneTimeBinding = telegramStore.read().proposals[0]!;
    const oneTimeCard = engine.getCard(oneTimeBinding.draftId);
    assert.equal(oneTimeCard.claimedUserRequest, standingRequest);
    assert.equal(engine.getAgentReceipt(oneTimeBinding.draftId).status, "proposed");
    assert.equal(authorityStore.oneTimeBandWrites, 0);
    assert.equal(authorityStore.permitWrites, 1);
    assert.equal(adapter.executionCalls, 1);
    assert.equal(authorityStore.receiptWrites, 1);
    console.log("PASS post-revoke loop: next request produced a one-time Card; no execution");

    const modelInputs = provider.evidence.modelInputTexts.join("\n");
    for (const forbidden of [
      activation.approveCallbackValue,
      activation.declineCallbackValue,
      activation.candidateId,
      activation.predicateHash,
      activationMessage.text,
      outcome.callbackValue,
      receipt.id,
      receipt.summary,
      receipt.detail,
      outcomeText,
      "Handled automatically ✓",
      "2 of 3 automatic moves used today.",
      oneTimeBinding.callbackValue,
      oneTimeCard.title,
      oneTimeCard.draftHash,
      ...oneTimeCard.allows,
    ]) {
      assert.equal(modelInputs.includes(forbidden), false);
    }
    assert.ok(provider.evidence.toolInventories.every(sameTools));

    await stopChild(gateway);
    gateway = undefined;
    gatewayLog.end();
    const sessions = JSON.parse(
      await runCommand(node, [openclaw, "sessions", "--json"], openclawEnv),
    ) as { sessions?: Array<{ key?: string }> };
    const sessionKey = `agent:main:telegram:group:${installation.chatId}`;
    assert.ok(sessions.sessions?.some((session) => session.key === sessionKey));
    const exportName = `privacy-standing-${runId}`;
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
    const bundlePath = path.join(
      workspace,
      ".openclaw",
      "trajectory-exports",
      exportName,
    );
    const bundleText = readBundleText(bundlePath);
    for (const forbidden of [
      activation.approveCallbackValue,
      activation.declineCallbackValue,
      activation.candidateId,
      activation.predicateHash,
      activationMessage.text,
      outcome.callbackValue,
      receipt.id,
      receipt.summary,
      receipt.detail,
      outcomeText,
      "Handled automatically ✓",
      "2 of 3 automatic moves used today.",
      oneTimeBinding.callbackValue,
      oneTimeCard.title,
      oneTimeCard.draftHash,
      ...oneTimeCard.allows,
    ]) {
      assert.equal(bundleText.includes(forbidden), false);
    }
    assert.equal(bundleText.includes("bander__propose_action"), true);

    const evidence = {
      status: "passed",
      scenario,
      service: "real Bander Telegram service",
      effectiveTools: BANDER_OPENCLAW_TOOLS,
      mcpResultFields: ["draftId", "status"],
      humanOutcome: outcomeText,
      rejected: [
        "activation non-owner",
        "activation wrong chat",
        "activation wrong message",
        "activation wrong bot",
        "activation wrong callback",
        "revocation non-owner",
        "revocation wrong chat",
        "revocation wrong message",
        "revocation wrong callback",
      ],
      authority: {
        drafts: authorityStore.draftWrites,
        standingBands: authorityStore.standingBandWrites,
        permits: authorityStore.permitWrites,
        downstreamDispatches: adapter.executionCalls,
        receipts: authorityStore.receiptWrites,
        oneTimeCardsPending: telegramStore.read().proposals.length,
        oneTimeBands: authorityStore.oneTimeBandWrites,
        actionsUsed: completedBand.actionTimestamps.length,
        maxActions: completedBand.predicate.limits.maxActions,
        revoked: authorityStore.getBand(standingBandId)?.status === "revoked",
      },
      privacy: {
        activationCardAbsentFromModelAndTrajectory: true,
        activationCallbacksAbsentFromOpenClaw: true,
        outcomeAbsentFromModelAndTrajectory: true,
        genuineCallbackAbsentFromOpenClaw: true,
        receiptAbsentFromModelAndTrajectory: true,
        postRevokeCardAbsentFromModelAndTrajectory: true,
        banderTokenAbsentFromOpenClawEnvironment: true,
      },
      evidenceDirectory: path.relative(process.cwd(), runRoot),
    };
    fs.writeFileSync(
      path.join(runRoot, "result.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(JSON.stringify(evidence, null, 2));
  } else {
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

  if (scenario === "conflict") {
    await adapter.simulateCalendarChange("event-dinner-sarah");
    console.log("PASS changed world: Calendar precondition changed after Card delivery");
  }

  const beforeSynthetic = {
    bands: authorityStore.oneTimeBandWrites,
    permits: authorityStore.permitWrites,
    executions: adapter.executionCalls,
  };
  const syntheticCallbacks = [
    { id: "synthetic:non-owner-approve", fromId: Number(prior.nonOwnerId), chatId: Number(binding.chatId), messageId: binding.messageId, data: binding.callbackValue },
    { id: "synthetic:non-owner-decline", fromId: Number(prior.nonOwnerId), chatId: Number(binding.chatId), messageId: binding.messageId, data: binding.declineCallbackValue },
    { id: "synthetic:wrong-chat", fromId: Number(installation.ownerTelegramId), chatId: Number(binding.chatId) - 1, messageId: binding.messageId, data: binding.callbackValue },
    { id: "synthetic:wrong-message", fromId: Number(installation.ownerTelegramId), chatId: Number(binding.chatId), messageId: binding.messageId + 1, data: binding.callbackValue },
    { id: "synthetic:wrong-value", fromId: Number(installation.ownerTelegramId), chatId: Number(binding.chatId), messageId: binding.messageId, data: "bander:wrong-value" },
  ];
  for (const candidate of syntheticCallbacks) {
    const update: TelegramUpdate = {
      update_id: -1,
      callback_query: {
        id: candidate.id,
        from: { id: candidate.fromId, is_bot: false },
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
  console.log("PASS surface rejection: non-owner, wrong chat, message and callback created no authority");

  let receipt: HumanReceipt | undefined;
  let declinedBinding: (typeof binding) | undefined;
  if (scenario === "success") {
    console.log("WAITING two owner taps on the genuine Bander Card");
    const nonOwnerAnswers = telegramApi.callbackAnswers.filter((answer) =>
      answer.id.startsWith("synthetic:non-owner"),
    );
    assert.equal(nonOwnerAnswers.length, 2);
    assert.ok(
      nonOwnerAnswers.every((answer) =>
        answer.text.includes("Only the connected person"),
      ),
    );
    assert.equal(adapter.executionCalls, 0);
    await waitFor(
      "owner execution and replay",
      () =>
        telegramApi.callbackAnswers.some((answer) => answer.text.includes("Done exactly as shown")) &&
        telegramApi.callbackAnswers.some((answer) => answer.text.includes("Already done")),
      8 * 60_000,
    );
    const completedBinding = telegramStore.read().proposals[0]!;
    assert.equal(completedBinding.lifecycle, "executed");
    assert.equal(authorityStore.oneTimeBandWrites, 1);
    assert.equal(authorityStore.permitWrites, 1);
    assert.equal(adapter.executionCalls, 1);
    assert.equal(authorityStore.receiptWrites, 1);
    assert.ok(completedBinding.receiptId);
    receipt = engine.getHumanReceipt(completedBinding.receiptId);
    assert.equal(
      telegramApi.messages.filter((message) => message.text.startsWith("Done ✓")).length,
      1,
    );
    assert.equal(
      telegramApi.messages.some((message) => message.text.includes(receipt!.id)),
      false,
    );
    console.log("PASS approval: non-owner denied; owner replay returned one private outcome and execution");

    await telegramApi.sendMessage(
      installation.chatId,
      [
        "Owner: send this different request, then tap Not now on Bander’s message:",
        standingRequest,
      ].join("\n"),
    );
    console.log("WAITING owner to request again and tap Not now");
    await waitFor(
      "second one-time proposal",
      () => telegramStore.read().proposals.length === 2,
      5 * 60_000,
    );
    declinedBinding = telegramStore.read().proposals[1]!;
    await waitFor(
      "owner decline",
      () => telegramStore.read().proposals[1]?.lifecycle === "declined",
      5 * 60_000,
    );
    await telegramService.handleUpdate({
      update_id: -1,
      callback_query: {
        id: "synthetic:decline-replay",
        from: { id: Number(installation.ownerTelegramId), is_bot: false },
        data: declinedBinding.declineCallbackValue,
        message: {
          message_id: declinedBinding.messageId,
          chat: { id: Number(declinedBinding.chatId), type: "supergroup" },
        },
      },
    });
    assert.equal(engine.getAgentReceipt(declinedBinding.draftId).status, "declined");
    assert.equal(authorityStore.oneTimeBandWrites, 1);
    assert.equal(authorityStore.permitWrites, 1);
    assert.equal(adapter.executionCalls, 1);
    assert.equal(authorityStore.receiptWrites, 1);
    assert.equal(
      telegramApi.messages.filter((message) => message.text === declineExplanation).length,
      1,
    );
    console.log("PASS decline: one human outcome, idempotent replay, no new authority or execution");
  } else {
    console.log("WAITING two owner taps on the changed-world Bander Card");
    await waitFor(
      "human changed-world refusal and replay",
      () =>
        telegramApi.callbackAnswers.filter((answer) =>
          answer.text.includes("Stopped safely"),
        ).length >= 2,
      8 * 60_000,
    );
    const conflictedBinding = telegramStore.read().proposals[0]!;
    assert.equal(conflictedBinding.lifecycle, "conflict");
    assert.equal(engine.getAgentReceipt(binding.draftId).status, "conflict");
    assert.equal(authorityStore.oneTimeBandWrites, 1);
    assert.equal(authorityStore.permitWrites, 1);
    assert.equal(adapter.executionCalls, 1);
    assert.equal(authorityStore.receiptWrites, 0);
    assert.equal(conflictedBinding.receiptId, undefined);
    assert.equal(
      telegramApi.messages.filter((message) =>
        message.text.includes(conflictExplanation),
      ).length,
      1,
    );
    const changedEvent = await adapter.resolveEvent("event-dinner-sarah");
    assert.equal(changedEvent.startTime, "2026-07-14T20:00:00-06:00");
    console.log("PASS refusal: one human explanation, no Bander mutation or Receipt");
  }

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
  assert.equal(authorityStore.receiptWrites, scenario === "success" ? 1 : 0);
  assert.ok(provider.evidence.toolInventories.every(sameTools));
  console.log("PASS imitation: OpenClaw callback created no Bander authority");

  const modelInputs = provider.evidence.modelInputTexts.join("\n");
  const humanOnlyDetails = receipt
    ? [receipt.id, receipt.summary, receipt.detail, declineExplanation]
    : [conflictExplanation];
  for (const forbidden of [
    binding.callbackValue,
    binding.declineCallbackValue,
    ...(declinedBinding
      ? [declinedBinding.callbackValue, declinedBinding.declineCallbackValue]
      : []),
    card.title,
    card.draftHash,
    ...card.allows,
    ...humanOnlyDetails,
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
    binding.declineCallbackValue,
    ...(declinedBinding
      ? [declinedBinding.callbackValue, declinedBinding.declineCallbackValue]
      : []),
    card.title,
    card.draftHash,
    ...card.allows,
    ...humanOnlyDetails,
  ]) {
    assert.equal(bundleText.includes(forbidden), false);
  }
  assert.equal(bundleText.includes("bander__propose_action"), true);
  assert.equal(bundleText.includes(imitationData), true);

  const evidence = {
    status: "passed",
    scenario,
    service: "real Bander Telegram service",
    authenticatedPairing: "private single-use token plus private chat picker",
    effectiveTools: BANDER_OPENCLAW_TOOLS,
    mcpProposalFields: ["draftId", "status"],
    rejected:
      scenario === "success"
        ? ["non-owner", "wrong chat", "wrong message", "wrong callback", "OpenClaw imitation"]
        : ["wrong chat", "wrong message", "wrong callback", "OpenClaw imitation"],
    authority: {
      drafts: authorityStore.draftWrites,
      bands: authorityStore.oneTimeBandWrites,
      permits: authorityStore.permitWrites,
      downstreamDispatches: adapter.executionCalls,
      banderMutations: scenario === "success" ? 1 : 0,
      receipts: authorityStore.receiptWrites,
    },
    privacy: {
      cardAbsentFromModelAndTrajectory: true,
      genuineCallbackAbsentFromOpenClaw: true,
      receiptAbsentFromModelAndTrajectory: true,
      conflictExplanationAbsentFromModelAndTrajectory: true,
      declineExplanationAbsentFromModelAndTrajectory: true,
      banderTokenAbsentFromOpenClawEnvironment: true,
    },
    evidenceDirectory: path.relative(process.cwd(), runRoot),
  };
  fs.writeFileSync(path.join(runRoot, "result.json"), `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(JSON.stringify(evidence, null, 2));
  }
} finally {
  await stopChild(gateway);
  gatewayLog?.end();
  await telegramService.stop();
  await Promise.allSettled([broker?.close(), mockServices.close(), provider?.app.close()]);
}
