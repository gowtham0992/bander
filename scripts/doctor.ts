import fs from "node:fs";
import {
  collectDoctorReport,
  formatDoctorJson,
  formatDoctorTable,
  parseDoctorArguments,
} from "./doctor-lib.js";

async function main(): Promise<void> {
  let flags: { live: boolean; json: boolean };
  try {
    flags = parseDoctorArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Doctor arguments are invalid."}\n`);
    process.exitCode = 1;
    return;
  }
  if (fs.existsSync(".env")) process.loadEnvFile(".env");
  try {
    const report = await collectDoctorReport({
      cwd: process.cwd(),
      environment: process.env,
      live: flags.live,
    });
    process.stdout.write(`${flags.json ? formatDoctorJson(report) : formatDoctorTable(report)}\n`);
  } catch {
    process.stderr.write("Bander doctor could not complete its read-only checks. Rerun from the repository root.\n");
    process.exitCode = 1;
  }
}

await main();
