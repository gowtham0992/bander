import fs from "node:fs";
import path from "node:path";
import { revokeActiveFamilyContact } from "../apps/broker/src/family-contact.js";
import { FileTelegramServiceStore } from "../apps/broker/src/telegram-service.js";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const statePath = path.resolve(process.env.BANDER_TELEGRAM_STATE_PATH || ".bander/real/telegram-service/state.json");
const lockPath = `${statePath}.family-revoke.lock`;
fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
let lock: number | undefined;
try { lock = fs.openSync(lockPath, "wx", 0o600); } catch { throw new Error("Another family-contact operation is running"); }
try {
  const store = new FileTelegramServiceStore(statePath);
  const state = store.read();
  if (state.familyContact) {
    state.familyContactAudit = revokeActiveFamilyContact(state.familyContact, { now: new Date(), revokedBy: "owner" });
    delete state.familyContact;
    delete state.familyPairing;
    store.write(state);
  }
  fs.rmSync(path.resolve(process.env.BANDER_FAMILY_PAIRING_PATH || path.join(path.dirname(statePath), "family-contact-link.txt")), { force: true });
  process.stdout.write("Family contact: revoked\n");
} finally {
  if (lock !== undefined) fs.closeSync(lock);
  fs.rmSync(lockPath, { force: true });
}
