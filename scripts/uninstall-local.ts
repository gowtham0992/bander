import fs from "node:fs";
import readline from "node:readline/promises";
import { planLocalUninstall, runLocalUninstall } from "./local-recovery-lib.js";
if (fs.existsSync(".env")) process.loadEnvFile(".env");
const args = process.argv.slice(2);
if (args.some((value) => !["--confirm", "--yes", "--include-oauth-clients"].includes(value))) { process.stderr.write("Usage: npm run uninstall:local -- [--confirm|--yes] [--include-oauth-clients]\n"); process.exit(1); }
const includeOauthClients = args.includes("--include-oauth-clients");
const plan = planLocalUninstall({ root: process.cwd(), environment: process.env, includeOauthClients });
process.stdout.write(`Dry-run: ${plan.files.length} Bander-owned local state path(s) and ${plan.envKeys.length} unchanged setup-created .env key(s) would be removed. Source, unrelated files, ~/.openclaw, and OAuth clients are preserved by default.\n`);
let confirmed = args.includes("--yes") || args.includes("--confirm");
if (!confirmed && process.stdin.isTTY) { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); confirmed = (await rl.question("Type REMOVE LOCAL STATE to continue: ")) === "REMOVE LOCAL STATE"; rl.close(); }
if (!confirmed) { process.stdout.write("Nothing was removed.\n"); process.exit(0); }
const result = await runLocalUninstall({ root: process.cwd(), environment: process.env, confirmed: true, includeOauthClients });
process.stdout.write(result.alreadyClean ? "Local Bander state is already clean.\n" : `Removed ${result.removedFiles} manifest-owned path(s). Revoke Google consent and Telegram bots manually if desired.\n`);
