import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FileTelegramServiceStore } from "../apps/broker/src/telegram-service.js";
import type { OwnershipManifest } from "./setup-lib.js";

function confined(root: string, configured: string): string {
  const boundary = path.resolve(root, ".bander");
  const target = path.resolve(root, configured);
  if (target === boundary || !target.startsWith(`${boundary}${path.sep}`)) throw new Error("Recovery paths must be narrowly confined below the repository-local .bander directory");
  return target;
}
function statePath(root: string, environment: Record<string, string | undefined>): string { return confined(root, environment.BANDER_TELEGRAM_STATE_PATH ?? ".bander/real/telegram-service/state.json"); }

export async function resetPairing(options: { root: string; environment: Record<string, string | undefined>; includeFamily: boolean; productStopped: () => Promise<boolean> }): Promise<{ familyRevoked: boolean }> {
  if (!(await options.productStopped())) throw new Error("Stop the repository-local product before resetting pairing");
  const store = new FileTelegramServiceStore(statePath(options.root, options.environment));
  const state = store.read();
  if ((state.familyContact?.status === "active" || state.familyPairing) && !options.includeFamily) throw new Error("An active or pending family relationship exists. Rerun with --include-family to revoke it before removing the owning installation.");
  const familyRevoked = state.familyContact?.status === "active";
  delete state.familyContact;
  delete state.familyPairing;
  delete state.familyContactAudit;
  delete state.installation;
  delete state.pairing;
  state.proposals = [];
  state.standingCandidates = [];
  state.standingOutcomes = [];
  state.familyNotifications = [];
  delete state.standingBand;
  delete state.oneTimeReviewMode;
  store.write(state);
  const pairingFiles = [
    options.environment.BANDER_TELEGRAM_PAIRING_PATH ?? ".bander/real/telegram-service/pairing-link.txt",
    ...(options.includeFamily ? [options.environment.BANDER_FAMILY_PAIRING_PATH ?? ".bander/real/family-pairing-link.txt"] : []),
  ];
  for (const configured of pairingFiles) fs.rmSync(confined(options.root, configured), { force: true });
  return { familyRevoked };
}

export async function reauthorizeGoogle(options: { root: string; environment: Record<string, string | undefined>; services: Array<"calendar" | "gmail">; authorize: (service: "calendar" | "gmail") => Promise<void> }): Promise<void> {
  for (const service of options.services) {
    const tokenKey = service === "calendar" ? "GOOGLE_OAUTH_TOKEN_PATH" : "GMAIL_OAUTH_TOKEN_PATH";
    const configured = options.environment[tokenKey];
    if (!configured) throw new Error(`${tokenKey} is not configured`);
    const token = confined(options.root, configured);
    if (fs.existsSync(token)) fs.unlinkSync(token);
    await options.authorize(service);
  }
}

function loadManifest(root: string): OwnershipManifest | undefined {
  const file = path.join(root, ".bander", "ownership-manifest.json");
  if (!fs.existsSync(file)) return undefined;
  try { const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as OwnershipManifest; if (parsed.version !== 1 || !Array.isArray(parsed.files) || !Array.isArray(parsed.createdEnv)) throw new Error(); return parsed; }
  catch { throw new Error("Ownership manifest is corrupt or unsupported; preserve it and recover manually from SETUP.md"); }
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function planLocalUninstall(options: { root: string; environment: Record<string, string | undefined>; includeOauthClients?: boolean }): { files: string[]; envKeys: string[] } {
  const manifest = loadManifest(options.root);
  if (!manifest) return { files: [], envKeys: [] };
  const clientPaths = new Set([options.environment.GOOGLE_OAUTH_CLIENT_PATH, options.environment.GMAIL_OAUTH_CLIENT_PATH].filter((value): value is string => Boolean(value)).map((value) => confined(options.root, value)));
  const files = manifest.files.filter((relative) => {
    const target = confined(options.root, relative);
    if (!options.includeOauthClients && clientPaths.has(target)) return false;
    return fs.existsSync(target);
  });
  const envKeys = manifest.createdEnv.filter(({ key, valueDigest }) => options.environment[key] !== undefined && digest(options.environment[key]!) === valueDigest).map(({ key }) => key);
  return { files, envKeys };
}
export async function runLocalUninstall(options: { root: string; environment: Record<string, string | undefined>; confirmed: boolean; includeOauthClients?: boolean }): Promise<{ alreadyClean: boolean; removedFiles: number }> {
  if (!options.confirmed) throw new Error("Uninstall is dry-run by default; pass --confirm after reviewing the plan");
  const manifest = loadManifest(options.root);
  if (!manifest) return { alreadyClean: true, removedFiles: 0 };
  const plan = planLocalUninstall(options);
  for (const relative of plan.files) fs.rmSync(confined(options.root, relative), { force: true, recursive: true });
  const envFile = path.join(options.root, ".env");
  if (plan.envKeys.length && fs.existsSync(envFile)) {
    const keys = new Set(plan.envKeys);
    const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/).filter((line) => !keys.has(line.split("=", 1)[0]!));
    fs.writeFileSync(envFile, lines.join("\n"), { mode: 0o600 });
  }
  fs.rmSync(path.join(options.root, ".bander", "ownership-manifest.json"), { force: true });
  return { alreadyClean: false, removedFiles: plan.files.length };
}
