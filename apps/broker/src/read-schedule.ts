import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { ScheduleReadResult } from "@bander/contracts";

export const READ_SCHEDULE_MODEL = "gpt-5.6-sol" as const;
export const MAX_SCHEDULE_DAYS = 31;
export const MAX_SCHEDULE_EVENTS = 50;

export const ReadScheduleIntentSchema = z
  .object({
    startLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    endLocalDateExclusive: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    needsClarification: z.boolean(),
    clarificationQuestion: z.string().trim().min(1).max(160).nullable(),
  })
  .strict();

export type ReadScheduleIntent = z.infer<typeof ReadScheduleIntentSchema>;

export class ScheduleReadError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ScheduleReadError";
  }
}

export interface ReadScheduleIntentSelector {
  select(
    request: string,
    context: { timeZone: string; todayLocalDate: string },
  ): Promise<unknown>;
}

export interface ScheduleReadBackend {
  getAuthoritativeTimeZone(): Promise<string>;
  readSchedule(input: {
    startLocalDate: string;
    endLocalDateExclusive: string;
    timeZone: string;
    maxEvents: number;
  }): Promise<ScheduleReadResult>;
}

function isRealLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const instant = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
}

function calendarDayNumber(value: string): number {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) {
    throw new ScheduleReadError("invalid_range", "Which date should I check?");
  }
  return parsed / 86_400_000;
}

function safeClarification(value: string | null): string {
  const safe = (value ?? "Which date should I check?")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return safe || "Which date should I check?";
}

export function validateReadScheduleIntent(
  raw: unknown,
  _context: { timeZone: string; todayLocalDate: string },
):
  | {
      status: "ready";
      startLocalDate: string;
      endLocalDateExclusive: string;
    }
  | { status: "clarification_required"; question: string } {
  const intent = ReadScheduleIntentSchema.parse(raw);
  if (intent.needsClarification) {
    return {
      status: "clarification_required",
      question: safeClarification(intent.clarificationQuestion),
    };
  }
  if (
    !intent.startLocalDate ||
    !intent.endLocalDateExclusive ||
    !isRealLocalDate(intent.startLocalDate) ||
    !isRealLocalDate(intent.endLocalDateExclusive) ||
    intent.clarificationQuestion !== null
  ) {
    throw new ScheduleReadError("invalid_model_output", "Which date should I check?");
  }
  const days =
    calendarDayNumber(intent.endLocalDateExclusive) -
    calendarDayNumber(intent.startLocalDate);
  if (days <= 0) {
    throw new ScheduleReadError(
      "invalid_range",
      "Please ask about one clear date or date range.",
    );
  }
  if (days > MAX_SCHEDULE_DAYS) {
    throw new ScheduleReadError(
      "range_too_large",
      "Please ask about a period of 31 days or less.",
    );
  }
  return {
    status: "ready",
    startLocalDate: intent.startLocalDate,
    endLocalDateExclusive: intent.endLocalDateExclusive,
  };
}

function localMinuteParts(instant: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(new Date(instant));
  const part = (name: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === name)?.value ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}

function resolveLocalMidnight(localDate: string, timeZone: string): string {
  if (!isRealLocalDate(localDate)) {
    throw new ScheduleReadError("invalid_range", "Which date should I check?");
  }
  const center = Date.parse(`${localDate}T00:00:00.000Z`);
  const matches: string[] = [];
  for (
    let candidate = center - 18 * 60 * 60_000;
    candidate <= center + 18 * 60 * 60_000;
    candidate += 60_000
  ) {
    const instant = new Date(candidate).toISOString();
    const local = localMinuteParts(instant, timeZone);
    if (local.date === localDate && local.time === "00:00") matches.push(instant);
  }
  if (matches.length !== 1) {
    throw new ScheduleReadError(
      "invalid_calendar_timezone_boundary",
      "I couldn’t establish that calendar day safely.",
    );
  }
  return matches[0]!;
}

export function localDateRangeToInstants(input: {
  startLocalDate: string;
  endLocalDateExclusive: string;
  timeZone: string;
}): { timeMin: string; timeMax: string } {
  return {
    timeMin: resolveLocalMidnight(input.startLocalDate, input.timeZone),
    timeMax: resolveLocalMidnight(input.endLocalDateExclusive, input.timeZone),
  };
}

export function sanitizeScheduleTitle(value: string | null | undefined): string {
  const safe = (value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return safe || "Untitled event";
}

function todayInTimeZone(now: Date, timeZone: string): string {
  if (!Number.isFinite(now.getTime())) {
    throw new ScheduleReadError("invalid_clock", "I couldn’t establish today’s date.");
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).formatToParts(now);
  const part = (name: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === name)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export class ReadScheduleService {
  readonly #selector: ReadScheduleIntentSelector;
  readonly #backend: ScheduleReadBackend;
  readonly #now: () => Date;

  constructor(input: {
    selector: ReadScheduleIntentSelector;
    backend: ScheduleReadBackend;
    now?: () => Date;
  }) {
    this.#selector = input.selector;
    this.#backend = input.backend;
    this.#now = input.now ?? (() => new Date());
  }

  async read(
    request: string,
  ): Promise<ScheduleReadResult | { status: "clarification_required"; question: string }> {
    const timeZone = await this.#backend.getAuthoritativeTimeZone();
    try {
      new Intl.DateTimeFormat("en-US", { timeZone }).format();
    } catch {
      throw new ScheduleReadError(
        "calendar_unavailable",
        "I can’t establish your calendar’s timezone right now.",
      );
    }
    const context = {
      timeZone,
      todayLocalDate: todayInTimeZone(this.#now(), timeZone),
    };
    let raw: unknown;
    try {
      raw = await this.#selector.select(request, context);
    } catch (error) {
      if (error instanceof ScheduleReadError) throw error;
      throw new ScheduleReadError(
        "model_unavailable",
        "I can’t work out that calendar range right now. Please try again shortly.",
      );
    }
    let intent;
    try {
      intent = validateReadScheduleIntent(raw, context);
    } catch (error) {
      if (error instanceof ScheduleReadError) throw error;
      throw new ScheduleReadError(
        "invalid_model_output",
        "I couldn’t identify one safe calendar range.",
      );
    }
    if (intent.status === "clarification_required") return intent;
    return this.#backend.readSchedule({
      startLocalDate: intent.startLocalDate,
      endLocalDateExclusive: intent.endLocalDateExclusive,
      timeZone,
      maxEvents: MAX_SCHEDULE_EVENTS,
    });
  }
}

export class OpenAISolReadScheduleIntentSelector
  implements ReadScheduleIntentSelector
{
  readonly #client: OpenAI;

  constructor(apiKey: string) {
    this.#client = new OpenAI({ apiKey, timeout: 20_000, maxRetries: 1 });
  }

  async select(
    request: string,
    context: { timeZone: string; todayLocalDate: string },
  ): Promise<unknown> {
    try {
      const response = await this.#client.responses.parse({
        model: READ_SCHEDULE_MODEL,
        store: false,
        reasoning: { effort: "low" },
        max_output_tokens: 250,
        instructions: [
          "Extract one bounded read-only schedule range for Bander.",
          "Return only startLocalDate, exclusive endLocalDateExclusive, needsClarification, and one short clarificationQuestion.",
          `Today is ${context.todayLocalDate} in the connected Calendar's authoritative timezone ${context.timeZone}. Resolve relative dates only in that timezone.`,
          "For one local day, start is that date and exclusive end is the following local calendar date.",
          "Never emit or choose a Calendar ID, account, event ID, ETag, credential, filter, effect, approval, authority, execution parameter, or action.",
          "Do not silently broaden a range. If the date or range is missing or ambiguous, ask one specific short question.",
          "This tool supports reading only. If the request asks to move, cancel, create, message, or otherwise change something, request clarification instead of extracting an action.",
          "If one message mixes reading with a consequential action, ask the person to make one clear consequential request; do not split it.",
          "For a complete read range, needsClarification is false and clarificationQuestion is null. Otherwise both date fields are null, needsClarification is true, and clarificationQuestion is one plain-text question.",
        ].join(" "),
        input: request,
        text: {
          format: zodTextFormat(ReadScheduleIntentSchema, "bander_schedule_read_intent"),
        },
      });
      if (!response.output_parsed) {
        throw new ScheduleReadError(
          "invalid_model_output",
          "I couldn’t identify one safe calendar range.",
        );
      }
      return ReadScheduleIntentSchema.parse(response.output_parsed);
    } catch (error) {
      if (error instanceof ScheduleReadError) throw error;
      if (error instanceof z.ZodError) {
        throw new ScheduleReadError(
          "invalid_model_output",
          "I couldn’t identify one safe calendar range.",
        );
      }
      throw new ScheduleReadError(
        "model_unavailable",
        "I can’t work out that calendar range right now. Please try again shortly.",
      );
    }
  }
}
