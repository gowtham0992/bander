import { randomBytes } from "node:crypto";
import fs from "node:fs";
import type { DraftDocument } from "@bander/contracts";
import {
  GoogleCalendarAdapter,
  createGoogleCalendarBoundary,
  resolveLocalStart,
  type GoogleCalendarBoundary,
} from "../apps/broker/src/google-calendar.js";
import { loadGoogleCalendarOAuth } from "../apps/broker/src/google-oauth.js";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name.toLocaleLowerCase()}_missing`);
  return value;
}

function argument(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function main() {
  const mode = process.argv.includes("--simulate-lost-response") ? "lost" : "inspect";
  const auth = await loadGoogleCalendarOAuth({
    clientPath: required("GOOGLE_OAUTH_CLIENT_PATH"),
    tokenPath: required("GOOGLE_OAUTH_TOKEN_PATH"),
  });
  const boundary = createGoogleCalendarBoundary(auth);
  const timeZone = await boundary.getPrimaryTimeZone();
  if (timeZone !== required("BANDER_CALENDAR_TIME_ZONE")) {
    throw new Error("calendar_timezone_mismatch");
  }

  if (mode === "inspect") {
    const title = argument("--title");
    const localDate = argument("--date");
    if (!title || !localDate) throw new Error("inspect_requires_title_and_date");
    const dayStart = resolveLocalStart({ localDate, localTime: "00:00", timeZone });
    const nextDate = new Date(`${localDate}T00:00:00.000Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    const nextLocalDate = nextDate.toISOString().slice(0, 10);
    const dayEnd = resolveLocalStart({ localDate: nextLocalDate, localTime: "00:00", timeZone });
    const events = await boundary.listEvents({
      calendarId: "primary",
      timeMin: dayStart,
      timeMax: dayEnd,
    });
    const matches = events.filter((event) => event.summary === title && event.status !== "cancelled");
    const exact = matches.filter(
      (event) =>
        event.start?.dateTime &&
        event.end?.dateTime &&
        event.start.timeZone === timeZone &&
        event.end.timeZone === timeZone,
    );
    process.stdout.write(`${JSON.stringify({ mode, title, localDate, matchCount: matches.length, exactTimedCount: exact.length, timeZone, identifiersPrinted: false })}\n`);
    if (matches.length !== 1 || exact.length !== 1) process.exitCode = 1;
    return;
  }

  if (argument("--confirm-real-write") !== "BANDER_CREATE_RECOVERY_PROBE") {
    throw new Error("lost_response_probe_requires_explicit_confirmation");
  }
  const title = "Bander 7A Lost Response Probe";
  const localDate = "2026-07-22";
  const startTime = resolveLocalStart({ localDate, localTime: "16:00", timeZone });
  const endTime = new Date(Date.parse(startTime) + 60 * 60_000).toISOString();
  const eventId = `b${randomBytes(16).toString("hex")}`;
  let insertAttempts = 0;
  const lossyBoundary: GoogleCalendarBoundary = {
    listEvents: (input) => boundary.listEvents(input),
    getPrimaryTimeZone: () => boundary.getPrimaryTimeZone(),
    listScheduleEvents: (input) => boundary.listScheduleEvents(input),
    getEvent: (input) => boundary.getEvent(input),
    patchEvent: (input) => boundary.patchEvent(input),
    insertEvent: async (input) => {
      insertAttempts += 1;
      await boundary.insertEvent(input);
      throw new Error("simulated_response_loss_after_google_acceptance");
    },
  };
  const adapter = new GoogleCalendarAdapter(lossyBoundary);
  const document: DraftDocument = {
    version: 1,
    source: { provenance: "agent_claimed", claimedUserRequest: "Checkpoint 7A recovery probe" },
    effects: [{
      type: "calendar.create_event",
      calendarId: "primary",
      eventId,
      title,
      startTime,
      endTime,
      timeZone,
      eventType: "default",
    }],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
  const input = { draftHash: "live-create-recovery-probe", permitNonce: "live-create-recovery-permit", document };
  const first = await adapter.executeDraft(input);
  const replay = await adapter.executeDraft(input);
  process.stdout.write(`${JSON.stringify({ mode, title, localDate, localInterval: "4:00–5:00 PM", timeZone, firstStatus: first.calendar.status, replayStatus: replay.calendar.status, insertAttempts, familyDeliveryAttempts: 0, identifiersPrinted: false })}\n`);
  if (first.calendar.status !== "observed_target" || replay.calendar.status !== "observed_target" || insertAttempts !== 1) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.message : "verification_failed";
  process.stderr.write(`${JSON.stringify({ status: "failed", code })}\n`);
  process.exitCode = 1;
});
