import { describe, expect, it } from "vitest";
import { sourceForLocalMode } from "./run-local.js";

describe("local runtime source isolation", () => {
  it("demo_never_projects_real_credentials_even_when_env_exists", () => {
    const result = sourceForLocalMode("demo", {
      OPENAI_API_KEY: "OPENAI_TEST_SECRET",
      BANDER_TELEGRAM_BOT_TOKEN: "BANDER_TELEGRAM_TEST_SECRET",
      OPENCLAW_TELEGRAM_BOT_TOKEN: "OPENCLAW_TELEGRAM_TEST_SECRET",
      GOOGLE_OAUTH_CLIENT_PATH: "/private/client.json",
      GOOGLE_OAUTH_TOKEN_PATH: "/private/token.json",
      BANDER_CALENDAR_TIME_ZONE: "America/Denver",
      PATH: "/bin",
    });
    expect(result).toMatchObject({ PATH: "/bin" });
    expect(result.OPENAI_API_KEY).toBeUndefined();
    expect(result.BANDER_TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(result.OPENCLAW_TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(result.GOOGLE_OAUTH_CLIENT_PATH).toBeUndefined();
    expect(result.GOOGLE_OAUTH_TOKEN_PATH).toBeUndefined();
    expect(result.BANDER_CALENDAR_TIME_ZONE).toBeUndefined();
  });
});
