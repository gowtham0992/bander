import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRuntimeEnvironments } from "./process-env.js";

const realCredentialNames = [
  "OPENAI_API_KEY",
  "BANDER_TELEGRAM_BOT_TOKEN",
  "OPENCLAW_TELEGRAM_BOT_TOKEN",
  "GOOGLE_OAUTH_CLIENT_PATH",
  "GOOGLE_OAUTH_TOKEN_PATH",
  "BANDER_CALENDAR_TIME_ZONE",
] as const;

export function sourceForLocalMode(
  mode: "development" | "demo" | "real",
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const isolated: NodeJS.ProcessEnv = { ...source };
  if (mode === "demo") {
    for (const name of realCredentialNames) delete isolated[name];
  }
  return isolated;
}

export async function runLocal(
  mode: "development" | "demo" | "real",
): Promise<void> {
  if (fs.existsSync(".env")) process.loadEnvFile(".env");
  const runtimeMode = mode === "real" ? "real" : "sandbox";
  const environments = createRuntimeEnvironments(
    {
      ...sourceForLocalMode(mode, process.env),
      NODE_ENV: mode === "real" ? "production" : mode,
    },
    runtimeMode,
  );
  const children: ChildProcess[] = [];
  const criticalChildren: ChildProcess[] = [];
  let stopping = false;
  const launch = (workspace: string, script: string, env: NodeJS.ProcessEnv) => {
    const child = spawn("npm", ["run", script, "--workspace", workspace], {
      env,
      stdio: "inherit",
      shell: false,
    });
    children.push(child);
    return child;
  };

  if (runtimeMode === "sandbox") {
    criticalChildren.push(
      launch(
        "@bander/mock-services",
        mode === "development" ? "dev" : "start",
        environments["mock-services"],
      ),
    );
  }
  const broker = launch("@bander/broker", mode === "development" ? "dev" : "start", {
    ...environments.broker,
    BANDER_SERVE_WEB: mode === "demo" ? "1" : "0",
  });
  criticalChildren.push(broker);
  if (mode === "development") launch("@bander/web", "dev", environments.web);

  const stop = () => {
    stopping = true;
    for (const child of children) child.kill("SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await new Promise<void>((resolve, reject) => {
    for (const child of criticalChildren) {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        const expectedStop = stopping || signal === "SIGTERM" || signal === "SIGINT";
        stop();
        if (expectedStop) resolve();
        else reject(new Error(`A Bander process exited unexpectedly (${code ?? signal})`));
      });
    }
  });
}
