import { describe, expect, it } from "vitest";
import { createRealProductRuntime } from "./real-product-runtime.js";

const environment = {
  PATH: "/usr/bin",
  HOME: "/tmp/owner",
  OPENAI_API_KEY: "live-key",
  GOOGLE_OAUTH_CLIENT_PATH: ".bander/google-client.json",
  GOOGLE_OAUTH_TOKEN_PATH: ".bander/google-token.json",
  BANDER_CALENDAR_TIME_ZONE: "America/Denver",
  BANDER_TELEGRAM_BOT_TOKEN: "bander-token",
  OPENCLAW_TELEGRAM_BOT_TOKEN: "openclaw-token",
};

describe("canonical real-product runtime", () => {
  it("builds one live, bound, credential-isolated journey with no mock path", () => {
    const runtime = createRealProductRuntime({
      source: environment,
      installation: {
        id: "install-1",
        ownerTelegramId: "101",
        chatId: "-500",
        pairedAt: "2026-07-15T12:00:00.000Z",
      },
      gatewayToken: "gateway-token",
    });

    expect(runtime.config.agents.defaults.model.primary).toBe(
      "bander-openai/gpt-5.6-sol",
    );
    expect(runtime.config.models.providers).not.toHaveProperty("bander-mock");
    expect(runtime.config.tools.allow).toHaveLength(3);
    expect(runtime.config.mcp.servers.bander.toolFilter.include).toHaveLength(3);
    expect(runtime.brokerEnv).toMatchObject({ BANDER_RUNTIME_MODE: "real" });
    expect(runtime.brokerEnv).not.toHaveProperty("MOCK_SERVICE_URL");
    expect(runtime.openclawEnv).not.toHaveProperty("GOOGLE_OAUTH_CLIENT_PATH");
    expect(runtime.openclawEnv).not.toHaveProperty("GOOGLE_OAUTH_TOKEN_PATH");
    expect(runtime.openclawEnv).not.toHaveProperty("BANDER_TELEGRAM_BOT_TOKEN");
    expect(runtime.openclawEnv.TELEGRAM_BOT_TOKEN).toBe("openclaw-token");
  });

  it("fails closed without an active product Telegram binding", () => {
    expect(() =>
      createRealProductRuntime({
        source: environment,
        installation: undefined,
        gatewayToken: "gateway-token",
      }),
    ).toThrow("active Telegram owner/group binding");
  });
});
