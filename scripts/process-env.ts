import { randomBytes } from "node:crypto";
import path from "node:path";

type Role = "mock-services" | "broker" | "web" | "openclaw";

const agentAllowlist = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

export function createRuntimeEnvironments(source = process.env): Record<Role, NodeJS.ProcessEnv> {
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
  for (const key of agentAllowlist) {
    if (source[key] !== undefined) openclaw[key] = source[key];
  }
  openclaw.HOME = path.resolve(".bander/openclaw-home");
  openclaw.BANDER_MCP_URL = "http://localhost:4310/mcp";
  openclaw.OPENCLAW_STATE_DIR = path.resolve(".bander/openclaw-reference-state");
  openclaw.OPENCLAW_CONFIG_PATH = path.resolve("openclaw/reference.openclaw.json");
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
      MOCK_SERVICE_TOKEN: serviceToken,
      MOCK_SERVICE_URL: `http://127.0.0.1:${source.MOCK_SERVICE_PORT ?? "4311"}`,
      BANDER_PORT: source.BANDER_PORT ?? "4310",
      OPENAI_API_KEY: source.OPENAI_API_KEY,
      BANDER_TELEGRAM_BOT_TOKEN: source.BANDER_TELEGRAM_BOT_TOKEN,
      BANDER_TELEGRAM_STATE_PATH:
        source.BANDER_TELEGRAM_STATE_PATH ??
        path.resolve(".bander/telegram-service/state.json"),
      BANDER_TELEGRAM_PAIRING_PATH:
        source.BANDER_TELEGRAM_PAIRING_PATH ??
        path.resolve(".bander/telegram-service/pairing-link.txt"),
    },
    web: {
      ...common,
      WEB_PORT: source.WEB_PORT ?? "4312",
    },
    openclaw,
  };
}
