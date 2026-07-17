import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const REQUIRED_GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
] as const;

const REQUIRED_KEYS = [
  "BANDER_RUNTIME_MODE", "OPENAI_API_KEY", "BANDER_TELEGRAM_BOT_TOKEN",
  "OPENCLAW_TELEGRAM_BOT_TOKEN", "GOOGLE_OAUTH_CLIENT_PATH",
  "GOOGLE_OAUTH_TOKEN_PATH", "GMAIL_OAUTH_CLIENT_PATH",
  "GMAIL_OAUTH_TOKEN_PATH", "BANDER_CALENDAR_TIME_ZONE",
] as const;
const STATE = ".bander/setup-state.json";
const MANIFEST = ".bander/ownership-manifest.json";
const KEY = ".bander/setup-verifier.key";
const EVIDENCE = ".bander/telegram-privacy-evidence.json";
const MAX_EVIDENCE_AGE_MS = 60 * 60 * 1000;

type Milestone = "prerequisites" | "environment" | "owner_pairing" | "telegram_privacy" | "google" | "doctor" | "ready";
export interface SetupState {
  version: 1;
  challenge: string;
  configDigest: string;
  milestones: Milestone[];
  createdEnvKeys: string[];
}
export interface OwnershipManifest {
  version: 1;
  files: string[];
  createdEnv: Array<{ key: string; valueDigest: string }>;
}
export interface SetupProbes {
  localPrerequisites(): Promise<{ ok: boolean }>;
  ownerPairing(): Promise<{ ok: boolean }>;
  google(): Promise<{ ok: boolean; calendarTimeZone: string; gmailScopes: string[] }>;
  doctor(): Promise<{ ok: boolean }>;
}
export interface SetupOptions {
  root: string;
  home: string;
  environment: Record<string, string | undefined>;
  probes: SetupProbes;
  now?: () => Date;
}

function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function privateWrite(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, value, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}
function underRoot(root: string, configured: string): string {
  const bander = path.resolve(root, ".bander");
  const target = path.resolve(root, configured);
  if (target !== bander && !target.startsWith(`${bander}${path.sep}`)) throw new Error("Configured paths must be confined to the repository-local .bander directory");
  return target;
}
function configDigest(environment: Record<string, string | undefined>): string {
  return sha(REQUIRED_KEYS.map((key) => `${key}:${sha(environment[key] ?? "")}`).join("\n"));
}

export function initializeSetupEnvironment(root: string, template: string): void {
  const envFile = path.join(root, ".env");
  if (fs.existsSync(envFile)) throw new Error("The ignored .env already exists and will not be overwritten");
  privateWrite(envFile, template);
  ensureManifest(root);
  verifierKey(root);
  const values = Object.fromEntries(template.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    return match ? [[match[1]!, match[2]!]] : [];
  }));
  const state: SetupState = { version: 1, challenge: randomBytes(24).toString("base64url"), configDigest: configDigest(values), milestones: [], createdEnvKeys: Object.keys(values) };
  saveState(root, state);
  const manifestFile = path.join(root, MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as OwnershipManifest;
  manifest.createdEnv = Object.entries(values).map(([key, value]) => ({ key, valueDigest: sha(value) }));
  privateWrite(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function redactSetupText(value: string, secretValues: readonly string[]): string {
  let redacted = value;
  for (const secret of secretValues.filter((candidate) => candidate.length >= 4)) redacted = redacted.split(secret).join("[redacted]");
  return redacted.replace(/(?:sk-[A-Za-z0-9_-]{8,}|[0-9]{8,}:[A-Za-z0-9_-]{8,})/g, "[redacted]");
}
function validateEnvironment(root: string, environment: Record<string, string | undefined>): void {
  const missing = REQUIRED_KEYS.filter((key) => !environment[key]?.trim());
  if (missing.length) throw new Error(`Edit the ignored .env and set: ${missing.join(", ")}. Values were not printed.`);
  if (environment.BANDER_RUNTIME_MODE !== "real") throw new Error("Set BANDER_RUNTIME_MODE=real in the ignored .env");
  const pathKeys = ["GOOGLE_OAUTH_CLIENT_PATH", "GOOGLE_OAUTH_TOKEN_PATH", "GMAIL_OAUTH_CLIENT_PATH", "GMAIL_OAUTH_TOKEN_PATH"] as const;
  const files = pathKeys.map((key) => underRoot(root, environment[key]!));
  const generatedRoots = [path.resolve(root, ".bander/real/product"), path.resolve(root, ".bander/real/telegram-service")];
  if (files.some((file) => generatedRoots.some((generated) => file === generated || file.startsWith(`${generated}${path.sep}`)))) {
    throw new Error("OAuth files must not be placed inside Bander-generated runtime or Telegram-state directories");
  }
  if (files[1] === files[3]) throw new Error("Calendar and Gmail token paths must remain separate");
  for (const file of files) {
    if (!fs.existsSync(file)) throw new Error("A configured OAuth file is missing. Put it in the repository-local ignored .bander directory and rerun setup.");
    if ((fs.statSync(file).mode & 0o077) !== 0) throw new Error("OAuth files must use restrictive 0600 permissions");
  }
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath) || (fs.statSync(envPath).mode & 0o077) !== 0) throw new Error("The ignored .env must exist with 0600 permissions");
}

export function assertExactGmailScopes(scopes: readonly string[]): void {
  const actual = new Set(scopes);
  const missing = REQUIRED_GMAIL_SCOPES.filter((scope) => !actual.has(scope));
  const unexpected = [...actual].filter((scope) => !REQUIRED_GMAIL_SCOPES.includes(scope as typeof REQUIRED_GMAIL_SCOPES[number]));
  if (missing.length) throw new Error("Gmail consent is missing an exact required scope");
  if (unexpected.length) throw new Error("Gmail consent contains an unexpected scope");
}

export function loadSetupState(root: string): SetupState | undefined {
  const file = path.join(root, STATE);
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as SetupState;
    if (parsed.version !== 1 || !Array.isArray(parsed.milestones) || !Array.isArray(parsed.createdEnvKeys) || typeof parsed.challenge !== "string" || typeof parsed.configDigest !== "string") throw new Error();
    return parsed;
  } catch {
    throw new Error("Setup state is corrupt or unsupported. Preserve it for diagnosis, then use npm run uninstall:local -- --dry-run for safe recovery.");
  }
}

function saveState(root: string, state: SetupState): void { privateWrite(path.join(root, STATE), `${JSON.stringify(state, null, 2)}\n`); }
function ensureManifest(root: string): void {
  const file = path.join(root, MANIFEST);
  if (fs.existsSync(file)) return;
  const manifest: OwnershipManifest = {
    version: 1,
    files: [
      STATE, KEY, EVIDENCE,
      ".bander/real/product",
      ".bander/real/telegram-service",
      ".bander/real/pairing-link.txt",
      ".bander/real/telegram-service/family-contact-link.txt",
    ],
    createdEnv: [],
  };
  privateWrite(file, `${JSON.stringify(manifest, null, 2)}\n`);
}
function registerConfiguredOwnership(root: string, environment: Record<string, string | undefined>): void {
  const file = path.join(root, MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as OwnershipManifest;
  for (const key of ["GOOGLE_OAUTH_CLIENT_PATH", "GOOGLE_OAUTH_TOKEN_PATH", "GMAIL_OAUTH_CLIENT_PATH", "GMAIL_OAUTH_TOKEN_PATH"] as const) {
    const configured = environment[key];
    if (!configured) continue;
    const target = underRoot(root, configured);
    const relative = path.relative(root, target);
    if (!manifest.files.includes(relative)) manifest.files.push(relative);
  }
  privateWrite(file, `${JSON.stringify(manifest, null, 2)}\n`);
}
function verifierKey(root: string): Buffer {
  const file = path.join(root, KEY);
  if (!fs.existsSync(file)) privateWrite(file, randomBytes(32).toString("hex"));
  const value = fs.readFileSync(file, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Setup verifier key is corrupt; preserve state and follow the recovery guide");
  return Buffer.from(value, "hex");
}

export function createTelegramPrivacyEvidence(root: string, options: { completedAt?: string } = {}): void {
  const state = loadSetupState(root);
  if (!state) throw new Error("Run repository-local setup before the empirical Telegram privacy verifier");
  const completedAt = options.completedAt ?? new Date().toISOString();
  const payload = { version: 1 as const, challenge: state.challenge, configDigest: state.configDigest, completedAt, verifier: "verify:telegram-privacy", observationsDigest: sha("owner-boundary|wrong-chat|wrong-message|imitation|credential-isolation") };
  const mac = createHmac("sha256", verifierKey(root)).update(JSON.stringify(payload)).digest("hex");
  privateWrite(path.join(root, EVIDENCE), `${JSON.stringify({ ...payload, mac }, null, 2)}\n`);
}

export function verifyTelegramPrivacyEvidence(root: string, now = new Date()): true {
  const state = loadSetupState(root);
  if (!state) throw new Error("Telegram privacy evidence has no setup challenge");
  let artifact: Record<string, unknown>;
  try { artifact = JSON.parse(fs.readFileSync(path.join(root, EVIDENCE), "utf8")) as Record<string, unknown>; }
  catch { throw new Error("Telegram privacy evidence is missing or invalid; run npm run verify:telegram-privacy"); }
  const { mac, ...payload } = artifact;
  if (artifact.version !== 1 || typeof mac !== "string" || artifact.verifier !== "verify:telegram-privacy") throw new Error("Telegram privacy evidence is not a signed empirical artifact");
  if (artifact.challenge !== state.challenge || artifact.configDigest !== state.configDigest) throw new Error("Telegram privacy evidence does not match the current configuration");
  const completed = Date.parse(String(artifact.completedAt));
  if (!Number.isFinite(completed) || now.getTime() - completed > MAX_EVIDENCE_AGE_MS || completed > now.getTime() + 60_000) throw new Error("Telegram privacy evidence is stale; rerun the empirical verifier");
  const expected = createHmac("sha256", verifierKey(root)).update(JSON.stringify(payload)).digest();
  const actual = Buffer.from(mac, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Telegram privacy evidence signature is invalid");
  return true;
}

export async function runRepositorySetup(options: SetupOptions): Promise<{ status: "in_progress" | "ready"; step: string }> {
  const root = path.resolve(options.root);
  let state = loadSetupState(root);
  ensureManifest(root);
  verifierKey(root);
  const digest = configDigest(options.environment);
  if (!state) state = { version: 1, challenge: randomBytes(24).toString("base64url"), configDigest: digest, milestones: [], createdEnvKeys: [] };
  if (state.configDigest !== digest) {
    state = { ...state, challenge: randomBytes(24).toString("base64url"), configDigest: digest, milestones: state.milestones.filter((item) => item === "prerequisites") };
  }
  const done = new Set(state.milestones);
  const finish = (step: Milestone) => { if (!done.has(step)) state!.milestones.push(step); saveState(root, state!); return { status: step === "ready" ? "ready" as const : "in_progress" as const, step }; };
  if (!done.has("prerequisites")) {
    if (!(await options.probes.localPrerequisites()).ok) throw new Error("Local prerequisites are not ready");
    state.milestones.push("prerequisites");
    done.add("prerequisites");
    saveState(root, state);
  }
  if (!done.has("environment")) { validateEnvironment(root, options.environment); registerConfiguredOwnership(root, options.environment); return finish("environment"); }
  if (!done.has("owner_pairing")) { if (!(await options.probes.ownerPairing()).ok) throw new Error("Owner/group pairing is not complete"); return finish("owner_pairing"); }
  if (!done.has("telegram_privacy")) {
    if (!fs.existsSync(path.join(root, EVIDENCE))) {
      saveState(root, state);
      return { status: "in_progress", step: "telegram_privacy" };
    }
    verifyTelegramPrivacyEvidence(root, options.now?.() ?? new Date());
    return finish("telegram_privacy");
  }
  if (!done.has("google")) { const result = await options.probes.google(); if (!result.ok || result.calendarTimeZone !== options.environment.BANDER_CALENDAR_TIME_ZONE) throw new Error("Google Calendar timezone does not match configuration"); assertExactGmailScopes(result.gmailScopes); return finish("google"); }
  if (!done.has("doctor")) { if (!(await options.probes.doctor()).ok) throw new Error("Start npm run real in a second terminal, resolve every live doctor FAIL, then rerun npm run setup"); return finish("doctor"); }
  if (!done.has("ready")) return finish("ready");
  return { status: "ready", step: "ready" };
}
