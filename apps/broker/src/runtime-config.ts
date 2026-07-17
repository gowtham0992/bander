export type BanderRuntimeConfiguration =
  | {
      mode: "sandbox";
      mockServiceToken: string;
      mockServiceUrl: string;
      openaiApiKey?: string;
      telegramToken?: string;
      telegramStatePath: string;
      telegramPairingPath: string;
    }
  | {
      mode: "real";
      openaiApiKey: string;
      googleClientPath: string;
      googleTokenPath: string;
      gmailClientPath: string;
      gmailTokenPath: string;
      gmailDropSuccessfulResponseForEvidence: boolean;
      calendarTimeZone: string;
      telegramToken: string;
      telegramStatePath: string;
      telegramPairingPath: string;
      familyContactPairingPath: string;
    };

function required(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
  name: string,
  mode: "sandbox" | "real",
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required in ${mode} mode`);
  return value;
}

export function parseRuntimeConfiguration(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): BanderRuntimeConfiguration {
  const rawMode = environment.BANDER_RUNTIME_MODE?.trim() || "sandbox";
  if (rawMode !== "sandbox" && rawMode !== "real") {
    throw new Error("BANDER_RUNTIME_MODE must be sandbox or real");
  }
  if (rawMode === "real") {
    if (
      environment.MOCK_SERVICE_TOKEN?.trim() ||
      environment.MOCK_SERVICE_URL?.trim()
    ) {
      throw new Error("Real mode cannot include mock-service configuration");
    }
    const googleTokenPath = required(environment, "GOOGLE_OAUTH_TOKEN_PATH", "real");
    const gmailTokenPath = required(environment, "GMAIL_OAUTH_TOKEN_PATH", "real");
    if (path.resolve(googleTokenPath) === path.resolve(gmailTokenPath)) {
      throw new Error("Calendar and Gmail OAuth token paths must be different");
    }
    return {
      mode: "real",
      openaiApiKey: required(environment, "OPENAI_API_KEY", "real"),
      googleClientPath: required(
        environment,
        "GOOGLE_OAUTH_CLIENT_PATH",
        "real",
      ),
      googleTokenPath,
      gmailClientPath: required(environment, "GMAIL_OAUTH_CLIENT_PATH", "real"),
      gmailTokenPath,
      gmailDropSuccessfulResponseForEvidence:
        environment.BANDER_GMAIL_LIVE_EVIDENCE_DROP_RESPONSE === "1",
      calendarTimeZone: required(
        environment,
        "BANDER_CALENDAR_TIME_ZONE",
        "real",
      ),
      telegramToken: required(
        environment,
        "BANDER_TELEGRAM_BOT_TOKEN",
        "real",
      ),
      telegramStatePath:
        environment.BANDER_TELEGRAM_STATE_PATH?.trim() ||
        ".bander/real/telegram-service/state.json",
      telegramPairingPath:
        environment.BANDER_TELEGRAM_PAIRING_PATH?.trim() ||
        ".bander/real/telegram-service/pairing-link.txt",
      familyContactPairingPath:
        environment.BANDER_FAMILY_PAIRING_PATH?.trim() ||
        ".bander/real/telegram-service/family-contact-link.txt",
    };
  }

  const openaiApiKey = environment.OPENAI_API_KEY?.trim();
  const telegramToken = environment.BANDER_TELEGRAM_BOT_TOKEN?.trim();
  return {
    mode: "sandbox",
    mockServiceToken: required(environment, "MOCK_SERVICE_TOKEN", "sandbox"),
    mockServiceUrl:
      environment.MOCK_SERVICE_URL?.trim() || "http://127.0.0.1:4311",
    ...(openaiApiKey ? { openaiApiKey } : {}),
    ...(telegramToken ? { telegramToken } : {}),
    telegramStatePath:
      environment.BANDER_TELEGRAM_STATE_PATH?.trim() ||
      ".bander/telegram-service/state.json",
    telegramPairingPath:
      environment.BANDER_TELEGRAM_PAIRING_PATH?.trim() ||
      ".bander/telegram-service/pairing-link.txt",
  };
}
import path from "node:path";
