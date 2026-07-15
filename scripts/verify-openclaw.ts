import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createRuntimeEnvironments } from "./process-env.js";
import {
  buildOpenClawMockProvider,
  type MockProviderEvidence,
} from "./openclaw-mock-provider.js";

const expectedTools = [
  "bander__get_receipt",
  "bander__list_capabilities",
  "bander__propose_action",
];
const forbiddenTools = new Set([
  "exec",
  "process",
  "browser",
  "web_fetch",
  "web_search",
  "message",
]);
const humanRequest =
  "Move dinner with Sarah to 7:30 and tell her I’ll be 20 minutes late.";

function sameTools(actual: string[]): boolean {
  return (
    actual.length === expectedTools.length &&
    [...actual].sort().every((name, index) => name === expectedTools[index])
  );
}

async function waitFor(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The local process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function start(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { child: ChildProcess; logs: () => string } {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });
  return { child, logs: () => output };
}

async function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`OpenClaw exited ${code}: ${stderr || stdout}`));
    });
  });
}

const verificationSource: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "test",
};
delete verificationSource.BANDER_TELEGRAM_BOT_TOKEN;
delete verificationSource.OPENCLAW_TELEGRAM_BOT_TOKEN;
delete verificationSource.TELEGRAM_BOT_TOKEN;
const environments = createRuntimeEnvironments(verificationSource);
const provider = buildOpenClawMockProvider();
const children: Array<{ child: ChildProcess; logs: () => string }> = [];

try {
  await provider.app.listen({ host: "127.0.0.1", port: 4313 });
  children.push(
    start(
      "npm",
      ["run", "start", "--workspace", "@bander/mock-services"],
      environments["mock-services"],
    ),
    start(
      "npm",
      ["run", "start", "--workspace", "@bander/broker"],
      environments.broker,
    ),
  );
  await Promise.all([
    waitFor("http://127.0.0.1:4311/health"),
    waitFor("http://127.0.0.1:4310/api/status"),
  ]);

  const sessionId = `bander-reference-${Date.now()}`;
  const node = path.resolve("node_modules/node/bin/node");
  const openclaw = path.resolve("node_modules/openclaw/openclaw.mjs");
  const result = await run(
    node,
    [
      openclaw,
      "agent",
      "--local",
      "--session-id",
      sessionId,
      "--message",
      humanRequest,
      "--thinking",
      "off",
      "--json",
      "--timeout",
      "60",
    ],
    environments.openclaw,
  );
  const parsed = JSON.parse(result.stdout) as {
    meta?: {
      systemPromptReport?: { tools?: { entries?: Array<{ name: string }> } };
      toolSummary?: { calls?: number; tools?: string[]; failures?: number };
    };
  };
  const effectiveTools =
    parsed.meta?.systemPromptReport?.tools?.entries?.map((entry) => entry.name) ?? [];
  if (!sameTools(effectiveTools)) {
    throw new Error(`Unexpected effective tools: ${effectiveTools.join(", ")}`);
  }
  if (effectiveTools.some((name) => forbiddenTools.has(name))) {
    throw new Error("A forbidden direct-action tool reached the OpenClaw session");
  }
  if (!result.stderr.includes("tool policy removed")) {
    throw new Error("OpenClaw did not emit its tool-policy removal audit");
  }

  const evidence = provider.evidence as MockProviderEvidence;
  if (!evidence.sawHumanRequest || evidence.calls !== 2) {
    throw new Error("The deterministic provider did not observe the full agent turn");
  }
  if (!evidence.toolInventories.every(sameTools)) {
    throw new Error("The model provider observed an unexpected effective tool inventory");
  }
  if (!evidence.toolResult) throw new Error("OpenClaw did not call Bander");
  const proposalStatus = JSON.parse(evidence.toolResult) as {
    draftId: string;
    status: string;
  };
  const agentReceiptResponse = await fetch(
    `http://127.0.0.1:4310/api/agent/drafts/${encodeURIComponent(proposalStatus.draftId)}/receipt`,
  );
  const agentReceipt = (await agentReceiptResponse.json()) as { status?: string };
  if (
    proposalStatus.status !== "proposed" ||
    agentReceipt.status !== "proposed" ||
    "title" in proposalStatus ||
    "claimedUserRequest" in proposalStatus
  ) {
    throw new Error("The OpenClaw proposal crossed the human approval boundary");
  }

  const unsupportedResult = await run(
    node,
    [
      openclaw,
      "agent",
      "--local",
      "--session-id",
      `bander-unsupported-${Date.now()}`,
      "--message",
      "Book me a flight to Tokyo tomorrow.",
      "--thinking",
      "off",
      "--json",
      "--timeout",
      "60",
    ],
    environments.openclaw,
  );
  if (!unsupportedResult.stdout.includes("not sure how to prepare that safely")) {
    throw new Error("OpenClaw did not return the friendly unsupported-request response");
  }

  console.log(
    JSON.stringify(
      {
        humanRequestObserved: true,
        effectiveTools,
        toolPolicyAudit: "removed all non-allowlisted tools",
        toolCalls: parsed.meta?.toolSummary,
        draftId: proposalStatus.draftId,
        draftStatus: agentReceipt.status,
        execution: "not_started",
        unsupportedRequest: "friendly clarification returned without authority",
      },
      null,
      2,
    ),
  );
} catch (error) {
  const processLogs = children.map((child) => child.logs()).filter(Boolean).join("\n");
  if (processLogs) console.error(processLogs);
  throw error;
} finally {
  for (const { child } of children) child.kill("SIGTERM");
  await provider.app.close();
}
