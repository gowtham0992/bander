import { describe, expect, it } from "vitest";
import { createRuntimeEnvironments } from "./process-env.js";

describe("canonical process credential projection", () => {
  it("does not place downstream credentials in the OpenClaw environment", () => {
    const environments = createRuntimeEnvironments({
      PATH: "/usr/bin",
      HOME: "/tmp/demo-owner",
      OPENAI_API_KEY: "model-provider-key-is-allowed",
      CALENDAR_API_KEY: "must-not-cross-boundary",
      MESSAGES_API_KEY: "must-not-cross-boundary",
      MOCK_SERVICE_TOKEN: "must-not-cross-boundary",
      BANDER_TELEGRAM_BOT_TOKEN: "bander-only-token",
      OPENCLAW_TELEGRAM_BOT_TOKEN: "openclaw-only-token",
    });

    expect(environments.openclaw).toMatchObject({
      PATH: "/usr/bin",
      OPENAI_API_KEY: "model-provider-key-is-allowed",
      BANDER_MCP_URL: "http://localhost:4310/mcp",
    });
    expect(environments.openclaw.HOME).toMatch(/\.bander\/openclaw-home$/);
    expect(environments.openclaw.OPENCLAW_STATE_DIR).toMatch(
      /\.bander\/openclaw-reference-state$/,
    );
    expect(environments.openclaw.OPENCLAW_CONFIG_PATH).toMatch(
      /openclaw\/reference\.openclaw\.json$/,
    );
    expect(environments.openclaw).not.toHaveProperty("CALENDAR_API_KEY");
    expect(environments.openclaw).not.toHaveProperty("MESSAGES_API_KEY");
    expect(environments.openclaw).not.toHaveProperty("MOCK_SERVICE_TOKEN");
    expect(environments.openclaw).not.toHaveProperty("BANDER_TELEGRAM_BOT_TOKEN");
    expect(environments.openclaw.TELEGRAM_BOT_TOKEN).toBe("openclaw-only-token");
    expect(environments.broker.BANDER_TELEGRAM_BOT_TOKEN).toBe(
      "bander-only-token",
    );
    expect(environments.broker).not.toHaveProperty("OPENCLAW_TELEGRAM_BOT_TOKEN");
    expect(environments.broker).not.toHaveProperty("TELEGRAM_BOT_TOKEN");
    expect(environments.broker.MOCK_SERVICE_TOKEN).toHaveLength(64);
  });
});
