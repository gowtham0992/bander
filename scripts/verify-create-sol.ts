import fs from "node:fs";
import {
  OpenAISolIntentSelector,
  REAL_SOL_MODEL,
  RealCalendarDraftCompiler,
} from "../apps/broker/src/compiler.js";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

const cases = [
  {
    name: "create_relative_default_duration",
    request: "Add lunch with Ruth to my calendar next Tuesday at noon.",
    expected: "ready_create",
  },
  {
    name: "create_absolute_explicit_duration",
    request: "Put a 90 minute planning session on my calendar July 21 at 2 PM.",
    expected: "ready_create",
  },
  {
    name: "create_with_family_update",
    request: "Add tea with Ruth July 22 at 3 PM and let Gil know.",
    expected: "ready_create_family",
  },
  {
    name: "create_dinner_not_reservation",
    request: "Add dinner at Rossi's to my calendar next Tuesday at 7 PM.",
    expected: "ready_create",
  },
  {
    name: "reject_reservation",
    request: "Book a table at Rossi's next Tuesday at 7 PM.",
    expected: "unsupported",
  },
  {
    name: "reject_invitation",
    request: "Add lunch Tuesday at noon and invite Ruth by email.",
    expected: "unsupported",
  },
  {
    name: "reject_recurrence",
    request: "Add lunch with Ruth every Tuesday at noon.",
    expected: "unsupported",
  },
  {
    name: "reject_free_form_family_message",
    request: "Add lunch Tuesday at noon and tell Gil to bring the insurance forms.",
    expected: "unsupported",
  },
] as const;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name.toLocaleLowerCase()}_missing`);
  return value;
}

function classification(value: unknown): string {
  if (!value || typeof value !== "object") return "invalid";
  const output = value as Record<string, unknown>;
  if (output.needsClarification === true) {
    return output.clarificationReason === "unsupported_action"
      ? "unsupported"
      : "clarification";
  }
  if (output.actionKind !== "create_event") return "wrong_action";
  return output.familyNotificationRequested === true
    ? "ready_create_family"
    : "ready_create";
}

async function main() {
  const apiKey = required("OPENAI_API_KEY");
  const timeZone = required("BANDER_CALENDAR_TIME_ZONE");
  const selector = new OpenAISolIntentSelector(apiKey, timeZone);
  let correct = 0;
  let falseAccepts = 0;
  for (const testCase of cases) {
    const output = await selector.select(testCase.request);
    const observed = classification(output);
    const passed = observed === testCase.expected;
    if (passed) correct += 1;
    if (testCase.expected === "unsupported" && observed.startsWith("ready")) {
      falseAccepts += 1;
    }
    if (observed.startsWith("ready")) {
      const compiler = new RealCalendarDraftCompiler(
        { discoverEvent: async () => { throw new Error("create_must_not_discover_existing_event"); } },
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
        () => "b0123456789abcdefghijklmnopqrstuv",
        timeZone,
      );
      const fixture = await compiler.compile(testCase.request);
      if (fixture.calendar?.kind !== "create") throw new Error("not_create_fixture");
      if (!/^[0-9a-v]{5,1024}$/.test(fixture.calendar.eventId)) {
        throw new Error("invalid_client_event_id");
      }
    }
    process.stdout.write(`${JSON.stringify({ case: testCase.name, expected: testCase.expected, observed, correct: passed })}\n`);
  }
  process.stdout.write(`${JSON.stringify({ model: REAL_SOL_MODEL, cases: cases.length, correct, falseAccepts, authorityCreated: false, calendarMutation: false })}\n`);
  if (correct !== cases.length || falseAccepts !== 0) process.exitCode = 1;
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
