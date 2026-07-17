import fs from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => fs.readFileSync(file, "utf8");

describe("Checkpoint 10 evaluator and owner surface", () => {
  it("documents the no-account judge paths and measured timing honestly", () => {
    const source = read("README.md");
    expect(source).toContain("Judge quickstart");
    expect(source).toContain("27 deterministic outcomes");
    expect(source).toContain("both measured warm-cache runs completed in 13 seconds");
    expect(source).toContain("No shared judge account is provided");
    expect(source).toContain("90-second hosted experience");
    expect(source).toContain("Clone + deterministic verification");
    expect(source).toContain("Optional real setup");
  });

  it("describes setup as local guidance rather than modification of existing OpenClaw", () => {
    for (const source of [read("README.md"), read("SETUP.md"), read("docs/architecture.md")]) {
      expect(source).toMatch(/repository-local setup guide and verifier|repository-local, resumable verification/i);
      expect(source).toMatch(/never (?:reads or )?(?:changes|modifies).*\.openclaw|never reads or modifies `~\/\.openclaw`/i);
    }
  });

  it("keeps the unified Pages check and lower-level checks independently runnable", () => {
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
    expect(scripts["verify:pages"]).toContain("verify:pages:artifact");
    expect(scripts["verify:pages"]).toContain("verify:pages:parity");
    expect(scripts["verify:pages:artifact"]).toBeTruthy();
    expect(scripts["verify:pages:parity"]).toBeTruthy();
  });

  it("pins supported OAuth and platform claims without broad onboarding claims", () => {
    const combined = `${read("README.md")}\n${read("SETUP.md")}`;
    expect(combined).toContain("macOS on Apple Silicon");
    expect(combined).toContain("OpenClaw 2026.7.1");
    expect(combined).toContain("External/Testing mode with configured test accounts");
    expect(combined).toContain("Broad production-grade OAuth onboarding for arbitrary public accounts is unsupported");
  });

  it("keeps Pages builds explicitly empty of product credential variables", () => {
    const workflow = read(".github/workflows/pages.yml");
    for (const key of ["OPENAI_API_KEY", "GOOGLE_OAUTH_TOKEN_PATH", "GMAIL_OAUTH_TOKEN_PATH", "BANDER_TELEGRAM_BOT_TOKEN", "OPENCLAW_TELEGRAM_BOT_TOKEN", "MOCK_SERVICE_TOKEN"]) {
      expect(workflow).toContain(`${key}: \"\"`);
    }
  });
});
