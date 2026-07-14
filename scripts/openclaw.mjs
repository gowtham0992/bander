import path from "node:path";
import { spawn } from "node:child_process";
import { createRuntimeEnvironments } from "./process-env.ts";

const node = path.resolve("node_modules/node/bin/node");
const openclaw = path.resolve("node_modules/openclaw/openclaw.mjs");
const child = spawn(node, [openclaw, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: createRuntimeEnvironments().openclaw,
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`OpenClaw exited after ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
