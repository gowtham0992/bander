import { describe, expect, it } from "vitest";
import { parseRuntimeConfiguration } from "./runtime-config.js";

const realEnvironment = {
  BANDER_RUNTIME_MODE: "real",
  OPENAI_API_KEY: "local-test-openai-key",
  GOOGLE_OAUTH_CLIENT_PATH: ".bander/google-oauth-client.json",
  GOOGLE_OAUTH_TOKEN_PATH: ".bander/google-oauth-token.json",
  GMAIL_OAUTH_CLIENT_PATH: ".bander/gmail-oauth-client.json",
  GMAIL_OAUTH_TOKEN_PATH: ".bander/gmail-oauth-token.json",
  BANDER_GMAIL_LIVE_EVIDENCE_DROP_RESPONSE: "1",
  BANDER_CALENDAR_TIME_ZONE: "America/Denver",
  BANDER_TELEGRAM_BOT_TOKEN: "local-test-telegram-token",
};

describe("runtime mode isolation", () => {
  it("keeps the existing sandbox as the default", () => {
    expect(
      parseRuntimeConfiguration({ MOCK_SERVICE_TOKEN: "mock-token" }),
    ).toMatchObject({ mode: "sandbox", mockServiceToken: "mock-token" });
  });

  it("builds the real Calendar-and-Gmail configuration without mock credentials", () => {
    expect(parseRuntimeConfiguration(realEnvironment)).toEqual({
      mode: "real",
      openaiApiKey: "local-test-openai-key",
      googleClientPath: ".bander/google-oauth-client.json",
      googleTokenPath: ".bander/google-oauth-token.json",
      gmailClientPath: ".bander/gmail-oauth-client.json",
      gmailTokenPath: ".bander/gmail-oauth-token.json",
      gmailDropSuccessfulResponseForEvidence: true,
      calendarTimeZone: "America/Denver",
      telegramToken: "local-test-telegram-token",
      telegramStatePath: ".bander/real/telegram-service/state.json",
      telegramPairingPath: ".bander/real/telegram-service/pairing-link.txt",
      familyContactPairingPath:
        ".bander/real/telegram-service/family-contact-link.txt",
    });
  });

  it("keeps a custom family pairing link path inside real runtime configuration", () => {
    expect(
      parseRuntimeConfiguration({
        ...realEnvironment,
        BANDER_FAMILY_PAIRING_PATH: ".private/family-link.txt",
      }),
    ).toMatchObject({
      familyContactPairingPath: ".private/family-link.txt",
    });
  });

  it.each([
    "OPENAI_API_KEY",
    "GOOGLE_OAUTH_CLIENT_PATH",
    "GOOGLE_OAUTH_TOKEN_PATH",
    "GMAIL_OAUTH_CLIENT_PATH",
    "GMAIL_OAUTH_TOKEN_PATH",
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

  it("requires a separate Gmail token file", () => {
    expect(() => parseRuntimeConfiguration({
      ...realEnvironment,
      GMAIL_OAUTH_TOKEN_PATH: realEnvironment.GOOGLE_OAUTH_TOKEN_PATH,
    })).toThrow("token paths must be different");
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
