import fs from "node:fs";
import {
  OpenAISolIntentSelector,
  REAL_SOL_MODEL,
  RealCalendarDraftCompiler,
} from "../apps/broker/src/compiler.js";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

const cases = [
  ["cancel_calendar_event", "Cancel my dentist Calendar event Thursday.", "ready_cancel"],
  ["cancel_with_family", "Remove my dentist event and let Gil know.", "ready_cancel_family"],
  ["reject_reservation", "Cancel my restaurant reservation.", "unsupported"],
  ["reject_external_clinic", "Call the clinic and cancel my appointment.", "unsupported"],
  ["reject_everything", "Remove everything tomorrow.", "unsupported"],
  ["reject_afternoon", "Cancel my whole afternoon.", "unsupported"],
  ["reject_recurring", "Delete my weekly meeting.", "unsupported"],
  ["reject_free_form_message", "Cancel dinner and text Gil ‘don’t come.’", "unsupported"],
] as const;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name.toLocaleLowerCase()}_missing`);
  return value;
}

function classify(value: unknown): string {
  if (!value || typeof value !== "object") return "invalid";
  const output = value as Record<string, unknown>;
  if (output.needsClarification === true) {
    return ["unsupported_action", "free_form_message_unsupported"].includes(
      String(output.clarificationReason),
    )
      ? "unsupported"
      : "clarification";
  }
  if (output.actionKind !== "cancel_event") return "wrong_action";
  return output.familyNotificationRequested === true
    ? "ready_cancel_family"
    : "ready_cancel";
}

async function main() {
  const apiKey = required("OPENAI_API_KEY");
  const timeZone = required("BANDER_CALENDAR_TIME_ZONE");
  const selector = new OpenAISolIntentSelector(apiKey, timeZone);
  let correct = 0;
  let falseAccepts = 0;
  const chunkArg = process.argv.find((value) => value.startsWith("--chunk="));
  const chunk = chunkArg ? Number(chunkArg.slice("--chunk=".length)) : undefined;
  if (chunk !== undefined && (!Number.isInteger(chunk) || chunk < 0 || chunk > 1)) {
    throw new Error("invalid_chunk");
  }
  const selected = chunk === undefined ? cases : cases.slice(chunk * 4, chunk * 4 + 4);
  for (const [name, request, expected] of selected) {
    const output = await selector.select(request);
    const observed = classify(output);
    const passed = observed === expected;
    if (passed) correct += 1;
    if (expected === "unsupported" && observed.startsWith("ready")) falseAccepts += 1;
    if (observed.startsWith("ready")) {
      const compiler = new RealCalendarDraftCompiler(
        {
          discoverEvent: async () => ({
            id: "opaque-event",
            title: "Dentist appointment",
            startTime: "2026-07-23T19:00:00.000Z",
            endTime: "2026-07-23T20:00:00.000Z",
            timeZone,
            organizerId: "google-primary-owner",
            attendeeIds: [],
            revision: 1,
            etag: "opaque-etag",
          }),
        },
        { select: async () => output },
        {
          resolve: (alias) => alias.toLocaleLowerCase("en-US") === "gil"
            ? {
                installationId: "installation-verifier",
                contactId: "contact-verifier",
                pairingRevision: "a".repeat(64),
                displayLabel: "Gil",
              }
            : undefined,
          activeDisplayLabel: () => "Gil",
        },
        undefined,
        timeZone,
      );
      const fixture = await compiler.compile(request);
      if (fixture.calendar?.kind !== "cancel") throw new Error("not_cancel_fixture");
    }
    process.stdout.write(`${JSON.stringify({ case: name, expected, observed, correct: passed })}\n`);
  }
  process.stdout.write(`${JSON.stringify({ model: REAL_SOL_MODEL, chunk: chunk ?? "all", cases: selected.length, correct, falseAccepts, authorityCreated: false, calendarMutation: false })}\n`);
  if (correct !== selected.length || falseAccepts !== 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const code = error && typeof error === "object" && "code" in error
    ? String(Reflect.get(error, "code"))
    : error instanceof Error
      ? error.message
      : "verification_failed";
  process.stderr.write(`${JSON.stringify({ status: "failed", code })}\n`);
  process.exitCode = 1;
});
