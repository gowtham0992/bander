import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AuthorityEngine, AuthorityStore, type ExecutionAdapter } from "@bander/core";
import { FileTelegramServiceStore, TelegramHttpApi, TelegramService } from "../apps/broker/src/telegram-service.js";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const token = process.env.BANDER_TELEGRAM_BOT_TOKEN?.trim();
if (!token) throw new Error("BANDER_TELEGRAM_BOT_TOKEN is required");
const statePath = path.resolve(process.env.BANDER_TELEGRAM_STATE_PATH || ".bander/real/telegram-service/state.json");
const requestPath = path.join(path.dirname(statePath), "family-notification-request.txt");
const unavailable = async (): Promise<never> => { throw new Error("Authority operations are unavailable in the delivery verifier"); };
const adapter: ExecutionAdapter = { resolveEvent: unavailable, resolvePerson: unavailable, executeDraft: unavailable, getExecution: async () => false };
const store = new FileTelegramServiceStore(statePath);
if (!store.read().familyContact) throw new Error("An active family contact is required");
let requestId: string;
if (fs.existsSync(requestPath)) requestId = fs.readFileSync(requestPath, "utf8").trim();
else {
  requestId = `checkpoint4_${randomBytes(18).toString("base64url")}`;
  fs.writeFileSync(requestPath, `${requestId}\n`, { mode: 0o600 });
  fs.chmodSync(requestPath, 0o600);
}
const service = new TelegramService({ api: new TelegramHttpApi(token), engine: new AuthorityEngine({ store: new AuthorityStore(), adapter }), store, mode: "real" });
const document = { kind: "calendar_transition", eventTitle: "Checkpoint 4 verification — Bander Demo Appointment", newStartTime: "2026-07-18T22:00:00.000Z", newEndTime: "2026-07-18T23:00:00.000Z", timeZone: "America/Denver" };
const first = await service.deliverFamilyNotification({ requestId, document });
const replay = await service.deliverFamilyNotification({ requestId, document });
const operation = store.read().familyNotifications?.find((item) => item.requestId === requestId);
process.stdout.write(`${JSON.stringify({ first: first.status, replay: replay.status, durableStatus: operation?.status, operationCount: store.read().familyNotifications?.length ?? 0, messageIdStoredPrivately: Boolean(operation?.telegramMessageId) })}\n`);
