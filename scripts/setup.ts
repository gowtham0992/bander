import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectDoctorReport } from "./doctor-lib.js";
import { assertExactGmailScopes, initializeSetupEnvironment, loadSetupState, redactSetupText, runRepositorySetup, type SetupProbes } from "./setup-lib.js";
import { FileTelegramServiceStore } from "../apps/broker/src/telegram-service.js";
import { google } from "googleapis";
import { parseDesktopOAuthClient } from "../apps/broker/src/google-oauth.js";
import { createGoogleCalendarBoundary } from "../apps/broker/src/google-calendar.js";

const root = process.cwd();
const envFile = path.join(root, ".env");
if (process.argv.length > 2) {
  process.stderr.write("Usage: npm run setup\n");
  process.exit(1);
}

function ensureEnvironmentFile(): boolean {
  if (fs.existsSync(envFile)) { fs.chmodSync(envFile, 0o600); return false; }
  initializeSetupEnvironment(root, fs.readFileSync(path.join(root, ".env.example"), "utf8"));
  return true;
}
function safePath(configured: string | undefined): string {
  const boundary = path.join(root, ".bander");
  const target = path.resolve(root, configured ?? "");
  if (!target.startsWith(`${boundary}${path.sep}`)) throw new Error("Configured OAuth paths must remain inside the ignored repository-local .bander directory");
  return target;
}
function oauthClient(clientPath: string, tokenPath: string): InstanceType<typeof google.auth.OAuth2> {
  const desktop = parseDesktopOAuthClient(JSON.parse(fs.readFileSync(clientPath, "utf8")));
  const token = JSON.parse(fs.readFileSync(tokenPath, "utf8")) as Record<string, unknown>;
  const client = new google.auth.OAuth2({ clientId: desktop.clientId, clientSecret: desktop.clientSecret });
  client.setCredentials(token);
  return client;
}

if (ensureEnvironmentFile()) {
  process.stdout.write("Bander created an ignored 0600 .env from .env.example. The setup computer holds credentials; the parent/owner phone approves in the protected group; the optional family-contact phone stays outside that group. Edit .env locally with your own values—setup never asks for or prints secrets—then rerun npm run setup.\n");
  process.exit(0);
}
process.loadEnvFile(envFile);

const probes: SetupProbes = {
  async localPrerequisites() {
    const node = Number(process.versions.node.split(".")[0]);
    const ok = process.platform === "darwin" && process.arch === "arm64" && node >= 22 && fs.existsSync(path.join(root, "node_modules", "openclaw", "package.json"));
    if (!ok) throw new Error("Supported real setup requires macOS Apple Silicon, Node 22.12+, and npm ci from this lockfile");
    return { ok };
  },
  async ownerPairing() {
    const store = new FileTelegramServiceStore(path.resolve(root, process.env.BANDER_TELEGRAM_STATE_PATH ?? ".bander/real/telegram-service/state.json"));
    return { ok: Boolean(store.read().installation) };
  },
  async google() {
    const calendar = oauthClient(safePath(process.env.GOOGLE_OAUTH_CLIENT_PATH), safePath(process.env.GOOGLE_OAUTH_TOKEN_PATH));
    const gmailClient = oauthClient(safePath(process.env.GMAIL_OAUTH_CLIENT_PATH), safePath(process.env.GMAIL_OAUTH_TOKEN_PATH));
    const access = await gmailClient.getAccessToken();
    if (!access.token) throw new Error("Gmail OAuth token is unavailable");
    const info = await gmailClient.getTokenInfo(access.token);
    assertExactGmailScopes(info.scopes);
    return { ok: true, calendarTimeZone: await createGoogleCalendarBoundary(calendar).getPrimaryTimeZone(), gmailScopes: info.scopes };
  },
  async doctor() {
    const offline = await collectDoctorReport({ cwd: root, environment: process.env, live: false });
    const live = await collectDoctorReport({ cwd: root, environment: process.env, live: true });
    return { ok: offline.summary.FAIL === 0 && live.summary.FAIL === 0 };
  },
};

try {
  const result = await runRepositorySetup({ root, home: os.homedir(), environment: process.env, probes });
  const state = loadSetupState(root);
  const messages: Record<string, string> = {
    environment: "Configuration files are private and confined. Next, create two BotFather bots, configure the protected private group, then run npm run pair:real.",
    owner_pairing: "Owner/group pairing is verified. Remove and re-add bots after BotFather privacy changes, then run npm run verify:telegram-privacy and rerun setup.",
    telegram_privacy: "Telegram privacy evidence is required. Run npm run verify:telegram-privacy against this configuration, then rerun setup.",
    google: "Telegram privacy is configuration-bound and current. Complete Calendar and Gmail Desktop OAuth with the dedicated test account, then rerun setup.",
    doctor: "Google timezone and exact Gmail scopes are verified. Start npm run real in a second terminal, then rerun setup so its final live read-only doctor can verify Telegram, Google, Gmail, and exactly five tools.",
    ready: "Bander is ready. The isolated pinned OpenClaw runtime is live. Send “Hi” in the protected group, then ask what’s on tomorrow.",
  };
  process.stdout.write(`${messages[result.step] ?? `Setup milestone verified: ${result.step}. Rerun npm run setup to continue.`}\n`);
  if (state) process.stdout.write(`Progress: ${state.milestones.length} versioned verification milestones recorded; no secret values are stored in setup state.\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "Setup could not continue";
  process.stderr.write(`${redactSetupText(message, [process.env.OPENAI_API_KEY ?? "", process.env.BANDER_TELEGRAM_BOT_TOKEN ?? "", process.env.OPENCLAW_TELEGRAM_BOT_TOKEN ?? ""])}\n`);
  process.exitCode = 1;
}
