import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { google } from "googleapis";
import {
  FileTelegramServiceStore,
  TelegramHttpApi,
  type TelegramServiceState,
} from "../apps/broker/src/telegram-service.js";
import { createGoogleCalendarBoundary } from "../apps/broker/src/google-calendar.js";
import { parseDesktopOAuthClient } from "../apps/broker/src/google-oauth.js";
import { BANDER_REAL_OPENCLAW_TOOLS } from "./openclaw-telegram-config.js";

export type DoctorStatus = "PASS" | "WARN" | "FAIL";

export interface DoctorCheck {
  status: DoctorStatus;
  check: string;
  meaning: string;
  nextAction: string;
}

export interface DoctorReport {
  mode: "offline" | "live";
  checks: DoctorCheck[];
  summary: Record<DoctorStatus, number>;
}

export interface DoctorLiveProbes {
  telegram(): Promise<{
    botReachable: boolean;
    groupReachable: boolean;
    ownerBindingValid: boolean;
  }>;
  google(): Promise<{ timeZone: string }>;
  gmail(): Promise<{ reachable: boolean; scopesValid: boolean }>;
  mcp(): Promise<{ tools: string[] }>;
  /** Test-only sentinel. Production code must never call it. */
  forbiddenWrite?: () => void;
}

export interface DoctorOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>;
  live: boolean;
  probes?: DoctorLiveProbes;
  portAvailable?: (port: number) => Promise<boolean>;
}

const REQUIRED_REAL_ENVIRONMENT = [
  "BANDER_RUNTIME_MODE",
  "OPENAI_API_KEY",
  "BANDER_TELEGRAM_BOT_TOKEN",
  "OPENCLAW_TELEGRAM_BOT_TOKEN",
  "GOOGLE_OAUTH_CLIENT_PATH",
  "GOOGLE_OAUTH_TOKEN_PATH",
  "GMAIL_OAUTH_CLIENT_PATH",
  "GMAIL_OAUTH_TOKEN_PATH",
  "BANDER_CALENDAR_TIME_ZONE",
] as const;

const DOCTOR_USAGE = "Usage: npm run doctor -- [--live] [--json]";

function check(
  status: DoctorStatus,
  name: string,
  meaning: string,
  nextAction = "None.",
): DoctorCheck {
  return { status, check: name, meaning, nextAction };
}

export function parseDoctorArguments(args: readonly string[]): {
  live: boolean;
  json: boolean;
} {
  let live = false;
  let json = false;
  for (const argument of args) {
    if (argument === "--live" && !live) live = true;
    else if (argument === "--json" && !json) json = true;
    else throw new Error(DOCTOR_USAGE);
  }
  return { live, json };
}

function runGit(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function isIgnored(cwd: string, candidate: string): boolean {
  return runGit(cwd, ["check-ignore", "-q", candidate]) !== undefined;
}

function isTracked(cwd: string, candidate: string): boolean {
  return Boolean(runGit(cwd, ["ls-files", "--error-unmatch", candidate]));
}

function privateFileMode(filePath: string): boolean {
  try {
    return (fs.statSync(filePath).mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function validPort(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? String(fallback), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535
    ? parsed
    : fallback;
}

async function defaultPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

function readTelegramState(
  cwd: string,
  environment: DoctorOptions["environment"],
): { state?: TelegramServiceState; invalid: boolean; exists: boolean } {
  const configured =
    environment.BANDER_TELEGRAM_STATE_PATH?.trim() ||
    ".bander/real/telegram-service/state.json";
  const statePath = path.resolve(cwd, configured);
  if (!fs.existsSync(statePath)) return { invalid: false, exists: false };
  try {
    return {
      state: new FileTelegramServiceStore(statePath).read(),
      invalid: false,
      exists: true,
    };
  } catch {
    return { invalid: true, exists: true };
  }
}

function artifactCheck(cwd: string): DoctorCheck {
  const candidates = [
    ".env",
    ".bander",
    "transcription1.md",
    "transcription_day2.md",
  ];
  const unsafe = candidates.some(
    (candidate) => isTracked(cwd, candidate) || !isIgnored(cwd, candidate),
  );
  return unsafe
    ? check(
        "FAIL",
        "Private local artifacts",
        "At least one credential, generated-state, or transcript path is not safely ignored and untracked.",
        "Restore the repository ignore rules and remove the path from Git tracking without deleting the local file.",
      )
    : check(
        "PASS",
        "Private local artifacts",
        "Credentials, generated state, and transcripts are ignored and untracked.",
      );
}

function oauthFilesCheck(
  cwd: string,
  environment: DoctorOptions["environment"],
): DoctorCheck {
  const configured = [
    environment.GOOGLE_OAUTH_CLIENT_PATH?.trim(),
    environment.GOOGLE_OAUTH_TOKEN_PATH?.trim(),
    environment.GMAIL_OAUTH_CLIENT_PATH?.trim(),
    environment.GMAIL_OAUTH_TOKEN_PATH?.trim(),
  ];
  if (configured.some((value) => !value)) {
    return check(
      "FAIL",
      "Google OAuth files",
      "The Calendar OAuth files and separate Gmail token path are not configured.",
      "Set the GOOGLE_OAUTH_* and GMAIL_OAUTH_* paths in .env; keep all OAuth files outside tracked source.",
    );
  }
  const absolute = configured.map((value) => path.resolve(cwd, value!));
  if (absolute[1] === absolute[3]) {
    return check(
      "FAIL",
      "Google OAuth files",
      "Calendar and Gmail are configured to use the same token file.",
      "Set GMAIL_OAUTH_TOKEN_PATH to a separate ignored 0600 file, then complete Gmail consent.",
    );
  }
  if (absolute.some((filePath) => !fs.existsSync(filePath))) {
    return check(
      "FAIL",
      "Google OAuth files",
      "A configured Google OAuth file is missing.",
      "Complete Desktop OAuth setup, then rerun npm run doctor.",
    );
  }
  if (absolute.some((filePath) => !privateFileMode(filePath))) {
    return check(
      "FAIL",
      "Google OAuth files",
      "A Google OAuth file is readable by other local users.",
      "Set each OAuth file to mode 0600, then rerun npm run doctor.",
    );
  }
  const repositoryRelative = absolute
    .map((filePath) => path.relative(cwd, filePath))
    .filter((relative) => relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  if (repositoryRelative.some((relative) => isTracked(cwd, relative) || !isIgnored(cwd, relative))) {
    return check(
      "FAIL",
      "Google OAuth files",
      "A Google OAuth file is tracked or is not covered by repository ignore rules.",
      "Ignore the OAuth path, remove it from Git tracking if needed, and rotate any exposed credential.",
    );
  }
  return check(
    "PASS",
    "Google OAuth files",
    "Calendar OAuth files and the separate Gmail OAuth token exist, are private, and are not tracked.",
  );
}

function telegramStateChecks(
  stateResult: ReturnType<typeof readTelegramState>,
): DoctorCheck[] {
  if (stateResult.invalid) {
    return [
      check(
        "FAIL",
        "Telegram state",
        "The persisted Telegram state is invalid or uses an unsupported schema.",
        "Stop Bander, preserve the file for diagnosis, and run npm run pair:real only after resolving the state error.",
      ),
      check(
        "FAIL",
        "Owner and group",
        "Owner/group pairing cannot be trusted while Telegram state is invalid.",
        "Resolve the Telegram state failure first.",
      ),
      check(
        "WARN",
        "Family contact",
        "Family-contact status is unavailable. Calendar-only use remains available after state recovery.",
        "Resolve the Telegram state failure first.",
      ),
    ];
  }
  const state = stateResult.state;
  const stateCheck = stateResult.exists
    ? check("PASS", "Telegram state", "Persisted Telegram state validates.")
    : check(
        "WARN",
        "Telegram state",
        "No persisted Telegram installation exists yet.",
        "Run npm run pair:real after configuring the Bander Telegram bot.",
      );
  const owner = state?.installation
    ? check("PASS", "Owner and group", "One owner and protected group are bound.")
    : check(
        "WARN",
        "Owner and group",
        "The owner and protected group are not paired yet.",
        "Run npm run pair:real and complete the private owner/group flow.",
      );
  let family: DoctorCheck;
  if (state?.familyContact?.status === "active") {
    const displayLabel = state.familyContact.displayLabel
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
    family = check(
      "PASS",
      "Family contact",
      `Family contact is connected as ${displayLabel || "the configured family member"}. Calendar-only use also remains available.`,
    );
  } else if (state?.familyPairing) {
    const expired = Date.parse(state.familyPairing.expiresAt) <= Date.now();
    family = check(
      "WARN",
      "Family contact",
      expired
        ? "The family pairing link is stale. Calendar-only use remains available."
        : "Family pairing is pending. Calendar-only use remains available.",
      expired
        ? "Run npm run revoke:family, then create a new link with npm run pair:family -- --name NAME --alias ALIAS."
        : "Have the invited person finish the private pairing flow, or run npm run revoke:family to cancel it.",
    );
  } else if (state?.familyContactAudit) {
    family = check(
      "WARN",
      "Family contact",
      "The previous family contact is revoked. Calendar-only use remains available.",
      "To reconnect, create a new link with npm run pair:family -- --name NAME --alias ALIAS.",
    );
  } else {
    family = check(
      "WARN",
      "Family contact",
      "No family contact is connected. Calendar-only use remains available.",
      "Optional: run npm run pair:family -- --name NAME --alias ALIAS.",
    );
  }
  return [stateCheck, owner, family];
}

function dependencyChecks(cwd: string): DoctorCheck[] {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const node = nodeMajor >= 22
    ? check("PASS", "Node", `Node ${process.versions.node} is supported.`)
    : check("FAIL", "Node", "The active Node version is unsupported.", "Install Node 22.12 or newer, then rerun npm ci.");
  const workspaceReady = fs.existsSync(path.join(cwd, "package-lock.json")) &&
    fs.existsSync(path.join(cwd, "node_modules"));
  const dependencies = workspaceReady
    ? check("PASS", "Dependencies", "The lockfile and installed workspace dependencies are available.")
    : check("FAIL", "Dependencies", "Workspace dependencies are not installed from the lockfile.", "Run npm ci.");
  let openclaw: DoctorCheck;
  try {
    const packageValue = JSON.parse(
      fs.readFileSync(path.join(cwd, "node_modules/openclaw/package.json"), "utf8"),
    ) as { version?: string };
    openclaw = packageValue.version
      ? check("PASS", "OpenClaw", `The pinned OpenClaw package is available (${packageValue.version}).`)
      : check("FAIL", "OpenClaw", "The installed OpenClaw package has no usable version.", "Run npm ci.");
  } catch {
    openclaw = check("FAIL", "OpenClaw", "The pinned OpenClaw package is unavailable.", "Run npm ci.");
  }
  return [node, dependencies, openclaw];
}

function documentationCheck(cwd: string): DoctorCheck {
  try {
    const packageValue = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageValue.scripts ?? {};
    const commands = ["doctor", "demo", "real", "pair:real", "pair:family", "revoke:family"];
    const files = ["README.md", "SETUP.md"];
    if (commands.some((name) => !scripts[name]) || files.some((name) => !fs.existsSync(path.join(cwd, name)))) {
      throw new Error("missing setup surface");
    }
    return check("PASS", "Setup commands", "README and SETUP commands exist in this checkout.");
  } catch {
    return check("FAIL", "Setup commands", "A documented setup command or guide is missing.", "Restore README.md, SETUP.md, and the package scripts before setup.");
  }
}

function configuredEnvironmentCheck(environment: DoctorOptions["environment"]): DoctorCheck {
  const missing = REQUIRED_REAL_ENVIRONMENT.filter((name) => {
    if (name === "BANDER_RUNTIME_MODE") return environment[name]?.trim() !== "real";
    return !environment[name]?.trim();
  });
  return missing.length === 0
    ? check("PASS", "Real-mode configuration", "All required real-mode variable names are configured.")
    : check(
        "FAIL",
        "Real-mode configuration",
        `Missing or invalid required variable names: ${missing.join(", ")}.`,
        "Copy .env.example to .env, fill it locally, and never commit .env.",
      );
}

async function createDefaultLiveProbes(
  cwd: string,
  environment: DoctorOptions["environment"],
  state: TelegramServiceState | undefined,
): Promise<DoctorLiveProbes> {
  return {
    async telegram() {
      const token = environment.BANDER_TELEGRAM_BOT_TOKEN?.trim();
      const installation = state?.installation;
      if (!token || !installation) throw new Error("telegram unavailable");
      const api = new TelegramHttpApi(token);
      const bot = await api.getMe();
      const group = await api.getChat(installation.chatId);
      const owner = await api.getChatMember(installation.chatId, installation.ownerTelegramId);
      return {
        botReachable: !bot.is_bot ? false : true,
        groupReachable: group.type === "group" || group.type === "supergroup",
        ownerBindingValid: owner.status !== "left" && owner.status !== "kicked",
      };
    },
    async google() {
      const clientPath = path.resolve(cwd, environment.GOOGLE_OAUTH_CLIENT_PATH ?? "");
      const tokenPath = path.resolve(cwd, environment.GOOGLE_OAUTH_TOKEN_PATH ?? "");
      const desktop = parseDesktopOAuthClient(JSON.parse(fs.readFileSync(clientPath, "utf8")));
      const stored = JSON.parse(fs.readFileSync(tokenPath, "utf8")) as Record<string, unknown>;
      if (typeof stored.refresh_token !== "string") throw new Error("oauth unavailable");
      const client = new google.auth.OAuth2({
        clientId: desktop.clientId,
        clientSecret: desktop.clientSecret,
      });
      client.setCredentials({
        refresh_token: stored.refresh_token,
        ...(typeof stored.access_token === "string" ? { access_token: stored.access_token } : {}),
        ...(typeof stored.expiry_date === "number" ? { expiry_date: stored.expiry_date } : {}),
        ...(typeof stored.scope === "string" ? { scope: stored.scope } : {}),
        ...(typeof stored.token_type === "string" ? { token_type: stored.token_type } : {}),
      });
      return { timeZone: await createGoogleCalendarBoundary(client).getPrimaryTimeZone() };
    },
    async gmail() {
      const clientPath = path.resolve(cwd, environment.GMAIL_OAUTH_CLIENT_PATH ?? "");
      const tokenPath = path.resolve(cwd, environment.GMAIL_OAUTH_TOKEN_PATH ?? "");
      const desktop = parseDesktopOAuthClient(JSON.parse(fs.readFileSync(clientPath, "utf8")));
      const stored = JSON.parse(fs.readFileSync(tokenPath, "utf8")) as Record<string, unknown>;
      if (typeof stored.refresh_token !== "string") throw new Error("gmail oauth unavailable");
      const client = new google.auth.OAuth2({ clientId: desktop.clientId, clientSecret: desktop.clientSecret });
      client.setCredentials({ refresh_token: stored.refresh_token });
      const gmail = google.gmail({ version: "v1", auth: client });
      const profile = await gmail.users.getProfile({ userId: "me" });
      const access = await client.getAccessToken();
      if (!access.token) throw new Error("gmail oauth unavailable");
      const info = await client.getTokenInfo(access.token);
      const required = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"];
      return {
        reachable: Boolean(profile.data.emailAddress),
        scopesValid: JSON.stringify([...info.scopes].sort()) === JSON.stringify([...required].sort()),
      };
    },
    async mcp() {
      const port = validPort(environment.BANDER_PORT, 4310);
      const client = new Client({ name: "bander-doctor", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
      try {
        await client.connect(transport as Parameters<Client["connect"]>[0]);
        const tools = (await client.listTools()).tools.map((tool) => `bander__${tool.name}`);
        return { tools };
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };
}

async function liveChecks(
  options: DoctorOptions,
  state: TelegramServiceState | undefined,
): Promise<DoctorCheck[]> {
  const probes = options.probes ?? await createDefaultLiveProbes(options.cwd, options.environment, state);
  const checks: DoctorCheck[] = [];
  try {
    const telegram = await probes.telegram();
    checks.push(
      telegram.botReachable && telegram.groupReachable && telegram.ownerBindingValid
        ? check("PASS", "Live Telegram", "The Bander bot, protected group, and owner binding are reachable.")
        : check("FAIL", "Live Telegram", "The live Bander bot, group, or owner binding did not validate.", "Check BotFather settings and repeat owner/group pairing."),
    );
  } catch {
    checks.push(check("FAIL", "Live Telegram", "The Bander Telegram read-only probe could not validate the configured bot and group.", "Check network access, bot configuration, and pairing, then rerun npm run doctor -- --live."));
  }
  try {
    const googleResult = await probes.google();
    const configured = options.environment.BANDER_CALENDAR_TIME_ZONE?.trim();
    checks.push(
      configured && googleResult.timeZone === configured
        ? check("PASS", "Live Google Calendar", `The primary Calendar is readable and uses ${googleResult.timeZone}.`)
        : check("FAIL", "Live Google Calendar", "The primary Calendar timezone does not match the configured timezone.", "Set BANDER_CALENDAR_TIME_ZONE to the authoritative primary Calendar timezone."),
    );
  } catch {
    checks.push(check("FAIL", "Live Google Calendar", "The read-only primary Calendar timezone probe failed.", "Renew Google OAuth if needed, then rerun npm run doctor -- --live."));
  }
  try {
    const gmail = await probes.gmail();
    checks.push(
      gmail.reachable && gmail.scopesValid
        ? check("PASS", "Live Gmail", "The separately authorized Gmail account is readable and has only the required read/send capability configured.")
        : check("FAIL", "Live Gmail", "The Gmail identity or required scopes did not validate.", "Rotate the Gmail token and complete Gmail consent again."),
    );
  } catch {
    checks.push(check("FAIL", "Live Gmail", "The read-only Gmail identity/scope probe failed.", "Renew the separate Gmail OAuth token, then rerun npm run doctor -- --live."));
  }
  try {
    const actual = (await probes.mcp()).tools.slice().sort();
    const expected = [...BANDER_REAL_OPENCLAW_TOOLS].sort();
    checks.push(
      JSON.stringify(actual) === JSON.stringify(expected)
        ? check("PASS", "Bander tool inventory", "The running real MCP surface exposes exactly five expected tools.")
        : check("FAIL", "Bander tool inventory", "The running MCP surface is missing tools or exposes an unexpected tool.", "Start npm run real from this checkout and rerun npm run doctor -- --live."),
    );
  } catch {
    checks.push(check("FAIL", "Bander tool inventory", "The live read-only MCP inventory probe could not connect.", "Start npm run real in another terminal, then rerun npm run doctor -- --live."));
  }
  checks.push(check(
    options.environment.OPENAI_API_KEY?.trim() ? "WARN" : "FAIL",
    "OpenAI health",
    options.environment.OPENAI_API_KEY?.trim()
      ? "The key is configured; the non-authoritative live evidence call is intentionally delegated to the existing verifier."
      : "The OpenAI key is not configured.",
    options.environment.OPENAI_API_KEY?.trim()
      ? "Run npm run verify:read-sol when live model evidence is needed."
      : "Set OPENAI_API_KEY locally, then rerun the doctor.",
  ));
  return checks;
}

export async function collectDoctorReport(options: DoctorOptions): Promise<DoctorReport> {
  const cwd = path.resolve(options.cwd);
  const stateResult = readTelegramState(cwd, options.environment);
  const ports = [
    validPort(options.environment.BANDER_PORT, 4310),
    validPort(options.environment.MOCK_SERVICE_PORT, 4311),
    validPort(options.environment.WEB_PORT, 4312),
  ];
  const probePort = options.portAvailable ?? defaultPortAvailable;
  const portResults = await Promise.all(ports.map((port) => probePort(port)));
  const checks: DoctorCheck[] = [
    ...dependencyChecks(cwd),
    configuredEnvironmentCheck(options.environment),
    oauthFilesCheck(cwd, options.environment),
    artifactCheck(cwd),
    portResults.every(Boolean)
      ? check("PASS", "Local ports", "Bander, mock-service, and web ports are available.")
      : check("WARN", "Local ports", "One or more Bander ports are busy; a Bander/OpenClaw process may already be running.", "Stop the existing Bander stack normally, or keep it running and use npm run doctor -- --live. The doctor never kills processes."),
    ...telegramStateChecks(stateResult),
    documentationCheck(cwd),
    check(
      "WARN",
      "BotFather privacy",
      "BotFather privacy requires the documented empirical check.",
      "Run npm run verify:telegram-privacy and follow the BotFather procedure in SETUP.md.",
    ),
  ];
  if (options.live) checks.push(...await liveChecks(options, stateResult.state));
  const summary = checks.reduce<Record<DoctorStatus, number>>(
    (result, item) => ({ ...result, [item.status]: result[item.status] + 1 }),
    { PASS: 0, WARN: 0, FAIL: 0 },
  );
  return { mode: options.live ? "live" : "offline", checks, summary };
}

function fit(value: string, width: number): string {
  const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length <= width ? normalized.padEnd(width) : `${normalized.slice(0, width - 1)}…`;
}

export function formatDoctorTable(report: DoctorReport): string {
  const lines = [
    `Bander doctor (${report.mode}, read-only)`,
    "",
    `${fit("STATUS", 7)}  ${fit("CHECK", 24)}  ${fit("WHAT IT MEANS", 60)}  NEXT ACTION`,
    `${"-".repeat(7)}  ${"-".repeat(24)}  ${"-".repeat(60)}  ${"-".repeat(42)}`,
    ...report.checks.map((item) =>
      `${fit(item.status, 7)}  ${fit(item.check, 24)}  ${fit(item.meaning, 60)}  ${item.nextAction}`,
    ),
    "",
    `Summary: ${report.summary.PASS} PASS · ${report.summary.WARN} WARN · ${report.summary.FAIL} FAIL`,
    "The doctor made no changes.",
  ];
  return lines.join("\n");
}

export function formatDoctorJson(report: DoctorReport): string {
  return JSON.stringify({ ...report, readOnly: true }, null, 2);
}
