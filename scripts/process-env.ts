import { randomBytes } from "node:crypto";
import path from "node:path";

type Role = "mock-services" | "broker" | "web" | "openclaw";

const sandboxAgentAllowlist = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

export function createRuntimeEnvironments(
  source = process.env,
  runtimeMode: "sandbox" | "real" = "sandbox",
): Record<Role, NodeJS.ProcessEnv> {
  const serviceToken = randomBytes(32).toString("hex");
  const common: NodeJS.ProcessEnv = {
    PATH: source.PATH,
    HOME: source.HOME,
    USER: source.USER,
    SHELL: source.SHELL,
    TMPDIR: source.TMPDIR,
    NODE_ENV: source.NODE_ENV ?? "development",
  };
  const openclaw: NodeJS.ProcessEnv = {};
  const agentAllowlist =
    runtimeMode === "real"
      ? (["PATH", "HOME", "USER", "SHELL", "TMPDIR", "OPENAI_API_KEY"] as const)
      : sandboxAgentAllowlist;
  for (const key of agentAllowlist) {
    if (source[key] !== undefined) openclaw[key] = source[key];
  }
  openclaw.HOME = path.resolve(".bander/openclaw-home");
  openclaw.BANDER_MCP_URL = "http://localhost:4310/mcp";
  openclaw.OPENCLAW_STATE_DIR = path.resolve(".bander/openclaw-reference-state");
  openclaw.OPENCLAW_CONFIG_PATH = path.resolve(
    runtimeMode === "real"
      ? "openclaw/real-product.openclaw.json"
      : "openclaw/reference.openclaw.json",
  );
  if (source.OPENCLAW_TELEGRAM_BOT_TOKEN) {
    openclaw.TELEGRAM_BOT_TOKEN = source.OPENCLAW_TELEGRAM_BOT_TOKEN;
  }

  return {
    "mock-services": {
      ...common,
      MOCK_SERVICE_TOKEN: serviceToken,
      MOCK_SERVICE_PORT: source.MOCK_SERVICE_PORT ?? "4311",
    },
    broker: {
      ...common,
      BANDER_RUNTIME_MODE: runtimeMode,
      BANDER_PORT: source.BANDER_PORT ?? "4310",
      OPENAI_API_KEY: source.OPENAI_API_KEY,
      BANDER_TELEGRAM_BOT_TOKEN: source.BANDER_TELEGRAM_BOT_TOKEN,
      ...(runtimeMode === "real"
        ? {
            GOOGLE_OAUTH_CLIENT_PATH: source.GOOGLE_OAUTH_CLIENT_PATH
              ? path.resolve(source.GOOGLE_OAUTH_CLIENT_PATH)
              : undefined,
            GOOGLE_OAUTH_TOKEN_PATH: source.GOOGLE_OAUTH_TOKEN_PATH
              ? path.resolve(source.GOOGLE_OAUTH_TOKEN_PATH)
              : undefined,
            BANDER_CALENDAR_TIME_ZONE: source.BANDER_CALENDAR_TIME_ZONE,
          }
        : {
            MOCK_SERVICE_TOKEN: serviceToken,
            MOCK_SERVICE_URL: `http://127.0.0.1:${source.MOCK_SERVICE_PORT ?? "4311"}`,
          }),
      BANDER_TELEGRAM_STATE_PATH:
        source.BANDER_TELEGRAM_STATE_PATH ??
        path.resolve(
          runtimeMode === "real"
            ? ".bander/real/telegram-service/state.json"
            : ".bander/telegram-service/state.json",
        ),
      BANDER_TELEGRAM_PAIRING_PATH:
        source.BANDER_TELEGRAM_PAIRING_PATH ??
        path.resolve(
          runtimeMode === "real"
            ? ".bander/real/telegram-service/pairing-link.txt"
            : ".bander/telegram-service/pairing-link.txt",
        ),
    },
    web: {
      ...common,
      WEB_PORT: source.WEB_PORT ?? "4312",
    },
    openclaw,
  };
}
