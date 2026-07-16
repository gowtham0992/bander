import fs from "node:fs";
import path from "node:path";
import {
  AuthorityEngine,
  AuthorityStore,
  type ExecutionAdapter,
} from "@bander/core";
import {
  FileTelegramServiceStore,
  TelegramHttpApi,
  TelegramService,
} from "../apps/broker/src/telegram-service.js";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

function parseArguments(args: readonly string[]): {
  displayLabel: string;
  aliases: string[];
} {
  let displayLabel: string | undefined;
  const aliases: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if ((argument === "--name" || argument === "--alias") && value) {
      if (argument === "--name") {
        if (displayLabel !== undefined) throw new Error("--name may be provided once");
        displayLabel = value;
      } else {
        aliases.push(value);
      }
      index += 1;
      continue;
    }
    throw new Error(
      "Usage: npm run pair:family -- --name Gil --alias \"my son\" --alias son",
    );
  }
  if (!displayLabel || aliases.length === 0) {
    throw new Error(
      "Usage: npm run pair:family -- --name Gil --alias \"my son\" --alias son",
    );
  }
  return { displayLabel, aliases };
}

async function assertProductStopped(): Promise<void> {
  const port = process.env.BANDER_PORT?.trim() || "4310";
  try {
    await fetch(`http://127.0.0.1:${port}/api/status`, {
      signal: AbortSignal.timeout(750),
    });
    throw new Error("product_stack_must_be_stopped");
  } catch (error) {
    if (error instanceof Error && error.message === "product_stack_must_be_stopped") {
      throw new Error(
        "Stop npm run real before creating a family contact link, then restart it after this command.",
      );
    }
  }
}

function writePrivate(filePath: string, value: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, value, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function setupOnlyEngine(): AuthorityEngine {
  const unavailable = async (): Promise<never> => {
    throw new Error("Authority operations are unavailable in family pairing setup");
  };
  const adapter: ExecutionAdapter = {
    resolveEvent: unavailable,
    resolvePerson: unavailable,
    executeDraft: unavailable,
    getExecution: async () => false,
  };
  return new AuthorityEngine({ store: new AuthorityStore(), adapter });
}

async function main(): Promise<void> {
  const input = parseArguments(process.argv.slice(2));
  await assertProductStopped();
  const token = process.env.BANDER_TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("BANDER_TELEGRAM_BOT_TOKEN is required");
  const statePath = path.resolve(
    process.env.BANDER_TELEGRAM_STATE_PATH?.trim() ||
      ".bander/real/telegram-service/state.json",
  );
  const linkPath = path.resolve(
    process.env.BANDER_FAMILY_PAIRING_PATH?.trim() ||
      path.join(path.dirname(statePath), "family-contact-link.txt"),
  );
  const lockPath = `${statePath}.family-pairing.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let lock: number | undefined;
  try {
    lock = fs.openSync(lockPath, "wx", 0o600);
  } catch {
    throw new Error("Another family contact setup command is already running");
  }
  try {
    const store = new FileTelegramServiceStore(statePath);
    if (!store.read().installation) {
      throw new Error("Pair the Bander owner and protected group first");
    }
    const api = new TelegramHttpApi(token);
    const service = new TelegramService({
      api,
      engine: setupOnlyEngine(),
      store,
      mode: "real",
      familyPairingPath: linkPath,
    });
    const pairing = await service.createFamilyContactPairing(input);
    const displayLabel = store.read().familyPairing!.displayLabel;
    writePrivate(
      linkPath,
      `${pairing.link}\nExpires: ${pairing.expiresAt}\n`,
    );
    await api.sendMessage(
      store.read().installation!.ownerTelegramId,
      [
        `Private family-contact link for ${displayLabel}:`,
        pairing.link,
        "Open it only from the invited contact’s Telegram account after confirming that account is outside the protected owner group.",
        "The link expires shortly and can be used by only one contact.",
      ].join("\n"),
    );
    process.stdout.write(
      [
        `Family contact link ready for ${displayLabel}.`,
        "Installation: the currently paired Bander owner and protected group.",
        `Private link file: ${linkPath}`,
        "Bander sent the same private link to the authenticated owner’s private chat.",
        "Open it from the family contact’s Telegram account after confirming that account is outside the protected owner group.",
        "Then start npm run real so Bander can authenticate the private claim and consent.",
        "No notifications are enabled in this checkpoint.",
      ].join("\n") + "\n",
    );
  } finally {
    if (lock !== undefined) fs.closeSync(lock);
    fs.rmSync(lockPath, { force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Family contact setup failed"}\n`,
  );
  process.exitCode = 1;
});
