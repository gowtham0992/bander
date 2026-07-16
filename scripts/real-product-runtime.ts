import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { TelegramInstallation } from "../apps/broker/src/telegram-service.js";
import {
  applyPinnedTelegramPolicy,
  assertPinnedTelegramPolicy,
  BANDER_REAL_OPENCLAW_TOOLS,
} from "./openclaw-telegram-config.js";
import { createRuntimeEnvironments } from "./process-env.js";

export interface RealProductRuntime {
  brokerEnv: NodeJS.ProcessEnv;
  openclawEnv: NodeJS.ProcessEnv;
  config: Record<string, any>;
  paths: {
    root: string;
    config: string;
    state: string;
    home: string;
    workspace: string;
    gatewayLog: string;
  };
}

export function createRealProductRuntime(input: {
  source: NodeJS.ProcessEnv | Record<string, string | undefined>;
  installation: TelegramInstallation | undefined;
  gatewayToken: string;
}): RealProductRuntime {
  if (!input.installation) {
    throw new Error("Real product mode requires an active Telegram owner/group binding");
  }
  const environments = createRuntimeEnvironments(input.source, "real");
  const root = path.resolve(".bander/real/product");
  const paths = {
    root,
    config: path.join(root, "openclaw.json"),
    state: path.join(root, "openclaw-state"),
    home: path.join(root, "openclaw-home"),
    workspace: path.join(root, "workspace"),
    gatewayLog: path.join(root, "openclaw-gateway.log"),
  };
  const base = JSON.parse(
    fs.readFileSync("openclaw/real-product.openclaw.json", "utf8"),
  ) as Record<string, any>;
  base.agents.defaults.workspace = paths.workspace;
  base.mcp.servers.bander.url = "http://127.0.0.1:4310/mcp";
  base.gateway = { mode: "local", bind: "loopback" };
  const config = applyPinnedTelegramPolicy(base, input.installation);
  assertPinnedTelegramPolicy(config, input.installation);
  assert.equal(config.agents.defaults.model.primary, "bander-openai/gpt-5.6-sol");
  assert.equal(config.models.providers["bander-mock"], undefined);
  assert.deepEqual(
    [...config.tools.allow].sort(),
    [...BANDER_REAL_OPENCLAW_TOOLS].sort(),
  );

  const openclawEnv: NodeJS.ProcessEnv = {
    ...environments.openclaw,
    HOME: paths.home,
    OPENCLAW_STATE_DIR: paths.state,
    OPENCLAW_CONFIG_PATH: paths.config,
    OPENCLAW_GATEWAY_TOKEN: input.gatewayToken,
  };
  assert.ok(openclawEnv.OPENAI_API_KEY, "OPENAI_API_KEY is required in real product mode");
  assert.ok(openclawEnv.TELEGRAM_BOT_TOKEN, "OPENCLAW_TELEGRAM_BOT_TOKEN is required in real product mode");
  for (const forbidden of [
    "GOOGLE_OAUTH_CLIENT_PATH",
    "GOOGLE_OAUTH_TOKEN_PATH",
    "BANDER_TELEGRAM_BOT_TOKEN",
    "MOCK_SERVICE_TOKEN",
    "MOCK_SERVICE_URL",
  ]) {
    assert.equal(openclawEnv[forbidden], undefined, `${forbidden} crossed into OpenClaw`);
  }
  assert.equal(environments.broker.BANDER_RUNTIME_MODE, "real");
  assert.equal(environments.broker.MOCK_SERVICE_TOKEN, undefined);
  assert.equal(environments.broker.MOCK_SERVICE_URL, undefined);
  return { brokerEnv: environments.broker, openclawEnv, config, paths };
}
