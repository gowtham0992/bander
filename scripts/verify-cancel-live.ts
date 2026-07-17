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

function eventId(): string {
  return `b${randomBytes(16).toString("hex")}`;
}

async function main() {
  const auth = await loadGoogleCalendarOAuth({
    clientPath: required("GOOGLE_OAUTH_CLIENT_PATH"),
    tokenPath: required("GOOGLE_OAUTH_TOKEN_PATH"),
  });
  const boundary = createGoogleCalendarBoundary(auth);
  const timeZone = await boundary.getPrimaryTimeZone();
  if (timeZone !== required("BANDER_CALENDAR_TIME_ZONE")) {
    throw new Error("calendar_timezone_mismatch");
  }

  if (process.argv.includes("--stage")) {
    if (argument("--confirm-real-write") !== "BANDER_CANCEL_STAGE") {
      throw new Error("stage_requires_explicit_confirmation");
    }
    const staged = [
      ["Bander 7B Dentist Appointment", "2026-07-23", "13:00"],
      ["Bander 7B Changed World Appointment", "2026-07-24", "10:00"],
    ] as const;
    for (const [title, localDate, localTime] of staged) {
      const start = resolveLocalStart({ localDate, localTime, timeZone });
      const end = new Date(Date.parse(start) + 60 * 60_000).toISOString();
      await boundary.insertEvent({
        calendarId: "primary",
        sendUpdates: "none",
        conferenceDataVersion: 0,
        supportsAttachments: false,
        requestBody: {
          id: eventId(),
          summary: title,
          eventType: "default",
          start: { dateTime: start, timeZone },
          end: { dateTime: end, timeZone },
        },
      });
      process.stdout.write(`${JSON.stringify({ mode: "stage", title, localDate, localTime, timeZone, identifiersPrinted: false })}\n`);
    }
    return;
  }

  if (process.argv.includes("--simulate-lost-response")) {
    if (argument("--confirm-real-write") !== "BANDER_CANCEL_RECOVERY_PROBE") {
      throw new Error("lost_response_probe_requires_explicit_confirmation");
    }
    const title = "Bander 7B Lost Delete Probe";
    const localDate = "2026-07-25";
    const start = resolveLocalStart({ localDate, localTime: "11:00", timeZone });
    const end = new Date(Date.parse(start) + 60 * 60_000).toISOString();
    const created = await boundary.insertEvent({
      calendarId: "primary",
      sendUpdates: "none",
      conferenceDataVersion: 0,
      supportsAttachments: false,
      requestBody: {
        id: eventId(),
        summary: title,
        eventType: "default",
        start: { dateTime: start, timeZone },
        end: { dateTime: end, timeZone },
      },
    });
    if (!created.id || !created.etag) throw new Error("probe_event_identity_missing");
    let deleteAttempts = 0;
    const lossy: GoogleCalendarBoundary = {
      listEvents: (input) => boundary.listEvents(input),
      getPrimaryTimeZone: () => boundary.getPrimaryTimeZone(),
      listScheduleEvents: (input) => boundary.listScheduleEvents(input),
      getEvent: (input) => boundary.getEvent(input),
      patchEvent: (input) => boundary.patchEvent(input),
      insertEvent: (input) => boundary.insertEvent(input),
      deleteEvent: async (input) => {
        deleteAttempts += 1;
        await boundary.deleteEvent(input);
        throw new Error("simulated_response_loss_after_google_acceptance");
      },
    };
    const adapter = new GoogleCalendarAdapter(lossy);
    const document: DraftDocument = {
      version: 1,
      source: { provenance: "agent_claimed", claimedUserRequest: "Checkpoint 7B recovery probe" },
      effects: [{
        type: "calendar.cancel_event",
        calendarId: "primary",
        eventId: created.id,
        expected: {
          etag: created.etag,
          title,
          startTime: start,
          endTime: end,
          timeZone,
          eventType: "default",
          organizerMustBeOwner: true,
          attendeeIdsExactly: [],
          recurring: false,
        },
      }],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
    const input = { draftHash: "live-cancel-recovery-probe", permitNonce: "live-cancel-recovery-permit", document };
    const first = await adapter.executeDraft(input);
    const replay = await adapter.executeDraft(input);
    process.stdout.write(`${JSON.stringify({ mode: "lost", title, localDate, localInterval: "11:00 AM–12:00 PM", timeZone, firstStatus: first.calendar.status, replayStatus: replay.calendar.status, deleteAttempts, familyDeliveryAttempts: 0, identifiersPrinted: false })}\n`);
    if (first.calendar.status !== "observed_target" || replay.calendar.status !== "observed_target" || deleteAttempts !== 1) process.exitCode = 1;
    return;
  }

  const title = argument("--title");
  const localDate = argument("--date");
  if (!title || !localDate) throw new Error("inspect_requires_title_and_date");
  const start = resolveLocalStart({ localDate, localTime: "00:00", timeZone });
  const next = new Date(`${localDate}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const end = resolveLocalStart({ localDate: next.toISOString().slice(0, 10), localTime: "00:00", timeZone });
  const events = await boundary.listEvents({ calendarId: "primary", timeMin: start, timeMax: end });

  if (process.argv.includes("--change")) {
    if (argument("--confirm-real-write") !== "BANDER_CANCEL_STALE_CHANGE") {
      throw new Error("change_requires_explicit_confirmation");
    }
    const targetLocalTime = argument("--target-time");
    if (!targetLocalTime) throw new Error("change_requires_target_time");
    const matching = events.filter((event) => event.summary === title && event.status !== "cancelled");
    if (matching.length !== 1) throw new Error("change_requires_exactly_one_active_event");
    const event = matching[0];
    if (!event?.id || !event.etag || !event.start?.dateTime || !event.end?.dateTime) {
      throw new Error("change_event_shape_unsupported");
    }
    const durationMs = Date.parse(event.end.dateTime) - Date.parse(event.start.dateTime);
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("change_event_duration_invalid");
    const changedStart = resolveLocalStart({ localDate, localTime: targetLocalTime, timeZone });
    const changedEnd = new Date(Date.parse(changedStart) + durationMs).toISOString();
    await boundary.patchEvent({
      calendarId: "primary",
      eventId: event.id,
      sendUpdates: "none",
      ifMatch: event.etag,
      requestBody: {
        start: { dateTime: changedStart, timeZone },
        end: { dateTime: changedEnd, timeZone },
      },
    });
    process.stdout.write(`${JSON.stringify({ mode: "change", title, localDate, targetLocalTime, durationMinutes: durationMs / 60_000, timeZone, identifiersPrinted: false })}\n`);
    return;
  }

  const active = events.filter((event) => event.summary === title && event.status !== "cancelled").length;
  const cancelled = events.filter((event) => event.id && event.summary === title && event.status === "cancelled").length;
  process.stdout.write(`${JSON.stringify({ mode: "inspect", title, localDate, active, cancelled, timeZone, identifiersPrinted: false })}\n`);
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.message : "verification_failed";
  process.stderr.write(`${JSON.stringify({ status: "failed", code })}\n`);
  process.exitCode = 1;
});
