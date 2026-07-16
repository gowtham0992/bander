import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  claimFamilyContact,
  createFamilyContactChallenge,
  revokeFamilyContact,
  sanitizeFamilyContactEvidence,
  type FamilyContactSpikeState,
} from "../apps/broker/src/family-contact-spike.js";
import {
  TelegramHttpApi,
  type TelegramMessage,
  type TelegramUpdate,
} from "../apps/broker/src/telegram-service.js";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

const root = path.resolve(".bander/spikes/family-contact");
const pairingPath = path.join(root, "pairing-link.txt");
const transientStatePath = path.join(root, "live-state.json");
const evidencePath = path.join(root, "evidence.json");
const productionStatePath = path.resolve(
  process.env.BANDER_TELEGRAM_STATE_PATH ?? ".bander/real/telegram-service/state.json",
);

function fileDigest(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writePrivate(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
  fs.writeFileSync(filePath, value, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function readOwnerTelegramId(): number {
  if (!fs.existsSync(productionStatePath)) {
    throw new Error("production_telegram_installation_missing");
  }
  const state = JSON.parse(fs.readFileSync(productionStatePath, "utf8")) as {
    installation?: { ownerTelegramId?: string };
  };
  const owner = Number(state.installation?.ownerTelegramId);
  if (!Number.isSafeInteger(owner) || owner <= 0) {
    throw new Error("production_telegram_owner_missing");
  }
  return owner;
}

async function assertProductStopped(): Promise<void> {
  const port = process.env.BANDER_PORT ?? "4310";
  try {
    await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(750) });
    throw new Error("product_stack_must_be_stopped");
  } catch (error) {
    if (error instanceof Error && error.message === "product_stack_must_be_stopped") {
      throw error;
    }
  }
}

function maxUpdateOffset(updates: readonly TelegramUpdate[]): number | undefined {
  if (updates.length === 0) return undefined;
  return Math.max(...updates.map((update) => update.update_id)) + 1;
}

function isReceiptConfirmation(
  state: FamilyContactSpikeState,
  update: TelegramUpdate,
): boolean {
  const message = update.message;
  return Boolean(
    state.status === "paired" &&
      message?.from &&
      !message.from.is_bot &&
      message.chat.type === "private" &&
      message.from.id === state.contactTelegramId &&
      message.chat.id === state.contactChatId &&
      message.text?.trim().toLocaleLowerCase("en-US") === "/received",
  );
}

function verifyTelegramConfirmation(
  sent: TelegramMessage,
  botId: number,
  contactChatId: number,
  text: string,
): void {
  if (
    !Number.isSafeInteger(sent.message_id) ||
    sent.message_id <= 0 ||
    sent.chat.id !== contactChatId ||
    sent.from?.id !== botId ||
    sent.text !== text
  ) {
    throw new Error("telegram_delivery_confirmation_invalid");
  }
}

async function main(): Promise<void> {
  await assertProductStopped();
  const token = process.env.BANDER_TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("bander_telegram_token_missing");

  const productionBefore = fileDigest(productionStatePath);
  const ownerTelegramId = readOwnerTelegramId();
  const api = new TelegramHttpApi(token);
  const bot = await api.getMe();
  if (!bot.is_bot || !bot.username) throw new Error("bander_bot_identity_invalid");

  const backlog = await api.getUpdates(undefined, 0);
  let offset = maxUpdateOffset(backlog);
  if (offset !== undefined) await api.getUpdates(offset, 0);

  const challenge = createFamilyContactChallenge({
    ownerTelegramId,
    now: Date.now(),
    ttlMs: 10 * 60_000,
  });
  let state = challenge.state;
  writePrivate(transientStatePath, `${JSON.stringify(state, null, 2)}\n`);
  writePrivate(
    pairingPath,
    `https://t.me/${bot.username}?start=family_${challenge.token}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      status: "waiting_for_contact_consent",
      pairingLinkPath: pairingPath,
      expiresInMinutes: 10,
      instructions:
        "Open the private pairing link with the second account, tap Start, then reply /received after the labelled canary arrives.",
      doNotUseOwnerAccount: true,
      doNotInteractWithOwnerCardsDuringProbe: true,
      privateIdentifiersPrinted: false,
    })}\n`,
  );

  let canarySent = false;
  let receivedConfirmed = false;
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline && !receivedConfirmed) {
    const updates = await api.getUpdates(offset, 25);
    const next = maxUpdateOffset(updates);
    if (next !== undefined) offset = next;
    for (const update of updates) {
      if (state.status === "pending") {
        const claimed = claimFamilyContact(state, update, Date.now());
        state = claimed.state;
        if (claimed.status === "paired") {
          writePrivate(transientStatePath, `${JSON.stringify(state, null, 2)}\n`);
          const canary = [
            "Bander delivery test",
            "You explicitly started this private test.",
            "This canary contains no Calendar, owner, conversation, or approval details.",
            "Reply /received to confirm it reached this phone.",
          ].join("\n");
          const sent = await api.sendMessage(String(state.contactChatId), canary);
          verifyTelegramConfirmation(sent, bot.id, state.contactChatId!, canary);
          canarySent = true;
          process.stdout.write(
            `${JSON.stringify({
              status: "telegram_canary_confirmed_by_api",
              realBotMessageConfirmation: true,
              waitingForPhoneConfirmation: true,
              privateIdentifiersPrinted: false,
            })}\n`,
          );
        }
      } else if (isReceiptConfirmation(state, update)) {
        receivedConfirmed = true;
        const revokeUpdate: TelegramUpdate = {
          update_id: update.update_id,
          message: { ...update.message!, text: "/revoke" },
        };
        const revoked = revokeFamilyContact(state, revokeUpdate);
        if (revoked.status !== "revoked") throw new Error("contact_cleanup_failed");
        state = revoked.state;
      }
    }
  }
  if (!canarySent) throw new Error("contact_pairing_not_completed");
  if (!receivedConfirmed) throw new Error("phone_confirmation_not_received");

  const productionAfter = fileDigest(productionStatePath);
  const evidence = {
    ...sanitizeFamilyContactEvidence({
      paired: true,
      canaryConfirmed: true,
      revoked: state.status === "revoked",
      productionStateUnchanged: productionBefore === productionAfter,
    }),
    realTelegramBotMessageConfirmation: true,
    secondPhoneAcknowledgedCanary: true,
  };
  if (!evidence.productionPairingStateUnchanged) {
    throw new Error("production_pairing_state_changed");
  }
  writePrivate(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.rmSync(pairingPath, { force: true });
  fs.rmSync(transientStatePath, { force: true });
  process.stdout.write(`${JSON.stringify({ status: "passed", ...evidence })}\n`);
}

main().catch((error: unknown) => {
  fs.rmSync(pairingPath, { force: true });
  fs.rmSync(transientStatePath, { force: true });
  const code = error instanceof Error ? error.message : "family_contact_spike_failed";
  process.stderr.write(`${JSON.stringify({ status: "failed", code })}\n`);
  process.exitCode = 1;
});
