import fs from "node:fs";
import {
  COMPOUND_SOL_MODEL,
  OpenAISolCompoundIntentSelector,
  probeCompoundIntent,
} from "../apps/broker/src/compound-intent.js";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

type Expected =
  | {
      status: "ready";
      targetLocalDate: string;
      targetLocalStart: string;
      contactKey: string;
    }
  | { status: "clarification_required"; reason: string }
  | { status: "unsupported"; reason: string };

const cases: readonly { name: string; request: string; expected: Expected }[] = [
  {
    name: "compound_friday_gil",
    request: "Move Bander Demo Appointment to Friday at 2 and let Gil know.",
    expected: {
      status: "ready",
      targetLocalDate: "2026-07-17",
      targetLocalStart: "14:00",
      contactKey: "contact-gil",
    },
  },
  {
    name: "compound_july18_son",
    request: "Could you shift my appointment to July 18 at 4 PM and tell my son?",
    expected: {
      status: "ready",
      targetLocalDate: "2026-07-18",
      targetLocalStart: "16:00",
      contactKey: "contact-gil",
    },
  },
  {
    name: "compound_tomorrow_gil",
    request: "Change the Bander Demo Appointment to 1 tomorrow and notify Gil.",
    expected: {
      status: "ready",
      targetLocalDate: "2026-07-16",
      targetLocalStart: "13:00",
      contactKey: "contact-gil",
    },
  },
  {
    name: "compound_imperfect_parent_wording",
    request: "hey could ya move BANDER demo appointment, to friday 2pm... and let gil know thanks",
    expected: {
      status: "ready",
      targetLocalDate: "2026-07-17",
      targetLocalStart: "14:00",
      contactKey: "contact-gil",
    },
  },
  {
    name: "compound_filler_relationship",
    request: "Please, when you have a moment, move Bander Demo Appointment to this Friday at two in the afternoon and let my son know.",
    expected: {
      status: "ready",
      targetLocalDate: "2026-07-17",
      targetLocalStart: "14:00",
      contactKey: "contact-gil",
    },
  },
  {
    name: "clarify_missing_date",
    request: "Move Bander Demo Appointment to 2 PM and let Gil know.",
    expected: { status: "clarification_required", reason: "missing_target_date" },
  },
  {
    name: "clarify_missing_time",
    request: "Move Bander Demo Appointment to Friday and let Gil know.",
    expected: { status: "clarification_required", reason: "missing_target_time" },
  },
  {
    name: "clarify_missing_event",
    request: "Move it to Friday at 2 PM and let Gil know.",
    expected: { status: "clarification_required", reason: "missing_event_title" },
  },
  {
    name: "clarify_unresolved_pronoun",
    request: "Move Bander Demo Appointment to Friday at 2 PM and tell him.",
    expected: { status: "clarification_required", reason: "ambiguous_contact" },
  },
  {
    name: "clarify_multiple_people",
    request: "Move Bander Demo Appointment to Friday at 2 PM and notify Gil and Alex.",
    expected: { status: "clarification_required", reason: "ambiguous_contact" },
  },
  {
    name: "clarify_ambiguous_relative_date",
    request: "Move Bander Demo Appointment to next weekend at 2 PM and let Gil know.",
    expected: {
      status: "clarification_required",
      reason: "ambiguous_relative_date",
    },
  },
  {
    name: "clarify_free_form_message",
    request: "Move Bander Demo Appointment to Friday at 2 PM and tell Gil to bring the documents and call me.",
    expected: {
      status: "clarification_required",
      reason: "free_form_message_unsupported",
    },
  },
  {
    name: "clarify_unpaired_person",
    request: "Move Bander Demo Appointment to Friday at 2 PM and notify Sarah.",
    expected: { status: "clarification_required", reason: "unpaired_contact" },
  },
  {
    name: "unsupported_cancellation",
    request: "Cancel Bander Demo Appointment and tell Gil.",
    expected: { status: "unsupported", reason: "unsupported_action" },
  },
  {
    name: "unsupported_purchase",
    request: "Buy a birthday gift and tell Gil.",
    expected: { status: "unsupported", reason: "unsupported_action" },
  },
  {
    name: "unsupported_reservation",
    request: "Book a restaurant for Friday and notify Gil.",
    expected: { status: "unsupported", reason: "unsupported_action" },
  },
  {
    name: "unsupported_door_lock",
    request: "Lock the front door and tell Gil.",
    expected: { status: "unsupported", reason: "unsupported_action" },
  },
  {
    name: "unsupported_multiple_events",
    request: "Move my dentist visit and Bander Demo Appointment to Friday at 2 PM and notify Gil.",
    expected: { status: "unsupported", reason: "multiple_events_unsupported" },
  },
];

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name.toLocaleLowerCase()}_missing`);
  return value;
}

function matchesExpected(actual: Record<string, unknown>, expected: Expected): boolean {
  if (actual.status !== expected.status) return false;
  if (expected.status === "ready") {
    return (
      actual.targetLocalDate === expected.targetLocalDate &&
      actual.targetLocalStart === expected.targetLocalStart &&
      actual.contactKey === expected.contactKey
    );
  }
  return actual.reason === expected.reason;
}

async function main(): Promise<void> {
  const apiKey = required("OPENAI_API_KEY");
  const timeZone = required("BANDER_CALENDAR_TIME_ZONE");
  if (timeZone !== "America/Denver") throw new Error("unexpected_calendar_timezone");
  const todayLocalDate = "2026-07-15";
  const selector = new OpenAISolCompoundIntentSelector({
    apiKey,
    timeZone,
    todayLocalDate,
  });
  const context = {
    nowLocalDate: todayLocalDate,
    timeZone,
    contacts: [
      { key: "contact-gil", aliases: ["gil", "son", "my son"] },
      { key: "contact-alex-1", aliases: ["alex"] },
      { key: "contact-alex-2", aliases: ["alex"] },
    ],
  };

  const rows: Array<{
    case: string;
    expected: string;
    observed: string;
    reason?: string;
    correct: boolean;
  }> = [];
  let falseAcceptCount = 0;
  let invalidModelOutputCount = 0;
  let readyCorrect = 0;
  let readyTotal = 0;
  let clarificationCorrect = 0;
  let clarificationTotal = 0;

  for (const item of cases) {
    const actual = (await probeCompoundIntent(
      selector,
      item.request,
      context,
    )) as Record<string, unknown>;
    const correct = matchesExpected(actual, item.expected);
    if (item.expected.status === "ready") {
      readyTotal += 1;
      if (correct) readyCorrect += 1;
    } else {
      clarificationTotal += 1;
      if (correct) clarificationCorrect += 1;
      if (actual.status === "ready") falseAcceptCount += 1;
    }
    if (actual.status === "invalid_model_output" || actual.status === "model_unavailable") {
      invalidModelOutputCount += 1;
    }
    rows.push({
      case: item.name,
      expected: item.expected.status,
      observed: String(actual.status),
      ...(typeof actual.reason === "string" ? { reason: actual.reason } : {}),
      correct,
    });
    process.stdout.write(`${JSON.stringify(rows.at(-1))}\n`);
  }

  const failedCases = rows.filter((row) => !row.correct).map((row) => row.case);
  const summary = {
    model: COMPOUND_SOL_MODEL,
    liveResponsesCalls: cases.length,
    strictStructuredOutput: true,
    correctExtractionRate: `${readyCorrect}/${readyTotal}`,
    clarificationAndUnsupportedRate: `${clarificationCorrect}/${clarificationTotal}`,
    falseAcceptCount,
    invalidModelOutputCount,
    failedCases,
    modelAuthoredRoutingAccepted: false,
    modelAuthoredMessageBodyAccepted: false,
    modelAuthoredAuthorityAccepted: false,
    calendarMutationPerformed: false,
    telegramDeliveryPerformed: false,
    authorityCreated: false,
    privateIdentifiersPrinted: false,
    status:
      failedCases.length === 0 && falseAcceptCount === 0 && invalidModelOutputCount === 0
        ? "passed"
        : "failed",
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.status !== "passed") process.exitCode = 1;
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.message : "compound_sol_probe_failed";
  process.stderr.write(`${JSON.stringify({ status: "failed", code })}\n`);
  process.exitCode = 1;
});
