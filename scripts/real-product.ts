import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { TelegramServiceState } from "../apps/broker/src/telegram-service.js";
import { BANDER_REAL_OPENCLAW_TOOLS } from "./openclaw-telegram-config.js";
import { createRealProductRuntime } from "./real-product-runtime.js";

function loadEnvironment(): void {
  if (fs.existsSync(".env")) process.loadEnvFile(".env");
}

function readInstallation(statePath: string) {
  if (!fs.existsSync(statePath)) return undefined;
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as TelegramServiceState;
  return state.installation;
}

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not reserve an OpenClaw gateway port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForBroker(url: string, child: ChildProcess): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("The real Bander broker stopped during startup");
    try {
      const response = await fetch(`${url}/api/status`);
      if (response.ok) return (await response.json()) as Record<string, unknown>;
    } catch {
      // The supervised broker is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the real Bander broker");
}

async function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(), env, shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`OpenClaw validation failed (${code}): ${stderr.slice(-800)}`));
    });
  });
}

async function assertExactRealMcpTools(brokerUrl: string): Promise<void> {
  const client = new Client({ name: "bander-real-startup", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${brokerUrl}/mcp`));
  try {
    await client.connect(transport as Parameters<Client["connect"]>[0]);
    const tools = (await client.listTools()).tools.map((tool) => `bander__${tool.name}`).sort();
    assert.deepEqual(tools, [...BANDER_REAL_OPENCLAW_TOOLS].sort());
  } finally {
    await client.close();
  }
}

async function assertNoExistingBroker(brokerUrl: string): Promise<void> {
  try {
    const response = await fetch(`${brokerUrl}/api/status`, { signal: AbortSignal.timeout(500) });
    if (response.ok) {
      throw new Error(
        `Another Bander process is already using ${brokerUrl}. Stop it before starting the canonical real product.`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Another Bander")) throw error;
  }
}

export async function runRealProduct(): Promise<void> {
  loadEnvironment();
  const brokerPort = Number.parseInt(process.env.BANDER_PORT ?? "4310", 10);
  if (!Number.isInteger(brokerPort) || brokerPort < 1 || brokerPort > 65535) {
    throw new Error("BANDER_PORT must be a valid TCP port");
  }
  const brokerUrl = `http://127.0.0.1:${brokerPort}`;
  await assertNoExistingBroker(brokerUrl);
  const statePath = path.resolve(
    process.env.BANDER_TELEGRAM_STATE_PATH ?? ".bander/real/telegram-service/state.json",
  );
  const runtime = createRealProductRuntime({
    source: process.env,
    installation: readInstallation(statePath),
    gatewayToken: randomBytes(32).toString("hex"),
  });
  runtime.config.mcp.servers.bander.url = `${brokerUrl}/mcp`;
  for (const directory of [
    runtime.paths.root,
    runtime.paths.state,
    runtime.paths.home,
    runtime.paths.workspace,
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(runtime.paths.config, `${JSON.stringify(runtime.config, null, 2)}\n`, {
    mode: 0o600,
  });

  const node = path.resolve("node_modules/node/bin/node");
  const openclaw = path.resolve("node_modules/openclaw/openclaw.mjs");
  const validation = JSON.parse(
    await runCommand(node, [openclaw, "config", "validate", "--json"], runtime.openclawEnv),
  ) as { valid?: boolean };
  assert.equal(validation.valid, true, "OpenClaw rejected the real product configuration");

  const children: ChildProcess[] = [];
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const broker = spawn("npm", ["run", "start", "--workspace", "@bander/broker"], {
    cwd: process.cwd(), env: runtime.brokerEnv, shell: false, stdio: "inherit",
  });
  children.push(broker);
  try {
    const status = await waitForBroker(brokerUrl, broker);
    assert.deepEqual(status, {
      product: "Bander",
      status: "ready",
      runtimeMode: "real",
      fixtureMode: false,
      calendarBackend: "google",
      compilerKind: "real_calendar",
      modelCompiler: "available",
      scheduleRead: "available",
      heroMode: false,
    });
    const fixtureResponse = await fetch(`${brokerUrl}/api/demo/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fixtureId: "must-not-exist-in-real-mode" }),
    });
    assert.equal(fixtureResponse.status, 404, "/api/demo/proposals leaked into real mode");
    const standingResponse = await fetch(`${brokerUrl}/api/demo/standing-band-candidates`, {
      method: "POST",
    });
    assert.equal(
      standingResponse.status,
      404,
      "/api/demo/standing-band-candidates leaked into real mode",
    );
    await assertExactRealMcpTools(brokerUrl);

    const gatewayPort = await reservePort();
    const gatewayLog = fs.createWriteStream(runtime.paths.gatewayLog, { flags: "w", mode: 0o600 });
    const gateway = spawn(
      node,
      [openclaw, "gateway", "run", "--port", String(gatewayPort), "--bind", "loopback", "--auth", "token", "--compact"],
      { cwd: process.cwd(), env: runtime.openclawEnv, shell: false, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(gateway);
    gateway.stdout?.pipe(gatewayLog);
    gateway.stderr?.pipe(gatewayLog);
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    if (gateway.exitCode !== null) {
      throw new Error(`OpenClaw stopped during startup. See ${runtime.paths.gatewayLog}`);
    }
    const startupLog = fs.readFileSync(runtime.paths.gatewayLog, "utf8");
    assert.match(
      startupLog,
      /agent model: bander-openai\/gpt-5\.6-sol/,
      "The supervised gateway did not start the live product model",
    );
    assert.doesNotMatch(startupLog, /bander-mock/);
    assert.doesNotMatch(
      startupLog,
      /409 Conflict|terminated by other getUpdates|another getUpdates request/i,
      "Another Telegram gateway is already polling the OpenClaw bot",
    );
    console.log("Bander real product is ready.");
    console.log("Telegram → live OpenClaw → four bounded Bander tools → real Google Calendar");
    console.log(`OpenClaw gateway log: ${runtime.paths.gatewayLog}`);

    await new Promise<void>((resolve, reject) => {
      for (const child of children) {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (stopping || signal === "SIGTERM" || signal === "SIGINT") resolve();
          else reject(new Error(`A real-product process exited unexpectedly (${code ?? signal})`));
        });
      }
    });
  } finally {
    stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRealProduct().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
