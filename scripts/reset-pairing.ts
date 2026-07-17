import fs from "node:fs";
import net from "node:net";
import { resetPairing } from "./local-recovery-lib.js";
if (fs.existsSync(".env")) process.loadEnvFile(".env");
const args = process.argv.slice(2);
if (args.some((value) => value !== "--include-family")) { process.stderr.write("Usage: npm run reset:pairing -- [--include-family]\n"); process.exit(1); }
const port = Number(process.env.BANDER_PORT ?? 4310);
const stopped = () => new Promise<boolean>((resolve) => { const socket = net.connect(port, "127.0.0.1"); socket.once("connect", () => { socket.destroy(); resolve(false); }); socket.once("error", () => resolve(true)); });
try {
  const result = await resetPairing({ root: process.cwd(), environment: process.env, includeFamily: args.includes("--include-family"), productStopped: stopped });
  process.stdout.write(result.familyRevoked ? "Family contact was detached, then owner/group pairing was removed. Bot credentials were preserved.\n" : "Owner/group pairing was removed. Bot credentials and family state were unchanged.\n");
} catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "Pairing reset failed"}\n`); process.exitCode = 1; }
