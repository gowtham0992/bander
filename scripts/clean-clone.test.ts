import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { assertWorkingTreeClean, copyCurrentCheckout } from "./verify-clean-clone.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function withCleanCheckout(run: (source: string, clone: string) => void): void {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "bander-clean-checkout-test-"));
  const source = path.join(temporary, "source");
  const clone = path.join(temporary, "clone");
  try {
    fs.mkdirSync(source);
    git(source, "init", "--quiet");
    fs.writeFileSync(path.join(source, "proof.txt"), "original\n");
    git(source, "add", "proof.txt");
    git(
      source,
      "-c",
      "user.name=Bander Test",
      "-c",
      "user.email=bander-test@invalid",
      "commit",
      "--quiet",
      "-m",
      "initial",
    );
    git(temporary, "clone", "--quiet", "--no-hardlinks", source, clone);
    run(source, clone);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

describe("clean-clone acceptance contract", () => {
  it("clean_clone_currently_lacks_no_account_doctor_path", () => {
    const scripts = JSON.parse(fs.readFileSync("package.json", "utf8")).scripts;
    expect(scripts.doctor).toBeDefined();
  });

  it("clean_clone_verifier_is_scoped_and_offline_for_product_probes", () => {
    const source = fs.readFileSync("scripts/verify-clean-clone.ts", "utf8");
    expect(source).toContain("/private/tmp/bander-clean-clone-");
    expect(source).toContain("HTTPS_PROXY");
    expect(source).toContain("delete sanitizedEnvironment.OPENAI_API_KEY");
    expect(source).toContain("delete sanitizedEnvironment.BANDER_TELEGRAM_BOT_TOKEN");
    expect(source).toContain("delete sanitizedEnvironment.GOOGLE_OAUTH_TOKEN_PATH");
    expect(source).toContain('run("npm", ["run", "verify:pages"]');
    expect(source).toContain('docs/assets/screenshots/manifest.json');
  });

  it("clean_checkout_snapshot_skips_an_empty_ephemeral_commit", () => {
    withCleanCheckout((source, clone) => {
      expect(() => copyCurrentCheckout(source, clone)).not.toThrow();
      expect(git(clone, "rev-list", "--count", "HEAD")).toBe("1");
      expect(git(clone, "status", "--porcelain")).toBe("");
    });
  });

  it("clean_checkout_snapshot_commits_real_source_differences", () => {
    withCleanCheckout((source, clone) => {
      fs.writeFileSync(path.join(source, "proof.txt"), "proposed change\n");
      copyCurrentCheckout(source, clone);
      expect(fs.readFileSync(path.join(clone, "proof.txt"), "utf8")).toBe("proposed change\n");
      expect(git(clone, "rev-list", "--count", "HEAD")).toBe("2");
      expect(git(clone, "status", "--porcelain")).toBe("");
    });
  });

  it("clean_clone_verifier_rejects_unexpected_generated_changes", () => {
    withCleanCheckout((_source, clone) => {
      fs.writeFileSync(path.join(clone, "unexpected.txt"), "unexpected\n");
      expect(() => assertWorkingTreeClean(clone)).toThrow(
        "The isolated verification changed the repository working tree",
      );
    });
  });
});
