import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileTelegramServiceStore } from "../apps/broker/src/telegram-service.js";
import {
  assertExactGmailScopes,
  createTelegramPrivacyEvidence,
  loadSetupState,
  runRepositorySetup,
  verifyTelegramPrivacyEvidence,
  redactSetupText,
  type SetupProbes,
} from "./setup-lib.js";
import {
  planLocalUninstall,
  reauthorizeGoogle,
  resetPairing,
  runLocalUninstall,
} from "./local-recovery-lib.js";

const requiredScopes = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

function privateFile(filePath: string, value = "fixture"): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, value, { mode: 0o600 });
}

function fixtureRoot(): { root: string; home: string; environment: Record<string, string> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bander-setup-test-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bander-existing-home-"));
  privateFile(path.join(home, ".openclaw", "config.json"), '{"existing":true}');
  privateFile(path.join(root, ".bander", "calendar-client.json"));
  privateFile(path.join(root, ".bander", "calendar-token.json"));
  privateFile(path.join(root, ".bander", "gmail-client.json"));
  privateFile(path.join(root, ".bander", "gmail-token.json"));
  const environment = {
    BANDER_RUNTIME_MODE: "real",
    OPENAI_API_KEY: "model-secret-not-for-output",
    BANDER_TELEGRAM_BOT_TOKEN: "bander-secret-not-for-output",
    OPENCLAW_TELEGRAM_BOT_TOKEN: "openclaw-secret-not-for-output",
    GOOGLE_OAUTH_CLIENT_PATH: ".bander/calendar-client.json",
    GOOGLE_OAUTH_TOKEN_PATH: ".bander/calendar-token.json",
    GMAIL_OAUTH_CLIENT_PATH: ".bander/gmail-client.json",
    GMAIL_OAUTH_TOKEN_PATH: ".bander/gmail-token.json",
    BANDER_CALENDAR_TIME_ZONE: "America/Denver",
  };
  fs.writeFileSync(path.join(root, ".env"), Object.entries(environment).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { mode: 0o600 });
  return { root, home, environment };
}

function probes(): SetupProbes {
  return {
    localPrerequisites: vi.fn(async () => ({ ok: true })),
    ownerPairing: vi.fn(async () => ({ ok: true })),
    google: vi.fn(async () => ({ ok: true, calendarTimeZone: "America/Denver", gmailScopes: requiredScopes })),
    doctor: vi.fn(async () => ({ ok: true })),
  };
}

function treeDigest(root: string): string {
  const hash = createHash("sha256");
  const walk = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
  for (const file of walk(root).sort()) {
    hash.update(path.relative(root, file));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex");
}

describe("repository-local setup and recovery", () => {
  it("setup_resumes_and_completed_steps_are_idempotent_without_touching_existing_openclaw", async () => {
    const current = fixtureRoot();
    const before = treeDigest(current.home);
    const setupProbes = probes();
    let result = await runRepositorySetup({ ...current, probes: setupProbes, now: () => new Date("2026-07-16T18:00:00Z") });
    expect(result.step).toBe("environment");
    result = await runRepositorySetup({ ...current, probes: setupProbes, now: () => new Date("2026-07-16T18:01:00Z") });
    expect(result.step).toBe("owner_pairing");
    result = await runRepositorySetup({ ...current, probes: setupProbes, now: () => new Date("2026-07-16T18:02:00Z") });
    expect(result.step).toBe("telegram_privacy");
    createTelegramPrivacyEvidence(current.root, { completedAt: "2026-07-16T18:02:30Z" });
    for (let index = 0; index < 4; index += 1) {
      result = await runRepositorySetup({ ...current, probes: setupProbes, now: () => new Date(`2026-07-16T18:0${3 + index}:00Z`) });
    }
    expect(result.status).toBe("ready");
    await runRepositorySetup({ ...current, probes: setupProbes, now: () => new Date("2026-07-16T18:10:00Z") });
    expect(setupProbes.localPrerequisites).toHaveBeenCalledTimes(1);
    expect(setupProbes.ownerPairing).toHaveBeenCalledTimes(1);
    expect(setupProbes.google).toHaveBeenCalledTimes(1);
    expect(setupProbes.doctor).toHaveBeenCalledTimes(1);
    expect(treeDigest(current.home)).toBe(before);
  });

  it("setup_state_contains_no_secret_values_and_corruption_fails_closed", async () => {
    const current = fixtureRoot();
    await runRepositorySetup({ ...current, probes: probes() });
    const stateText = fs.readFileSync(path.join(current.root, ".bander", "setup-state.json"), "utf8");
    for (const value of Object.values(current.environment)) expect(stateText).not.toContain(value);
    fs.writeFileSync(path.join(current.root, ".bander", "setup-state.json"), '{"version":99}', { mode: 0o600 });
    expect(() => loadSetupState(current.root)).toThrow(/preserve.*recover/i);
  });

  it("setup_output_redacts_secret_values_and_secret_shapes", () => {
    const fake = ["sk", "this-is-a-fake-redaction-canary"].join("-");
    const bot = ["123456789", "fake-bot-token-canary"].join(":");
    const output = redactSetupText(`failure ${fake} ${bot}`, [fake, bot]);
    expect(output).not.toContain(fake);
    expect(output).not.toContain(bot);
    expect(output).toContain("[redacted]");
  });

  it("privacy_evidence_is_fresh_configuration_bound_and_not_a_boolean", async () => {
    const current = fixtureRoot();
    await runRepositorySetup({ ...current, probes: probes(), now: () => new Date("2026-07-16T18:00:00Z") });
    await runRepositorySetup({ ...current, probes: probes(), now: () => new Date("2026-07-16T18:01:00Z") });
    await runRepositorySetup({ ...current, probes: probes(), now: () => new Date("2026-07-16T18:02:00Z") });
    const artifactPath = path.join(current.root, ".bander", "telegram-privacy-evidence.json");
    fs.writeFileSync(artifactPath, '{"passed":true}', { mode: 0o600 });
    expect(() => verifyTelegramPrivacyEvidence(current.root, new Date("2026-07-16T18:03:00Z"))).toThrow();
    createTelegramPrivacyEvidence(current.root, { completedAt: "2026-07-16T18:03:00Z" });
    expect(verifyTelegramPrivacyEvidence(current.root, new Date("2026-07-16T18:04:00Z"))).toBe(true);
    expect(() => verifyTelegramPrivacyEvidence(current.root, new Date("2026-07-16T20:00:00Z"))).toThrow(/stale/i);
    current.environment.OPENAI_API_KEY = "different-secret";
    await runRepositorySetup({ ...current, probes: probes(), now: () => new Date("2026-07-16T18:05:00Z") });
    expect(() => verifyTelegramPrivacyEvidence(current.root, new Date("2026-07-16T18:06:00Z"))).toThrow(/configuration/i);
  });

  it("rejects_extra_or_missing_gmail_scopes", () => {
    expect(() => assertExactGmailScopes(requiredScopes)).not.toThrow();
    expect(() => assertExactGmailScopes([requiredScopes[0]!])).toThrow(/missing/i);
    expect(() => assertExactGmailScopes([...requiredScopes, "https://mail.google.com/"])).toThrow(/unexpected/i);
  });

  it("reset_pairing_refuses_active_family_without_explicit_combined_reset", async () => {
    const current = fixtureRoot();
    const statePath = path.join(current.root, ".bander", "real", "telegram-service", "state.json");
    const store = new FileTelegramServiceStore(statePath);
    store.write({
      version: 1,
      installation: { id: "installation_01", ownerTelegramId: "101", chatId: "-500", pairedAt: "2026-07-16T18:00:00Z" },
      proposals: [], standingCandidates: [], standingOutcomes: [], familyNotifications: [],
      familyContact: {
        status: "active", contactId: "contact_01", installationId: "installation_01",
        displayLabel: "Gil", aliases: ["gil"], telegramUserId: "202", privateChatId: "202",
        pairedAt: "2026-07-16T18:00:00Z", consentMessageId: 1,
        pairingAcceptCallbackHash: "a".repeat(64),
        contactRevokeCallbackValue: "contact_revoke_01", ownerRevokeCallbackValue: "owner_revoke_01",
      },
    });
    await expect(resetPairing({ root: current.root, environment: { BANDER_TELEGRAM_STATE_PATH: path.relative(current.root, statePath) }, includeFamily: false, productStopped: async () => true })).rejects.toThrow(/include-family/i);
    const result = await resetPairing({ root: current.root, environment: { BANDER_TELEGRAM_STATE_PATH: path.relative(current.root, statePath) }, includeFamily: true, productStopped: async () => true });
    expect(result.familyRevoked).toBe(true);
    expect(store.read().installation).toBeUndefined();
    expect(store.read().familyContact).toBeUndefined();
    expect(store.read().familyContactAudit).toBeUndefined();
  });

  it("reauthorization_is_confined_and_never_deletes_client_json", async () => {
    const current = fixtureRoot();
    const authorize = vi.fn(async () => undefined);
    await reauthorizeGoogle({ root: current.root, environment: current.environment, services: ["calendar", "gmail"], authorize });
    expect(fs.existsSync(path.join(current.root, ".bander", "calendar-token.json"))).toBe(false);
    expect(fs.existsSync(path.join(current.root, ".bander", "gmail-token.json"))).toBe(false);
    expect(fs.existsSync(path.join(current.root, ".bander", "calendar-client.json"))).toBe(true);
    expect(authorize).toHaveBeenCalledTimes(2);
    privateFile(path.join(current.root, ".bander", "gmail-token.json"));
    await expect(reauthorizeGoogle({ root: current.root, environment: { ...current.environment, GMAIL_OAUTH_TOKEN_PATH: path.join(current.root, "..", "outside-token.json") }, services: ["gmail"], authorize })).rejects.toThrow(/confined/i);
  });

  it("uninstall_is_manifest_driven_selective_and_idempotent", async () => {
    const current = fixtureRoot();
    const unrelated = path.join(current.root, ".bander", "keep-me.txt");
    const beside = path.join(current.root, "unrelated.txt");
    privateFile(unrelated); privateFile(beside);
    await runRepositorySetup({ ...current, probes: probes() });
    const owned = path.join(current.root, ".bander", "generated", "owned.json");
    privateFile(owned);
    const manifestPath = path.join(current.root, ".bander", "ownership-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.files.push(".bander/generated/owned.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    const plan = planLocalUninstall({ root: current.root, environment: current.environment });
    expect(plan.files).toContain(".bander/generated/owned.json");
    await runLocalUninstall({ root: current.root, environment: current.environment, confirmed: true });
    expect(fs.existsSync(owned)).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(fs.existsSync(beside)).toBe(true);
    expect(fs.existsSync(path.join(current.root, ".bander", "calendar-client.json"))).toBe(true);
    await expect(runLocalUninstall({ root: current.root, environment: current.environment, confirmed: true })).resolves.toMatchObject({ alreadyClean: true });
  });

  it("setup_doctor_and_uninstall_leave_synthetic_existing_openclaw_byte_identical", async () => {
    const current = fixtureRoot();
    const outside = path.join(path.dirname(current.root), `${path.basename(current.root)}-outside-canary`);
    privateFile(outside, "outside");
    privateFile(path.join(current.root, "unrelated", "canary.txt"), "repository canary");
    const homeBefore = treeDigest(current.home);
    const setupProbes = probes();
    await runRepositorySetup({ ...current, probes: setupProbes });
    await runRepositorySetup({ ...current, probes: setupProbes });
    await runLocalUninstall({ root: current.root, environment: current.environment, confirmed: true });
    expect(treeDigest(current.home)).toBe(homeBefore);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside");
    expect(fs.readFileSync(path.join(current.root, "unrelated", "canary.txt"), "utf8")).toBe("repository canary");
    fs.rmSync(outside);
  });
});
