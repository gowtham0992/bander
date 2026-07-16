import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod/v4";
import type { DraftFixture } from "@bander/core";
import type { CalendarEvent } from "@bander/contracts";
import {
  GoogleCalendarError,
  resolveLocalStart,
} from "./google-calendar.js";

const fixtureIds = [
  "move-dinner-and-notify-sarah",
  "move-my-focus-block",
  "move-dinner-under-standing-band",
  "unsupported",
] as const;

const SelectionSchema = z.object({
  fixtureId: z.enum(fixtureIds),
  needsClarification: z.boolean(),
  clarification: z.string().max(240),
});

type Selection = z.infer<typeof SelectionSchema>;

export interface CandidateSelector {
  select(agentClaimedRequest: string): Promise<Selection>;
}

export interface DraftCompiler {
  compile(agentClaimedRequest: string): Promise<DraftFixture>;
}

function normalizeRequest(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[’‘]/g, "'")
    .trim()
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

export class ExactFixtureDraftCompiler implements DraftCompiler {
  readonly #fixtures: Map<string, DraftFixture>;

  constructor(fixtures: Map<string, DraftFixture>) {
    this.#fixtures = fixtures;
  }

  async compile(agentClaimedRequest: string): Promise<DraftFixture> {
    const normalized = normalizeRequest(agentClaimedRequest);
    const fixture = [...this.#fixtures.values()].find(
      (candidate) => normalizeRequest(candidate.claimedUserRequest) === normalized,
    );
    if (!fixture) {
      throw new CompilerError(
        "clarification_required",
        "I’m not sure how to prepare that safely yet. Could you say it a little differently?",
      );
    }
    return {
      ...structuredClone(fixture),
      claimedUserRequest: agentClaimedRequest,
    };
  }
}

export function createDeterministicDraftCompiler(
  fixtures: Map<string, DraftFixture>,
): DraftCompiler {
  return new ExactFixtureDraftCompiler(fixtures);
}

export class CompilerError extends Error {
  constructor(
    readonly code:
      | "unsupported_request"
      | "clarification_required"
      | "invalid_model_output"
      | "model_unavailable",
    message: string,
    readonly humanMessage?: string,
  ) {
    super(message);
  }
}

const CalendarIntentSchema = z
  .object({
    eventTitleHint: z.string().trim().max(160),
    sourceLocalDateHint: z.string().trim().max(10).nullable(),
    targetLocalDate: z.string().trim().max(10),
    targetLocalStart: z.string().trim().max(5),
    needsClarification: z.boolean(),
    clarificationReason: z.enum([
      "none",
      "missing_event",
      "missing_target_date",
      "missing_target_time",
      "missing_destination",
      "unsupported_action",
      "ambiguous",
    ]),
    clarification: z.string().trim().max(240),
  })
  .strict();

export type CalendarIntent = z.infer<typeof CalendarIntentSchema>;
export const REAL_SOL_MODEL = "gpt-5.6-sol" as const;

export interface CalendarIntentSelector {
  select(agentClaimedRequest: string): Promise<unknown>;
}

export interface RealCalendarResolver {
  discoverEvent(input: {
    titleHint: string;
    sourceLocalDateHint: string | null;
  }): Promise<CalendarEvent>;
}

export class RealCalendarDraftCompiler implements DraftCompiler {
  constructor(
    readonly calendar: RealCalendarResolver,
    readonly selector: CalendarIntentSelector,
  ) {}

  async compile(agentClaimedRequest: string): Promise<DraftFixture> {
    const parsed = CalendarIntentSchema.safeParse(
      await this.selector.select(agentClaimedRequest),
    );
    if (!parsed.success) {
      throw new CompilerError(
        "invalid_model_output",
        "The model did not return one bounded Calendar intent.",
      );
    }
    const intent = parsed.data;
    if (intent.needsClarification) {
      const humanMessage = deterministicIntentClarification(intent);
      throw new CompilerError(
        "clarification_required",
        humanMessage,
        humanMessage,
      );
    }
    if (
      !intent.eventTitleHint ||
      (intent.sourceLocalDateHint !== null &&
        !/^\d{4}-\d{2}-\d{2}$/.test(intent.sourceLocalDateHint)) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(intent.targetLocalDate) ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(intent.targetLocalStart)
    ) {
      throw new CompilerError(
        "invalid_model_output",
        "The model did not return one complete local Calendar time.",
      );
    }

    let event: CalendarEvent;
    try {
      event = await this.calendar.discoverEvent({
        titleHint: intent.eventTitleHint,
        sourceLocalDateHint: intent.sourceLocalDateHint,
      });
    } catch (error) {
      if (error instanceof GoogleCalendarError) {
        const title = safeIntentLabel(intent.eventTitleHint);
        if (error.code === "event_not_found") {
          const humanMessage = `I couldn’t find an eligible upcoming event called “${title}”.\nNothing happened.\nCheck the name or tell OpenClaw which date it is on.`;
          throw new CompilerError(
            "clarification_required",
            humanMessage,
            humanMessage,
          );
        }
        if (error.code === "ambiguous_event_match") {
          const humanMessage = `I found more than one eligible upcoming event called “${title}”.\nNothing happened.\nWhich date did you mean?`;
          throw new CompilerError(
            "clarification_required",
            humanMessage,
            humanMessage,
          );
        }
        if (error.code === "unsupported_event_shape") {
          const humanMessage = `I found “${title}”, but it isn’t a Calendar event Bander can safely move yet.\nNothing happened.`;
          throw new CompilerError(
            "unsupported_request",
            humanMessage,
            humanMessage,
          );
        }
      }
      throw error;
    }
    const newStartTime = resolveLocalStart({
      localDate: intent.targetLocalDate,
      localTime: intent.targetLocalStart,
      timeZone: event.timeZone,
    });
    return {
      id: "real-google-calendar-reschedule",
      claimedUserRequest: agentClaimedRequest,
      calendar: {
        eventId: event.id,
        expectedEtag: event.etag,
        newStartTime,
      },
    };
  }
}

export class OpenAISolIntentSelector implements CalendarIntentSelector {
  readonly #client: OpenAI;
  readonly #calendarTimeZone: string;

  constructor(apiKey: string, calendarTimeZone = "America/Denver") {
    this.#client = new OpenAI({ apiKey, timeout: 15_000, maxRetries: 1 });
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: calendarTimeZone }).format();
    } catch {
      throw new CompilerError("invalid_model_output", "Invalid Calendar timezone configuration");
    }
    this.#calendarTimeZone = calendarTimeZone;
  }

  async select(agentClaimedRequest: string): Promise<unknown> {
    try {
      const response = await this.#client.responses.parse({
        model: REAL_SOL_MODEL,
        store: false,
        reasoning: { effort: "low" },
        max_output_tokens: 300,
        instructions: [
          "Extract one narrow Calendar reschedule intent for Bander.",
          "Return only the event-title hint, optional current/source local date hint, required destination local date, and required destination local start.",
          "Do not choose or emit a Calendar ID, event ID, ETag, end time, duration, effects, execution parameters, approval, or authority.",
          `The connected Calendar's authoritative timezone is ${this.#calendarTimeZone}; resolve dates in that timezone.`,
          `Today's date in that Calendar timezone is ${currentInstallationLocalDate(new Date(), this.#calendarTimeZone)}.`,
          "sourceLocalDateHint identifies the event's current date only when the person actually supplied it; otherwise return null.",
          "targetLocalDate and targetLocalStart describe where the person wants the event moved.",
          "Resolve a month and day without a year to its next unambiguous occurrence relative to today's local date.",
          "If the event title, target date, or target start time is missing or ambiguous, set needsClarification true and leave the missing target field empty.",
          "Set clarificationReason to none for a complete reschedule; otherwise classify only as missing_event, missing_target_date, missing_target_time, missing_destination, unsupported_action, or ambiguous.",
          "Cancellation, deletion, invitation, messaging, spending, and every non-reschedule action are unsupported_action.",
          "You are advisory extraction only. Deterministic Bander code resolves the event and constructs the action.",
        ].join(" "),
        input: agentClaimedRequest,
        text: {
          format: zodTextFormat(CalendarIntentSchema, "bander_calendar_intent"),
        },
      });
      if (!response.output_parsed) {
        throw new CompilerError(
          "model_unavailable",
          "GPT-5.6 Sol did not return a usable Calendar intent.",
        );
      }
      return response.output_parsed;
    } catch (error) {
      if (error instanceof CompilerError) throw error;
      throw new CompilerError(
        "model_unavailable",
        "GPT-5.6 Sol is temporarily unavailable.",
      );
    }
  }
}

function safeIntentLabel(value: string): string {
  return (
    value
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/[“”]/g, '"')
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160) || "that event"
  );
}

function deterministicIntentClarification(intent: CalendarIntent): string {
  const title = safeIntentLabel(intent.eventTitleHint);
  if (!intent.eventTitleHint) {
    return "Which Calendar event would you like to move?\nNothing happened.";
  }
  if (intent.clarificationReason === "unsupported_action") {
    return "I can safely prepare an eligible Calendar reschedule here, but not that kind of action yet.\nNothing happened.";
  }
  if (!intent.targetLocalDate && !intent.targetLocalStart) {
    return `What date and time should I move “${title}” to?\nNothing happened.`;
  }
  if (!intent.targetLocalDate) {
    return `What date should I move “${title}” to?\nNothing happened.`;
  }
  if (!intent.targetLocalStart) {
    return `What time should I move “${title}” to?\nNothing happened.`;
  }
  return `I need one clear destination date and time for “${title}”.\nNothing happened.`;
}

function currentInstallationLocalDate(
  now = new Date(),
  timeZone = "America/Denver",
): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function createRealCalendarDraftCompiler(input: {
  apiKey: string;
  calendar: RealCalendarResolver;
  calendarTimeZone: string;
}): DraftCompiler {
  return new RealCalendarDraftCompiler(
    input.calendar,
    new OpenAISolIntentSelector(input.apiKey, input.calendarTimeZone),
  );
}

export class FixtureDraftCompiler implements DraftCompiler {
  readonly #fixtures: Map<string, DraftFixture>;
  readonly #selector: CandidateSelector;

  constructor(
    fixtures: Map<string, DraftFixture>,
    selector: CandidateSelector,
  ) {
    this.#fixtures = fixtures;
    this.#selector = selector;
  }

  async compile(agentClaimedRequest: string): Promise<DraftFixture> {
    const selection = await this.#selector.select(agentClaimedRequest);
    if (selection.needsClarification) {
      throw new CompilerError(
        "clarification_required",
        selection.clarification || "The request needs clarification before Bander can prepare a deal.",
      );
    }
    if (selection.fixtureId === "unsupported") {
      throw new CompilerError(
        "unsupported_request",
        "That request is outside this local Bander demo.",
      );
    }
    const fixture = this.#fixtures.get(selection.fixtureId);
    if (!fixture) {
      throw new CompilerError("unsupported_request", "Selected fixture is unavailable.");
    }
    return {
      ...structuredClone(fixture),
      claimedUserRequest: agentClaimedRequest,
    };
  }
}

export class OpenAISelector implements CandidateSelector {
  readonly #client: OpenAI;

  constructor(apiKey: string) {
    this.#client = new OpenAI({ apiKey, timeout: 10_000, maxRetries: 1 });
  }

  async select(agentClaimedRequest: string): Promise<Selection> {
    try {
      const response = await this.#client.responses.parse({
        model: "gpt-5.6",
        store: false,
        reasoning: { effort: "low" },
        max_output_tokens: 300,
        instructions: [
          "You are Bander's candidate Draft selector, not an authority system.",
          "Select only an exact matching versioned local fixture.",
          "Use move-dinner-and-notify-sarah only for moving dinner with Sarah to 7:30 and sending the exact late-arrival notice.",
          "Use move-my-focus-block only for moving the owner's solo focus block to 10:30.",
          "Use move-dinner-under-standing-band only for moving dinner with Sarah to 7:30 without a message.",
          "If any material detail differs or is ambiguous, return unsupported or request clarification.",
          "You cannot approve, execute, alter payloads, or enlarge authority.",
        ].join(" "),
        input: agentClaimedRequest,
        text: {
          format: zodTextFormat(SelectionSchema, "bander_fixture_selection"),
        },
      });
      if (!response.output_parsed) {
        throw new CompilerError(
          "model_unavailable",
          "GPT-5.6 did not return a usable candidate.",
        );
      }
      return response.output_parsed;
    } catch (error) {
      if (error instanceof CompilerError) throw error;
      throw new CompilerError(
        "model_unavailable",
        "GPT-5.6 is temporarily unavailable. The deterministic demo still works.",
      );
    }
  }
}

export function createOpenAIDraftCompiler(
  apiKey: string,
  fixtures: Map<string, DraftFixture>,
): DraftCompiler {
  return new FixtureDraftCompiler(fixtures, new OpenAISelector(apiKey));
}
