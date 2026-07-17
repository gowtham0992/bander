import { spawn } from "node:child_process";
import fs from "node:fs";
import { reauthorizeGoogle } from "./local-recovery-lib.js";
if (fs.existsSync(".env")) process.loadEnvFile(".env");
const args = process.argv.slice(2);
if (args.length !== 1 || !["--calendar", "--gmail", "--all"].includes(args[0]!)) { process.stderr.write("Usage: npm run reauthorize:google -- --calendar|--gmail|--all\n"); process.exit(1); }
const services: Array<"calendar" | "gmail"> = args[0] === "--all" ? ["calendar", "gmail"] : [args[0]!.slice(2) as "calendar" | "gmail"];
const authorize = async (service: "calendar" | "gmail") => await new Promise<void>((resolve, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx", service === "calendar" ? "scripts/authorize-calendar.ts" : "scripts/authorize-gmail.ts"], { cwd: process.cwd(), stdio: "inherit", shell: false });
  child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${service} authorization did not complete`)));
});
try {
  await reauthorizeGoogle({ root: process.cwd(), environment: process.env, services, authorize });
  process.stdout.write("Selected repository-local token authorization is complete. OAuth client JSON was preserved. Cloud-side consent revocation remains manual.\n");
} catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "Google reauthorization failed"}\n`); process.exitCode = 1; }
