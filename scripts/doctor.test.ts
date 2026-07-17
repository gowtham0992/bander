import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  collectDoctorReport,
  formatDoctorJson,
  formatDoctorTable,
  parseDoctorArguments,
  type DoctorLiveProbes,
} from "./doctor-lib.js";

const secretEnvironment = {
  BANDER_RUNTIME_MODE: "real",
  OPENAI_API_KEY: "OPENAI_TEST_SECRET_VALUE_SHOULD_NEVER_PRINT",
  BANDER_TELEGRAM_BOT_TOKEN: "BANDER_TELEGRAM_TEST_SECRET_SHOULD_NEVER_PRINT",
  OPENCLAW_TELEGRAM_BOT_TOKEN: "OPENCLAW_TELEGRAM_TEST_SECRET_SHOULD_NEVER_PRINT",
  GOOGLE_OAUTH_CLIENT_PATH: "/Users/private-person/.bander/google-client.json",
  GOOGLE_OAUTH_TOKEN_PATH: "/Users/private-person/.bander/google-token.json",
  GMAIL_OAUTH_CLIENT_PATH: "/Users/private-person/.bander/gmail-client.json",
  GMAIL_OAUTH_TOKEN_PATH: "/Users/private-person/.bander/gmail-token.json",
  BANDER_CALENDAR_TIME_ZONE: "America/Denver",
} as const;

describe("unified Bander doctor", () => {
  it("doctor_runs_without_env_and_reports_actionable_failures", async () => {
    const report = await collectDoctorReport({ cwd: process.cwd(), environment: {}, live: false });
    const output = formatDoctorTable(report);
    expect(output).toContain("FAIL");
    expect(output).toContain("Copy .env.example to .env");
    expect(output).not.toContain("Error:");
  });

  it("doctor_never_prints_secret_values", async () => {
    const report = await collectDoctorReport({ cwd: process.cwd(), environment: secretEnvironment, live: false });
    const output = formatDoctorTable(report);
    for (const value of Object.values(secretEnvironment)) {
      if (value.startsWith("/") || value === "real" || value === "America/Denver") continue;
      expect(output).not.toContain(value);
    }
    expect(output).not.toContain("private-person");
  });

  it("doctor_json_never_contains_identifiers_or_tokens", async () => {
    const report = await collectDoctorReport({ cwd: process.cwd(), environment: secretEnvironment, live: false });
    const output = formatDoctorJson(report);
    expect(output).not.toMatch(/test_secret|private-person|chatId|ownerTelegramId/i);
  });

  it("doctor_does_not_modify_telegram_state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bander-doctor-state-"));
    const statePath = path.join(root, "state.json");
    const content = JSON.stringify({ version: 1, proposals: [], standingCandidates: [], standingOutcomes: [], familyNotifications: [] });
    fs.writeFileSync(statePath, content, { mode: 0o600 });
    await collectDoctorReport({ cwd: process.cwd(), environment: { BANDER_TELEGRAM_STATE_PATH: statePath }, live: false });
    expect(fs.readFileSync(statePath, "utf8")).toBe(content);
  });

  it("doctor_does_not_create_authority_write_calendar_or_send_telegram", async () => {
    const calls = { telegramReads: 0, googleReads: 0, gmailReads: 0, mcpReads: 0, writes: 0 };
    const probes: DoctorLiveProbes = {
      telegram: async () => { calls.telegramReads += 1; return { botReachable: true, groupReachable: true, ownerBindingValid: true }; },
      google: async () => { calls.googleReads += 1; return { timeZone: "America/Denver" }; },
      gmail: async () => { calls.gmailReads += 1; return { reachable: true, scopesValid: true }; },
      mcp: async () => { calls.mcpReads += 1; return { tools: ["bander__get_receipt", "bander__list_capabilities", "bander__propose_action", "bander__read_schedule", "bander__read_inbox"] }; },
      forbiddenWrite: () => { calls.writes += 1; },
    };
    await collectDoctorReport({ cwd: process.cwd(), environment: secretEnvironment, live: true, probes });
    expect(calls).toEqual({ telegramReads: 1, googleReads: 1, gmailReads: 1, mcpReads: 1, writes: 0 });
  });

  it("doctor_rejects_a_shared_calendar_and_gmail_token_file", async () => {
    const report = await collectDoctorReport({
      cwd: process.cwd(),
      environment: {
        ...secretEnvironment,
        GMAIL_OAUTH_TOKEN_PATH: secretEnvironment.GOOGLE_OAUTH_TOKEN_PATH,
      },
      live: false,
    });
    expect(report.checks.find((check) => check.check === "Google OAuth files")).toMatchObject({ status: "FAIL" });
  });

  it("doctor_distinguishes_optional_family_contact", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bander-doctor-no-family-"));
    const statePath = path.join(root, "state.json");
    fs.writeFileSync(
      statePath,
      JSON.stringify({ version: 1, proposals: [], standingCandidates: [], standingOutcomes: [], familyNotifications: [] }),
      { mode: 0o600 },
    );
    const report = await collectDoctorReport({
      cwd: process.cwd(),
      environment: { BANDER_TELEGRAM_STATE_PATH: statePath },
      live: false,
    });
    const family = report.checks.find((check) => check.check === "Family contact");
    expect(family?.status).toBe("WARN");
    expect(family?.meaning).toContain("Calendar-only use remains available");
  });

  it("doctor_fails_on_invalid_persisted_state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bander-doctor-invalid-"));
    const statePath = path.join(root, "state.json");
    fs.writeFileSync(statePath, "{not-json", { mode: 0o600 });
    const report = await collectDoctorReport({ cwd: process.cwd(), environment: { BANDER_TELEGRAM_STATE_PATH: statePath }, live: false });
    expect(report.checks.find((check) => check.check === "Telegram state")?.status).toBe("FAIL");
  });

  it("doctor_reports_busy_ports_without_killing_processes", async () => {
    const probe = vi.fn(async () => false);
    const report = await collectDoctorReport({ cwd: process.cwd(), environment: {}, live: false, portAvailable: probe });
    expect(report.checks.find((check) => check.check === "Local ports")?.status).toBe("WARN");
    expect(probe).toHaveBeenCalled();
  });

  it("doctor_does_not_claim_botfather_privacy_is_verified", async () => {
    const report = await collectDoctorReport({ cwd: process.cwd(), environment: secretEnvironment, live: true, probes: {
      telegram: async () => ({ botReachable: true, groupReachable: true, ownerBindingValid: true }),
      google: async () => ({ timeZone: "America/Denver" }),
      gmail: async () => ({ reachable: true, scopesValid: true }),
      mcp: async () => ({ tools: ["bander__get_receipt", "bander__list_capabilities", "bander__propose_action", "bander__read_schedule", "bander__read_inbox"] }),
    } });
    const privacy = report.checks.find((check) => check.check === "BotFather privacy");
    expect(privacy).toMatchObject({ status: "WARN" });
    expect(privacy?.meaning).toContain("requires the documented empirical check");
  });

  it("live_doctor_requires_exactly_five_tools", async () => {
    const report = await collectDoctorReport({ cwd: process.cwd(), environment: secretEnvironment, live: true, probes: {
      telegram: async () => ({ botReachable: true, groupReachable: true, ownerBindingValid: true }),
      google: async () => ({ timeZone: "America/Denver" }),
      gmail: async () => ({ reachable: true, scopesValid: true }),
      mcp: async () => ({ tools: ["bander__propose_action"] }),
    } });
    expect(report.checks.find((check) => check.check === "Bander tool inventory")?.status).toBe("FAIL");
  });

  it("unknown_doctor_flags_fail_safely", () => {
    expect(() => parseDoctorArguments(["--explode"])).toThrow("Usage: npm run doctor -- [--live] [--json]");
  });
});
