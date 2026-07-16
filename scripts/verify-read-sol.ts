import fs from "node:fs";
import {
  OpenAISolReadScheduleIntentSelector,
  ScheduleReadError,
  validateReadScheduleIntent,
} from "../apps/broker/src/read-schedule.js";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

type Expected =
  | {
      status: "ready";
      startLocalDate: string;
      endLocalDateExclusive: string;
    }
  | { status: "clarification_required" }
  | { status: "range_too_large_or_clarification" };

const cases: readonly { name: string; request: string; expected: Expected }[] = [
  {
    name: "tomorrow",
    request: "What’s on my calendar tomorrow?",
    expected: {
      status: "ready",
      startLocalDate: "2026-07-17",
      endLocalDateExclusive: "2026-07-18",
    },
  },
  {
    name: "specific_day",
    request: "Do I have anything on July 18?",
    expected: {
      status: "ready",
      startLocalDate: "2026-07-18",
      endLocalDateExclusive: "2026-07-19",
    },
  },
  {
    name: "inclusive_parent_range",
    request: "What do I have from July 18 through July 20?",
    expected: {
      status: "ready",
      startLocalDate: "2026-07-18",
      endLocalDateExclusive: "2026-07-21",
    },
  },
  {
    name: "missing_date",
    request: "What’s on my calendar?",
    expected: { status: "clarification_required" },
  },
  {
    name: "over_31_days",
    request: "What’s on my calendar from July 17 through August 31?",
    expected: { status: "range_too_large_or_clarification" },
  },
  {
    name: "action_not_read",
    request: "Move my appointment tomorrow.",
    expected: { status: "clarification_required" },
  },
  {
    name: "mixed_read_and_action",
    request: "What’s tomorrow, and move my appointment?",
    expected: { status: "clarification_required" },
  },
];

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name.toLocaleLowerCase()}_missing`);
  return value;
}

function correct(actual: Record<string, unknown>, expected: Expected): boolean {
  if (expected.status === "range_too_large_or_clarification") {
    return ["range_too_large", "clarification_required"].includes(
      String(actual.status),
    );
  }
  if (actual.status !== expected.status) return false;
  if (expected.status === "ready") {
    return (
      actual.startLocalDate === expected.startLocalDate &&
      actual.endLocalDateExclusive === expected.endLocalDateExclusive
    );
  }
  return true;
}

async function main(): Promise<void> {
  const apiKey = required("OPENAI_API_KEY");
  const timeZone = required("BANDER_CALENDAR_TIME_ZONE");
  if (timeZone !== "America/Denver") throw new Error("unexpected_calendar_timezone");
  const context = { timeZone, todayLocalDate: "2026-07-16" };
  const selector = new OpenAISolReadScheduleIntentSelector(apiKey);
  const rows: Array<{
    case: string;
    status: string;
    correct: boolean;
  }> = [];

  for (const item of cases) {
    let actual: Record<string, unknown>;
    try {
      actual = validateReadScheduleIntent(
        await selector.select(item.request, context),
        context,
      );
    } catch (error) {
      actual = {
        status:
          error instanceof ScheduleReadError
            ? error.code
            : "invalid_or_unavailable",
      };
    }
    rows.push({
      case: item.name,
      status: String(actual.status),
      correct: correct(actual, item.expected),
    });
    process.stdout.write(`${JSON.stringify(rows.at(-1))}\n`);
  }

  const failedCases = rows.filter((row) => !row.correct).map((row) => row.case);
  const summary = {
    model: "gpt-5.6-sol",
    liveResponsesCalls: cases.length,
    correctCases: rows.filter((row) => row.correct).length,
    totalCases: rows.length,
    failedCases,
    modelAuthoredCalendarOrAuthorityFieldsAccepted: false,
    calendarCallPerformed: false,
    authorityCreated: false,
    privateValuesPrinted: false,
    status: failedCases.length === 0 ? "passed" : "failed",
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.status !== "passed") process.exitCode = 1;
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.message : "read_sol_probe_failed";
  process.stderr.write(`${JSON.stringify({ status: "failed", code })}\n`);
  process.exitCode = 1;
});
