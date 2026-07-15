import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type {
  ApprovalCard,
  Band,
  HumanReceipt,
  Permit,
  StoredDraft,
} from "@bander/contracts";
import { AuthorityEngine, AuthorityStore } from "@bander/core";
import { buildBrokerApp } from "../apps/broker/src/app.js";
import { loadDraftFixtures } from "../apps/broker/src/fixtures.js";
import { MockServiceClient } from "../apps/broker/src/mock-client.js";
import { buildMockServices } from "../apps/mock-services/src/app.js";
import { loadVersionedSeed } from "../apps/mock-services/src/fixtures.js";
import { buildOpenClawMockProvider } from "./openclaw-mock-provider.js";
import { createRuntimeEnvironments } from "./process-env.js";
import { classifyTelegramSpikeCallback } from "./telegram-spike-boundary.js";

const canonicalRequest =
  "Move dinner with Sarah to 7:30 and tell her I’ll be 20 minutes late.";
const expectedTools = [
  "bander__get_receipt",
  "bander__list_capabilities",
  "bander__propose_action",
];

interface TelegramUser {
  id: number;
  is_bot?: boolean;
}

interface TelegramChat {
  id: number;
  type: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramBotIdentity {
  id: number;
  is_bot: boolean;
  username?: string;
}

interface SpikeIdentities {
  ownerId: string;
  nonOwnerId: string;
  chatId: string;
  chatType: string;
  banderBotId: string;
  banderUsername: string;
  openclawBotId: string;
  openclawUsername: string;
  nextBanderOffset: number;
}

class TelegramApi {
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  async call<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.#token}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      },
    );
    const payload = (await response.json()) as {
      ok?: boolean;
      result?: T;
    };
    if (!response.ok || payload.ok !== true || payload.result === undefined) {
      throw new Error(`Telegram ${method} failed`);
    }
    return payload.result;
  }

  getMe(): Promise<TelegramBotIdentity> {
    return this.call("getMe");
  }

  getUpdates(offset: number | undefined, timeout = 10): Promise<TelegramUpdate[]> {
    return this.call("getUpdates", {
      ...(offset === undefined ? {} : { offset }),
      limit: 100,
      timeout,
      allowed_updates: ["message", "callback_query"],
    });
  }

  sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: Record<string, unknown>,
  ): Promise<TelegramMessage> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  answerCallback(
    callbackQueryId: string,
    text: string,
    showAlert = true,
  ): Promise<boolean> {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
      cache_time: 0,
    });
  }
}

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

function commandMatches(
  text: string | undefined,
  command: "bind" | "nonowner",
  banderUsername: string,
): boolean {
  if (!text) return false;
  const match = text.match(/^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s|$)/);
  return Boolean(
    match &&
      match[1]?.toLowerCase() === command &&
      (!match[2] || match[2].toLowerCase() === banderUsername.toLowerCase()),
  );
}

async function deriveIdentities(
  bander: TelegramApi,
  openclaw: TelegramApi,
  runRoot: string,
): Promise<SpikeIdentities> {
  const [banderBot, openclawBot] = await Promise.all([
    bander.getMe(),
    openclaw.getMe(),
  ]);
  assert.equal(banderBot.is_bot, true);
  assert.equal(openclawBot.is_bot, true);
  assert.notEqual(banderBot.id, openclawBot.id);
  assert.ok(banderBot.username);
  assert.ok(openclawBot.username);

  const priorIdentityFiles = [
    path.resolve(".bander/telegram-spike-identities.json"),
    ...fs
      .readdirSync(".bander", { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name.startsWith("telegram-privacy-spike-"),
      )
      .map((entry) => path.resolve(".bander", entry.name, "identities.json"))
      .filter((file) => file !== path.join(runRoot, "identities.json")),
  ];
  for (const file of priorIdentityFiles) {
    if (!fs.existsSync(file)) continue;
    try {
      const prior = JSON.parse(fs.readFileSync(file, "utf8")) as SpikeIdentities;
      if (
        prior.banderBotId === String(banderBot.id) &&
        prior.openclawBotId === String(openclawBot.id) &&
        prior.ownerId !== prior.nonOwnerId &&
        Number(prior.chatId) < 0 &&
        Number.isInteger(prior.nextBanderOffset)
      ) {
        const identityPath = path.join(runRoot, "identities.json");
        fs.writeFileSync(identityPath, `${JSON.stringify(prior, null, 2)}\n`, {
          mode: 0o600,
        });
        fs.writeFileSync(
          path.resolve(".bander/telegram-spike-identities.json"),
          `${JSON.stringify(prior, null, 2)}\n`,
          { mode: 0o600 },
        );
        console.log("PASS identities: reused validated local binding");
        return prior;
      }
    } catch {
      // Ignore malformed generated state and derive a fresh binding.
    }
  }

  console.log("WAITING identity commands: owner /bind, non-owner /nonowner");
  const deadline = Date.now() + 5 * 60_000;
  let offset: number | undefined;
  let ownerMessage: TelegramMessage | undefined;
  let nonOwnerMessage: TelegramMessage | undefined;
  while (Date.now() < deadline && (!ownerMessage || !nonOwnerMessage)) {
    const updates = await bander.getUpdates(offset);
    for (const update of updates) {
      offset = Math.max(offset ?? 0, update.update_id + 1);
      const message = update.message;
      if (!message || message.from?.is_bot || !message.from?.id) continue;
      if (commandMatches(message.text, "bind", banderBot.username)) {
        ownerMessage = message;
      }
      if (commandMatches(message.text, "nonowner", banderBot.username)) {
        nonOwnerMessage = message;
      }
    }
  }
  assert.ok(ownerMessage, "owner /bind update was not observed");
  assert.ok(nonOwnerMessage, "non-owner /nonowner update was not observed");
  assert.notEqual(ownerMessage.from?.id, nonOwnerMessage.from?.id);
  assert.equal(ownerMessage.chat.id, nonOwnerMessage.chat.id);
  assert.ok(ownerMessage.chat.id < 0);
  assert.ok(["group", "supergroup"].includes(ownerMessage.chat.type));

  const identities: SpikeIdentities = {
    ownerId: String(ownerMessage.from?.id),
    nonOwnerId: String(nonOwnerMessage.from?.id),
    chatId: String(ownerMessage.chat.id),
    chatType: ownerMessage.chat.type,
    banderBotId: String(banderBot.id),
    banderUsername: banderBot.username,
    openclawBotId: String(openclawBot.id),
    openclawUsername: openclawBot.username,
    nextBanderOffset: offset ?? 0,
  };
  const identityPath = path.join(runRoot, "identities.json");
  fs.writeFileSync(identityPath, `${JSON.stringify(identities, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(identityPath, 0o600);
  fs.writeFileSync(
    path.resolve(".bander/telegram-spike-identities.json"),
    `${JSON.stringify(identities, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log("PASS identities: distinct humans, distinct bots, one negative group");
  return identities;
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function sameTools(actual: string[]): boolean {
  return (
    actual.length === expectedTools.length &&
    [...actual].sort().every((tool, index) => tool === expectedTools[index])
  );
}

function cardText(card: ApprovalCard, canary: string): string {
  return [
    `Bander privacy proof · ${canary}`,
    "",
    card.provenanceLabel,
    `“${card.claimedUserRequest}”`,
    "",
    "Bander will do only this:",
    ...card.allows.map((item) => `• ${item}`),
    "",
    "Boundary: one approval, this exact deal, nothing else through Bander.",
    "",
    "Privacy test order:",
    "1. Non-owner taps once and must be denied.",
    "2. Owner then taps twice; the second tap must return the same result.",
  ].join("\n");
}

function receiptText(receipt: HumanReceipt, receiptCanary: string): string {
  return [
    `Done · ${receiptCanary}`,
    receipt.summary,
    receipt.detail,
    `Calendar: ${receipt.calendar.title}`,
    ...(receipt.message
      ? [
          `Message to ${receipt.message.recipientDisplayName}: “${receipt.message.body}”`,
        ]
      : []),
  ].join("\n");
}

async function waitFor(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`OpenClaw command failed; inspect local spike logs (${stderr.length} bytes)`));
    });
  });
}

function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(), 10_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function readBundleText(directory: string): string {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (/\.(json|jsonl|txt)$/.test(entry.name)) files.push(target);
    }
  };
  visit(directory);
  return files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
}

process.loadEnvFile(".env");
const banderToken = process.env.BANDER_TELEGRAM_BOT_TOKEN;
const openclawToken = process.env.OPENCLAW_TELEGRAM_BOT_TOKEN;
if (!banderToken || !openclawToken) {
  throw new Error("Both local Telegram bot tokens are required");
}
assert.notEqual(banderToken, openclawToken);

const runId = `${Date.now()}-${randomBytes(4).toString("hex")}`;
const runRoot = path.resolve(`.bander/telegram-privacy-spike-${runId}`);
fs.mkdirSync(runRoot, { recursive: true, mode: 0o700 });
fs.chmodSync(runRoot, 0o700);
const banderTelegram = new TelegramApi(banderToken);
const openclawTelegram = new TelegramApi(openclawToken);
const identities = await deriveIdentities(
  banderTelegram,
  openclawTelegram,
  runRoot,
);

const serviceToken = randomBytes(32).toString("hex");
const mockServices = buildMockServices({
  token: serviceToken,
  seed: loadVersionedSeed(),
});
const mockUrl = await mockServices.listen({ host: "127.0.0.1", port: 0 });
const adapter = new CountingMockServiceClient({
  baseUrl: mockUrl,
  token: serviceToken,
});
const store = new CountingAuthorityStore();
const engine = new AuthorityEngine({ store, adapter });
const broker = buildBrokerApp({ engine, fixtures: loadDraftFixtures() });
const brokerUrl = await broker.listen({ host: "127.0.0.1", port: 0 });
const provider = buildOpenClawMockProvider();
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
reference.commands = {
  native: false,
  ownerAllowFrom: [`telegram:${identities.ownerId}`],
};
reference.channels = {
  telegram: {
    enabled: true,
    dmPolicy: "disabled",
    allowFrom: [identities.ownerId],
    groupPolicy: "allowlist",
    groupAllowFrom: [identities.ownerId],
    groups: {
      [identities.chatId]: {
        requireMention: false,
        allowFrom: [identities.ownerId],
      },
    },
    contextVisibility: "allowlist",
    historyLimit: 0,
    configWrites: false,
    streaming: { mode: "off" },
    errorPolicy: "silent",
    capabilities: { inlineButtons: "group" },
  },
};
const configPath = path.join(runRoot, "openclaw.json");
fs.writeFileSync(configPath, `${JSON.stringify(reference, null, 2)}\n`, {
  mode: 0o600,
});
fs.chmodSync(configPath, 0o600);

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
assert.equal(openclawEnv.TELEGRAM_BOT_TOKEN, openclawToken);

const node = path.resolve("node_modules/node/bin/node");
const openclaw = path.resolve("node_modules/openclaw/openclaw.mjs");
const gatewayPort = await reservePort();
const gatewayLogPath = path.join(runRoot, "openclaw-gateway.log");
const gatewayLog = fs.createWriteStream(gatewayLogPath, {
  flags: "a",
  mode: 0o600,
});
let gateway: ChildProcess | undefined;
let receipt: HumanReceipt | undefined;
let draftId = "";
let draftHash = "";
let cardMessageId = 0;
let banderOffset = identities.nextBanderOffset;
let nonOwnerDenied = false;
let ownerApprovalCount = 0;
let receiptMessages = 0;
const canary = `BANDER-PRIVACY-${randomBytes(8).toString("hex")}`;
const receiptCanary = `BANDER-RECEIPT-${randomBytes(8).toString("hex")}`;
const conflictCanary = `BANDER-PRIVATE-CONFLICT-${randomBytes(8).toString("hex")}`;
const callbackData = `bander:${randomBytes(18).toString("base64url")}`;
const imitationData = `openclaw:${randomBytes(18).toString("base64url")}`;

try {
  const validation = JSON.parse(
    await runCommand(
      node,
      [openclaw, "config", "validate", "--json"],
      openclawEnv,
    ),
  ) as { valid?: boolean };
  assert.equal(validation.valid, true, "OpenClaw rejected the spike policy");
  console.log("PASS OpenClaw policy: configuration validated before Telegram start");
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
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  assert.equal(gateway.exitCode, null, "OpenClaw gateway exited during startup");
  console.log("PASS OpenClaw gateway: real Telegram channel running with three tools");

  await banderTelegram.sendMessage(
    identities.chatId,
    [
      `Privacy spike ready · ${canary}`,
      "Owner: send this exact natural message with no command or fixture ID:",
      canonicalRequest,
    ].join("\n"),
  );
  console.log("WAITING owner natural request in Telegram");
  await waitFor(
    "OpenClaw MCP proposal",
    () => Boolean(provider.evidence.toolResult),
    5 * 60_000,
  );
  assert.equal(provider.evidence.sawHumanRequest, true);
  assert.ok(provider.evidence.toolResult);
  const proposalStatus = JSON.parse(provider.evidence.toolResult) as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(proposalStatus).sort(), ["draftId", "status"]);
  assert.equal(proposalStatus.status, "proposed");
  assert.equal(typeof proposalStatus.draftId, "string");
  draftId = String(proposalStatus.draftId);
  const cardResponse = await fetch(
    `${brokerUrl}/api/drafts/${encodeURIComponent(draftId)}/card`,
    { signal: AbortSignal.timeout(5_000) },
  );
  assert.equal(cardResponse.status, 200);
  const card = (await cardResponse.json()) as ApprovalCard;
  draftHash = card.draftHash;
  const cardMessage = await banderTelegram.sendMessage(
    identities.chatId,
    cardText(card, canary),
    {
      inline_keyboard: [
        [{ text: "Approve this one-time deal", callback_data: callbackData }],
      ],
    },
  );
  cardMessageId = cardMessage.message_id;
  console.log("PASS proposal: OpenClaw received minimal status; Bander posted Card");
  console.log("WAITING non-owner denial, then two owner taps on Bander button");

  const callbackDeadline = Date.now() + 8 * 60_000;
  while (Date.now() < callbackDeadline && ownerApprovalCount < 2) {
    const updates = await banderTelegram.getUpdates(banderOffset);
    for (const update of updates) {
      banderOffset = Math.max(banderOffset, update.update_id + 1);
      const callback = update.callback_query;
      if (!callback?.message || !callback.data) continue;
      const decision = classifyTelegramSpikeCallback(
        {
          ownerId: identities.ownerId,
          nonOwnerId: identities.nonOwnerId,
          chatId: identities.chatId,
          messageId: cardMessageId,
          callbackData,
        },
        {
          fromId: String(callback.from.id),
          chatId: String(callback.message.chat.id),
          messageId: callback.message.message_id,
          data: callback.data,
          nonOwnerCheckComplete: nonOwnerDenied,
        },
      );
      if (decision === "non_owner_denied") {
        nonOwnerDenied = true;
        await banderTelegram.answerCallback(
          callback.id,
          "Denied. This approval is bound to the owner.",
        );
        await banderTelegram.sendMessage(
          identities.chatId,
          "Non-owner boundary held. The owner may now tap the Bander button twice.",
        );
        console.log("PASS callback: non-owner denied before authority");
        continue;
      }
      if (decision === "owner_wait") {
        await banderTelegram.answerCallback(
          callback.id,
          "Wait for the non-owner boundary check first.",
        );
        continue;
      }
      if (decision !== "owner_allowed") {
        await banderTelegram.answerCallback(
          callback.id,
          "Denied. This is not the bound Bander approval surface.",
        );
        continue;
      }
      const approvalResponse = await fetch(
        `${brokerUrl}/api/drafts/${encodeURIComponent(draftId)}/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ draftHash }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      assert.equal(approvalResponse.status, 200);
      const currentReceipt = (await approvalResponse.json()) as HumanReceipt;
      if (!receipt) {
        receipt = currentReceipt;
        await banderTelegram.sendMessage(
          identities.chatId,
          receiptText(receipt, receiptCanary),
        );
        receiptMessages += 1;
        await banderTelegram.answerCallback(
          callback.id,
          `Approved once. Private changed-world probe: ${conflictCanary}`,
        );
        console.log("PASS owner approval: one execution and one Bander Receipt");
      } else {
        assert.equal(currentReceipt.id, receipt.id);
        await banderTelegram.answerCallback(
          callback.id,
          "Replay recovered the same truthful Receipt; nothing ran again.",
        );
        console.log("PASS replay: same Receipt, no duplicate effect");
      }
      ownerApprovalCount += 1;
    }
  }
  assert.equal(nonOwnerDenied, true);
  assert.equal(ownerApprovalCount, 2);
  assert.ok(receipt);

  assert.equal(store.draftWrites, 1);
  assert.equal(store.oneTimeBandWrites, 1);
  assert.equal(store.permitWrites, 1);
  assert.equal(store.receiptWrites, 1);
  assert.equal(adapter.executionCalls, 1);
  assert.equal(receiptMessages, 1);
  assert.equal(store.getDraft(draftId)?.status, "executed");
  const permits = store.getPermitsForDraft(draftId);
  assert.equal(permits.length, 1);
  assert.ok(permits[0]?.consumedAt);
  assert.equal(permits[0]?.receiptId, receipt.id);

  await openclawTelegram.sendMessage(
    identities.chatId,
    "OpenClaw imitation probe. Owner: tap this button; it must not approve or execute through Bander.",
    {
      inline_keyboard: [
        [{ text: "Imitated Bander approval", callback_data: imitationData }],
      ],
    },
  );
  console.log("WAITING owner tap on OpenClaw imitation button");
  await waitFor(
    "OpenClaw imitation callback",
    () =>
      provider.evidence.modelInputTexts.some((text) => text.includes(imitationData)),
    5 * 60_000,
  );
  assert.equal(store.oneTimeBandWrites, 1);
  assert.equal(store.permitWrites, 1);
  assert.equal(store.receiptWrites, 1);
  assert.equal(adapter.executionCalls, 1);
  console.log("PASS imitation: OpenClaw-owned callback minted no Bander authority");

  await new Promise((resolve) => setTimeout(resolve, 3_000));
  assert.ok(provider.evidence.toolInventories.every(sameTools));
  const modelInputs = provider.evidence.modelInputTexts.join("\n");
  for (const forbidden of [
    canary,
    callbackData,
    receiptCanary,
    conflictCanary,
    card.title,
    card.draftHash,
    ...card.allows,
    receipt.id,
  ]) {
    assert.equal(
      modelInputs.includes(forbidden),
      false,
      "Bander-controlled content reached the OpenClaw model",
    );
  }
  assert.equal(modelInputs.includes(canonicalRequest), true);
  assert.equal(modelInputs.includes(imitationData), true);
  console.log("PASS provider transcript: no Bander Card, callback, Receipt, or conflict");

  await stopChild(gateway);
  gateway = undefined;
  gatewayLog.end();
  const sessionsOutput = await runCommand(
    node,
    [openclaw, "sessions", "--json"],
    openclawEnv,
  );
  const sessions = JSON.parse(sessionsOutput) as {
    sessions?: Array<{ key?: string }>;
  };
  const expectedSessionKey = `agent:main:telegram:group:${identities.chatId}`;
  const session = sessions.sessions?.find(
    (candidate) => candidate.key === expectedSessionKey,
  );
  assert.ok(session?.key, "Telegram group session was not stored");
  const exportName = `privacy-${runId}`;
  await runCommand(
    node,
    [
      openclaw,
      "sessions",
      "export-trajectory",
      "--session-key",
      session.key,
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
  assert.equal(fs.existsSync(bundlePath), true);
  const bundleText = readBundleText(bundlePath);
  assert.equal(bundleText.includes(canonicalRequest), true);
  assert.equal(bundleText.includes("bander__propose_action"), true);
  for (const forbidden of [
    canary,
    callbackData,
    receiptCanary,
    conflictCanary,
    card.title,
    card.draftHash,
    ...card.allows,
    receipt.id,
  ]) {
    assert.equal(
      bundleText.includes(forbidden),
      false,
      "Bander-controlled content reached the OpenClaw trajectory",
    );
  }
  console.log("PASS complete trajectory: Bander-controlled content absent");

  const evidence = {
    status: "passed",
    openclawVersion: "2026.7.1",
    identities: {
      ownerAndNonOwnerDistinct: true,
      botsDistinct: true,
      oneBoundGroup: true,
    },
    naturalUnmentionedRequestObserved: provider.evidence.sawHumanRequest,
    effectiveTools: expectedTools,
    mcpProposalFields: ["draftId", "status"],
    telegram: {
      banderCardPostedByBanderBot: true,
      nonOwnerDenied: true,
      ownerApprovalCallbacks: ownerApprovalCount,
      receiptMessages,
      imitationCallbackReachedOpenClawOnly: true,
    },
    authority: {
      drafts: store.draftWrites,
      bands: store.oneTimeBandWrites,
      permits: store.permitWrites,
      downstreamExecutions: adapter.executionCalls,
      receipts: store.receiptWrites,
      permitConsumed: Boolean(permits[0]?.consumedAt),
    },
    privacy: {
      providerInputsClean: true,
      trajectoryClean: true,
      banderCallbackAbsentFromOpenClaw: true,
      receiptAbsentFromOpenClaw: true,
      conflictAbsentFromOpenClaw: true,
    },
    evidenceDirectory: path.relative(process.cwd(), runRoot),
  };
  fs.writeFileSync(
    path.join(runRoot, "result.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await stopChild(gateway);
  gatewayLog.end();
  await Promise.allSettled([
    broker.close(),
    mockServices.close(),
    provider.app.close(),
  ]);
}
