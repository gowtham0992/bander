import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createHeroRuntimePaths } from "./hero-runtime.js";

describe("Hero runtime isolation", () => {
  it("uses a dedicated Hero state and configuration tree", () => {
    const paths = createHeroRuntimePaths(".bander/hero", "run-123");

    expect(paths.root).toBe(path.resolve(".bander/hero"));
    expect(paths.telegramState).toBe(
      path.resolve(".bander/hero/telegram-state.json"),
    );
    expect(paths.openclawConfig).toContain(
      path.join(".bander", "hero", "runs", "run-123", "openclaw.json"),
    );
    expect(JSON.stringify(paths)).not.toContain("telegram-service-verification");
    expect(JSON.stringify(paths)).not.toContain("openclaw-reference-state");
  });

  it("contains no verifier instructions or probes in the Hero entrypoint", () => {
    const source = fs.readFileSync(
      new URL("./hero.ts", import.meta.url),
      "utf8",
    );
    for (const forbidden of [
      "Real Bander service ready",
      "Owner: send this natural request",
      "Imitated Bander approval",
      "synthetic:",
      "Fixture verifier",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
