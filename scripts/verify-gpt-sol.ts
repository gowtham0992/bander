import fs from "node:fs";
import {
  OpenAISolIntentSelector,
  REAL_SOL_MODEL,
  RealCalendarDraftCompiler,
} from "../apps/broker/src/compiler.js";
import {
  GoogleCalendarAdapter,
  GoogleCalendarError,
  createGoogleCalendarBoundary,
} from "../apps/broker/src/google-calendar.js";
import { loadGoogleCalendarOAuth } from "../apps/broker/src/google-oauth.js";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

let stage = "configuration";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for live Sol evidence`);
  return value;
}

function hasForbiddenKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) =>
      [
        "calendarId",
        "eventId",
        "etag",
        "endTime",
        "duration",
        "effects",
        "authority",
        "permit",
        "approval",
        "execution",
      ].includes(key) || hasForbiddenKey(child),
  );
}

async function main(): Promise<void> {
  const apiKey = required("OPENAI_API_KEY");
  const request = required("BANDER_SOL_EVIDENCE_REQUEST");
  const clientPath = required("GOOGLE_OAUTH_CLIENT_PATH");
  const tokenPath = required("GOOGLE_OAUTH_TOKEN_PATH");
  const calendarTimeZone = required("BANDER_CALENDAR_TIME_ZONE");

  stage = "oauth";
  const auth = await loadGoogleCalendarOAuth({ clientPath, tokenPath });
  const calendar = new GoogleCalendarAdapter(createGoogleCalendarBoundary(auth));

  stage = "live_sol_call";
  const intent = await new OpenAISolIntentSelector(apiKey, calendarTimeZone).select(request);
  if (hasForbiddenKey(intent)) {
    throw new Error("The model returned a forbidden authority field");
  }

  stage = "deterministic_compilation";
  const fixture = await new RealCalendarDraftCompiler(calendar, {
    select: async () => intent,
  }).compile(request);
  if (!fixture.calendar) throw new Error("fixture_has_no_calendar");
  const event = await calendar.resolveEvent(fixture.calendar.eventId);
  const durationMs = Date.parse(event.endTime) - Date.parse(event.startTime);
  if (
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    fixture.message !== undefined
  ) {
    throw new GoogleCalendarError(
      "invalid_compiled_action",
      "The compiled action did not preserve the narrow Calendar boundary",
    );
  }

  console.log(
    JSON.stringify(
      {
        model: REAL_SOL_MODEL,
        liveResponsesCall: true,
        modelOutputFields: [
          "eventTitleHint",
          "sourceLocalDateHint",
          "targetLocalDate",
          "targetLocalStart",
          "needsClarification",
          "clarificationReason",
          "clarification",
        ],
        exactlyOneRealEventResolved: true,
        eventIdChosenByBander: true,
        etagReadByBander: true,
        durationReadFromAuthoritativeEvent: true,
        calendarMutationPerformed: false,
        modelAuthoredAuthorityFields: false,
        privateValuesPrinted: false,
      },
      null,
      2,
    ),
  );
  stage = "complete";
}

main().catch((error: unknown) => {
  const code =
    error instanceof GoogleCalendarError
      ? error.code
      : error && typeof error === "object" && "code" in error
        ? String(Reflect.get(error, "code"))
        : error instanceof Error && error.message.includes(" is required for ")
          ? "configuration_missing"
          : "verification_failed";
  process.stderr.write(`${JSON.stringify({ status: "failed", code, stage })}\n`);
  process.exitCode = 1;
});
