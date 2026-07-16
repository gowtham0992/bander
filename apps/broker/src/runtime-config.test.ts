import { describe, expect, it } from "vitest";
import { parseRuntimeConfiguration } from "./runtime-config.js";

const realEnvironment = {
  BANDER_RUNTIME_MODE: "real",
  OPENAI_API_KEY: "local-test-openai-key",
  GOOGLE_OAUTH_CLIENT_PATH: ".bander/google-oauth-client.json",
  GOOGLE_OAUTH_TOKEN_PATH: ".bander/google-oauth-token.json",
  BANDER_CALENDAR_TIME_ZONE: "America/Denver",
  BANDER_TELEGRAM_BOT_TOKEN: "local-test-telegram-token",
};

describe("runtime mode isolation", () => {
  it("keeps the existing sandbox as the default", () => {
    expect(
      parseRuntimeConfiguration({ MOCK_SERVICE_TOKEN: "mock-token" }),
    ).toMatchObject({ mode: "sandbox", mockServiceToken: "mock-token" });
  });

  it("builds a Calendar-only real configuration without mock credentials", () => {
    expect(parseRuntimeConfiguration(realEnvironment)).toEqual({
      mode: "real",
      openaiApiKey: "local-test-openai-key",
      googleClientPath: ".bander/google-oauth-client.json",
      googleTokenPath: ".bander/google-oauth-token.json",
      calendarTimeZone: "America/Denver",
      telegramToken: "local-test-telegram-token",
      telegramStatePath: ".bander/real/telegram-service/state.json",
      telegramPairingPath: ".bander/real/telegram-service/pairing-link.txt",
    });
  });

  it.each([
    "OPENAI_API_KEY",
    "GOOGLE_OAUTH_CLIENT_PATH",
    "GOOGLE_OAUTH_TOKEN_PATH",
    "BANDER_CALENDAR_TIME_ZONE",
    "BANDER_TELEGRAM_BOT_TOKEN",
  ])("fails real mode closed when %s is missing", (key) => {
    const environment = { ...realEnvironment };
    delete environment[key as keyof typeof environment];

    expect(() => parseRuntimeConfiguration(environment)).toThrow(
      `${key} is required in real mode`,
    );
  });

  it("rejects mock-service configuration in real mode", () => {
    expect(() =>
      parseRuntimeConfiguration({
        ...realEnvironment,
        MOCK_SERVICE_TOKEN: "must-not-be-present",
      }),
    ).toThrow("Real mode cannot include mock-service configuration");
  });

  it("rejects unknown runtime modes", () => {
    expect(() =>
      parseRuntimeConfiguration({
        BANDER_RUNTIME_MODE: "hybrid",
        MOCK_SERVICE_TOKEN: "mock-token",
      }),
    ).toThrow("BANDER_RUNTIME_MODE must be sandbox or real");
  });
});
