import { describe, expect, it } from "vitest";
import fs from "node:fs";

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
  });
});
