import fs from "node:fs";
import {
  GoogleCalendarAdapter,
  GoogleCalendarError,
  createGoogleCalendarBoundary,
  resolveLocalStart,
} from "../apps/broker/src/google-calendar.js";
import { loadGoogleCalendarOAuth } from "../apps/broker/src/google-oauth.js";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

let verificationStage = "configuration";
let failureStage: string | undefined;
let diagnosticConcurrentSuccesses = 0;
let diagnosticConcurrentPreconditionFailures = 0;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the real Calendar spike`);
  return value;
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const response = Reflect.get(error, "response");
  if (!response || typeof response !== "object") return undefined;
  const status = Reflect.get(response, "status");
  return typeof status === "number" ? status : undefined;
}

function sameInstant(left: string | null | undefined, right: string): boolean {
  if (!left) return false;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
}

function sameInterval(
  event: { start?: { dateTime?: string | null } | null; end?: { dateTime?: string | null } | null },
  start: string,
  end: string,
): boolean {
  return sameInstant(event.start?.dateTime, start) && sameInstant(event.end?.dateTime, end);
}

async function main(): Promise<void> {
const clientPath = required("GOOGLE_OAUTH_CLIENT_PATH");
const tokenPath = required("GOOGLE_OAUTH_TOKEN_PATH");
const titleHint = required("BANDER_GOOGLE_EVENT_TITLE_HINT");
const localDate = required("BANDER_GOOGLE_EVENT_LOCAL_DATE");
const targetLocalTime = required("BANDER_GOOGLE_TARGET_LOCAL_TIME");

verificationStage = "oauth";
const auth = await loadGoogleCalendarOAuth({ clientPath, tokenPath });
const boundary = createGoogleCalendarBoundary(auth);
const adapter = new GoogleCalendarAdapter(boundary);
verificationStage = "discovery";
const original = await adapter.discoverEvent({ titleHint, localDate });
verificationStage = "target_resolution";
const durationMs = Date.parse(original.endTime) - Date.parse(original.startTime);
if (!Number.isFinite(durationMs) || durationMs <= 0) {
  throw new GoogleCalendarError(
    "invalid_staged_interval",
    "The staged event interval is invalid",
  );
}
const targetStart = resolveLocalStart({
  localDate,
  localTime: targetLocalTime,
  timeZone: original.timeZone,
});
const targetEnd = new Date(Date.parse(targetStart) + durationMs).toISOString();
if (
  Date.parse(targetStart) === Date.parse(original.startTime) ||
  Date.parse(targetEnd) === Date.parse(original.endTime)
) {
  throw new GoogleCalendarError(
    "unchanged_spike_target",
    "The risk-spike target must differ from the staged event interval",
  );
}
verificationStage = "initial_read";

const patch = async (etag: string, start: string, end: string) =>
  boundary.patchEvent({
    calendarId: "primary",
    eventId: original.id,
    sendUpdates: "none",
    ifMatch: etag,
    requestBody: {
      start: { dateTime: start, timeZone: original.timeZone },
      end: { dateTime: end, timeZone: original.timeZone },
    },
  });

let current = await boundary.getEvent({
  calendarId: "primary",
  eventId: original.id,
});
let restored = false;
let staleStatus: number | undefined;
let staleZeroMutation = false;
let concurrentSuccesses = 0;
let concurrentPreconditionFailures = 0;

try {
  verificationStage = "first_conditional_write";
  const first = await patch(original.etag, targetStart, targetEnd);
  if (
    !sameInterval(first, targetStart, targetEnd) ||
    !first.etag
  ) {
    throw new GoogleCalendarError(
      "conditional_response_mismatch",
      "Google Calendar did not return the conditionally updated interval",
    );
  }
  const beforeStale = await boundary.getEvent({
    calendarId: "primary",
    eventId: original.id,
  });
  verificationStage = "stale_precondition";
  try {
    await patch(original.etag, original.startTime, original.endTime);
    staleStatus = 200;
  } catch (error) {
    staleStatus = statusOf(error);
  }
  const afterStale = await boundary.getEvent({
    calendarId: "primary",
    eventId: original.id,
  });
  staleZeroMutation =
    staleStatus === 412 &&
    beforeStale.etag === afterStale.etag &&
    beforeStale.start?.dateTime === afterStale.start?.dateTime &&
    beforeStale.end?.dateTime === afterStale.end?.dateTime;
  if (!staleZeroMutation || !afterStale.etag) {
    throw new Error("A stale Google Calendar ETag did not fail with zero mutation");
  }

  const reset = await patch(afterStale.etag, original.startTime, original.endTime);
  if (!reset.etag) throw new Error("Google Calendar returned no ETag after reset");
  verificationStage = "concurrent_precondition";
  const concurrent = await Promise.allSettled([
    patch(reset.etag, targetStart, targetEnd),
    patch(reset.etag, targetStart, targetEnd),
  ]);
  concurrentSuccesses = concurrent.filter(
    (result) => result.status === "fulfilled",
  ).length;
  concurrentPreconditionFailures = concurrent.filter(
    (result) =>
      result.status === "rejected" && statusOf(result.reason) === 412,
  ).length;
  diagnosticConcurrentSuccesses = concurrentSuccesses;
  diagnosticConcurrentPreconditionFailures = concurrentPreconditionFailures;
  if (concurrentSuccesses !== 1 || concurrentPreconditionFailures !== 1) {
    throw new GoogleCalendarError(
      "unexpected_concurrent_precondition_result",
      "Google Calendar did not serialize identical conditional updates as expected",
    );
  }
} catch (error) {
  failureStage = verificationStage;
  throw error;
} finally {
  verificationStage = "restoration";
  current = await boundary.getEvent({
    calendarId: "primary",
    eventId: original.id,
  });
  const currentIsOriginal = sameInterval(
    current,
    original.startTime,
    original.endTime,
  );
  const currentIsSpikeTarget = sameInterval(current, targetStart, targetEnd);
  if (currentIsOriginal) {
    restored = true;
  } else if (currentIsSpikeTarget && current.etag) {
    const restoration = await patch(
      current.etag,
      original.startTime,
      original.endTime,
    );
    restored = sameInterval(
      restoration,
      original.startTime,
      original.endTime,
    );
  }
}

if (!restored) {
  throw new Error(
    "The staged event was not restored; inspect the dedicated filming Calendar manually",
  );
}

console.log(
  JSON.stringify(
    {
      mode: "real-google-calendar-risk-spike",
      calendar: "primary",
      scopePinned: true,
      eligibleTimedSoloEvent: true,
      canonicalFieldsRead: [
        "id",
        "title",
        "start",
        "end",
        "timezone",
        "organizer",
        "attendees",
        "etag",
      ],
      startEndOnlyConditionalUpdate: true,
      staleEtagStatus: staleStatus,
      staleAttemptZeroMutation: staleZeroMutation,
      concurrentIdenticalUpdates: {
        committed: concurrentSuccesses,
        preconditionFailed: concurrentPreconditionFailures,
      },
      restoredOriginalInterval: restored,
      privateValuesPrinted: false,
    },
    null,
    2,
  ),
);
verificationStage = "complete";
}

main().catch((error: unknown) => {
  const httpStatus = statusOf(error);
  const code =
    error instanceof GoogleCalendarError
      ? error.code
      : httpStatus
        ? `google_http_${httpStatus}`
        : error instanceof Error && error.message.includes(" is required for ")
          ? "configuration_missing"
          : "verification_failed";
  process.stderr.write(
    `${JSON.stringify({
      status: "failed",
      code,
      stage: failureStage ?? verificationStage,
      ...((failureStage ?? verificationStage) === "concurrent_precondition"
        ? {
            concurrentCommitted: diagnosticConcurrentSuccesses,
            concurrentPreconditionFailed:
              diagnosticConcurrentPreconditionFailures,
          }
        : {}),
    })}\n`,
  );
  process.exitCode = 1;
});
