import OpenAI from "openai";
import { randomBytes } from "node:crypto";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod/v4";
import type { DraftFixture } from "@bander/core";
import type { CalendarEvent } from "@bander/contracts";
import type { FamilyTelegramNotificationEffect } from "@bander/contracts";
import {
  GoogleCalendarError,
  resolveLocalStart,
} from "./google-calendar.js";
import {
  createFamilyNotificationDocument,
  sanitizeFamilyNotificationTitle,
} from "@bander/core";

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
    actionKind: z.enum(["reschedule_event", "create_event", "cancel_event"]),
    eventTitleHint: z.string().trim().max(160),
    sourceLocalDateHint: z.string().trim().max(10).nullable(),
    targetLocalDate: z.string().trim().max(10),
    targetLocalStart: z.string().trim().max(5),
    durationMinutes: z.number().int().nullable(),
    needsClarification: z.boolean(),
    clarificationReason: z.enum([
      "none",
      "missing_event",
      "missing_target_date",
      "missing_target_time",
      "missing_destination",
      "unsupported_action",
      "ambiguous",
      "missing_contact",
      "ambiguous_contact",
      "unpaired_contact",
      "free_form_message_unsupported",
    ]),
    clarification: z.string().trim().max(240),
    familyNotificationRequested: z.boolean(),
    familyContactAlias: z.string().trim().max(80).nullable(),
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

export interface FamilyContactResolver {
  resolve(
    alias: string,
  ): FamilyTelegramNotificationEffect["binding"] | undefined;
  activeDisplayLabel?(): string | undefined;
}

export class RealCalendarDraftCompiler implements DraftCompiler {
  constructor(
    readonly calendar: RealCalendarResolver,
    readonly selector: CalendarIntentSelector,
    readonly familyContacts?: FamilyContactResolver,
    readonly createEventId: () => string = () => `b${randomBytes(16).toString("hex")}`,
    readonly calendarTimeZone = "America/Denver",
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
      const humanMessage = deterministicIntentClarification(
        intent,
        this.familyContacts?.activeDisplayLabel?.(),
      );
      throw new CompilerError(
        "clarification_required",
        humanMessage,
        humanMessage,
      );
    }
    if (
      !intent.eventTitleHint ||
      (intent.sourceLocalDateHint !== null &&
        !/^\d{4}-\d{2}-\d{2}$/.test(intent.sourceLocalDateHint))
    ) {
      throw new CompilerError(
        "invalid_model_output",
        "The model did not return one bounded Calendar event identity.",
      );
    }
    const cancelling = intent.actionKind === "cancel_event";
    if (
      cancelling &&
      (intent.targetLocalDate !== "" ||
        intent.targetLocalStart !== "" ||
        intent.durationMinutes !== null)
    ) {
      throw new CompilerError(
        "invalid_model_output",
        "A Calendar cancellation cannot contain destination or duration fields.",
      );
    }
    if (
      !cancelling &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(intent.targetLocalDate) ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(intent.targetLocalStart))
    ) {
      throw new CompilerError(
        "invalid_model_output",
        "The model did not return one complete local Calendar time.",
      );
    }
    if (
      intent.actionKind === "create_event" &&
      intent.durationMinutes !== null &&
      (intent.durationMinutes < 15 || intent.durationMinutes > 12 * 60)
    ) {
      const humanMessage =
        "Please choose a duration between 15 minutes and 12 hours. Nothing happened.";
      throw new CompilerError("clarification_required", humanMessage, humanMessage);
    }

    let familyBinding: FamilyTelegramNotificationEffect["binding"] | undefined;
    if (intent.familyNotificationRequested) {
      if (!intent.familyContactAlias) {
        const humanMessage =
          "Who should I let know? Please use their name, like Gil.\nNothing happened.";
        throw new CompilerError("clarification_required", humanMessage, humanMessage);
      }
      familyBinding = this.familyContacts?.resolve(intent.familyContactAlias);
      if (!familyBinding) {
        const label = safeIntentLabel(intent.familyContactAlias);
        const activeLabel = this.familyContacts?.activeDisplayLabel?.();
        const humanMessage = activeLabel
          ? `I can’t message ${label} yet. Right now Bander can only message ${safeIntentLabel(activeLabel)}.\nNothing happened.`
          : "I can’t message family yet. Ask the person who set up Bander to connect someone first.\nNothing happened.";
        throw new CompilerError("clarification_required", humanMessage, humanMessage);
      }
    } else if (intent.familyContactAlias !== null) {
      throw new CompilerError(
        "invalid_model_output",
        "The model returned an inconsistent family notification intent.",
      );
    }

    if (intent.actionKind === "create_event") {
      if (intent.sourceLocalDateHint !== null) {
        throw new CompilerError(
          "invalid_model_output",
          "A Calendar creation cannot contain a source event date.",
        );
      }
      const title = sanitizeFamilyNotificationTitle(intent.eventTitleHint);
      if (!title) {
        const humanMessage = "What should I call the Calendar event? Nothing happened.";
        throw new CompilerError("clarification_required", humanMessage, humanMessage);
      }
      const startTime = resolveLocalStart({
        localDate: intent.targetLocalDate,
        localTime: intent.targetLocalStart,
        timeZone: this.calendarTimeZone,
      });
      const durationMinutes = intent.durationMinutes ?? 60;
      const endTime = new Date(
        Date.parse(startTime) + durationMinutes * 60_000,
      ).toISOString();
      const eventId = this.createEventId();
      if (!/^[0-9a-v]{5,1024}$/.test(eventId)) {
        throw new CompilerError(
          "invalid_model_output",
          "Bander could not generate a safe Calendar event identity.",
        );
      }
      const compiled: DraftFixture = {
        id: "real-google-calendar-create",
        claimedUserRequest: agentClaimedRequest,
        calendar: {
          kind: "create",
          eventId,
          title,
          startTime,
          endTime,
          timeZone: this.calendarTimeZone,
        },
      };
      if (intent.familyNotificationRequested) {
        compiled.familyNotification = {
          ...familyBinding!,
          document: createFamilyNotificationDocument({
            kind: "calendar_creation",
            eventTitle: title,
            startTime,
            endTime,
            timeZone: this.calendarTimeZone,
          }),
        };
      }
      return compiled;
    }

    if (intent.actionKind === "reschedule_event" && intent.durationMinutes !== null) {
      throw new CompilerError(
        "invalid_model_output",
        "A Calendar reschedule cannot change the event duration.",
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
          const verb = cancelling ? "remove" : "move";
          const humanMessage = `I found “${title}”, but it isn’t a Calendar event Bander can safely ${verb} yet.\nNothing happened.`;
          throw new CompilerError(
            "unsupported_request",
            humanMessage,
            humanMessage,
          );
        }
      }
      throw error;
    }
    if (cancelling) {
      const compiled: DraftFixture = {
        id: "real-google-calendar-cancel",
        claimedUserRequest: agentClaimedRequest,
        calendar: {
          kind: "cancel",
          eventId: event.id,
          expectedEtag: event.etag,
        },
      };
      if (intent.familyNotificationRequested) {
        compiled.familyNotification = {
          ...familyBinding!,
          document: createFamilyNotificationDocument({
            kind: "calendar_cancellation",
            eventTitle: event.title,
            startTime: event.startTime,
            endTime: event.endTime,
            timeZone: event.timeZone,
          }),
        };
      }
      return compiled;
    }
    const newStartTime = resolveLocalStart({
      localDate: intent.targetLocalDate,
      localTime: intent.targetLocalStart,
      timeZone: event.timeZone,
    });
    const compiled: DraftFixture = {
      id: "real-google-calendar-reschedule",
      claimedUserRequest: agentClaimedRequest,
      calendar: {
        kind: "reschedule",
        eventId: event.id,
        expectedEtag: event.etag,
        newStartTime,
      },
    };
    if (intent.familyNotificationRequested) {
      const duration = Date.parse(event.endTime) - Date.parse(event.startTime);
      const newEndTime = new Date(Date.parse(newStartTime) + duration).toISOString();
      compiled.familyNotification = {
        ...familyBinding!,
        document: createFamilyNotificationDocument({
          eventTitle: event.title,
          newStartTime,
          newEndTime,
          timeZone: event.timeZone,
        }),
      };
    }
    return compiled;
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
          "Extract one narrow Calendar action for Bander: reschedule_event, create_event, or cancel_event.",
          "Return only the action kind, event-title hint, optional current/source local date hint, destination local date/start for create or reschedule, and optional duration minutes for creation.",
          "Also say whether the person requested a notification to one already-connected family contact and, if so, return only the human alias they used.",
          "Do not choose or emit a Calendar ID, event ID, ETag, end time, duration, recipient address, Telegram ID, chat ID, username, message body, effects, execution order, execution parameters, approval, authority, callback, permit, receipt, or idempotency value.",
          `The connected Calendar's authoritative timezone is ${this.#calendarTimeZone}; resolve dates in that timezone.`,
          `Today's date in that Calendar timezone is ${currentInstallationLocalDate(new Date(), this.#calendarTimeZone)}.`,
          "sourceLocalDateHint identifies an existing event's current date for reschedule_event or cancel_event only when the person supplied it; for create_event always return null.",
          "For cancel_event, targetLocalDate and targetLocalStart must be empty strings and durationMinutes must be null.",
          "For create_event or reschedule_event, targetLocalDate and targetLocalStart describe the requested destination.",
          "Resolve a month and day without a year to its next unambiguous occurrence relative to today's local date.",
          "For create_event, durationMinutes is the explicit duration when clearly requested, otherwise null so Bander applies its disclosed 60-minute default. Never infer a duration from the title.",
          "If the event title, target date, or target start time is missing or ambiguous, set needsClarification true and leave the missing target field empty.",
          "Set clarificationReason to none for a complete supported action; otherwise classify only as missing_event, missing_target_date, missing_target_time, missing_destination, unsupported_action, or ambiguous.",
          "A Calendar create, reschedule, or removal plus a short deterministic Bander update to one connected family alias is supported. 'Remove the dentist event from my calendar' is cancel_event. 'Cancel my appointment with the clinic' or 'call the clinic and cancel' is unsupported because it may mean contacting an external party. Booking or cancelling a reservation, order, subscription, ride, or non-Calendar appointment is unsupported. Bulk, multiple-event, all-day, recurring, attendee-bearing, externally organized, arbitrary-message, pronoun-only contact, and multiple-contact requests are unsupported or ambiguous.",
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

function deterministicIntentClarification(
  intent: CalendarIntent,
  activeFamilyDisplayLabel?: string,
): string {
  const title = safeIntentLabel(intent.eventTitleHint);
  if (!intent.eventTitleHint) {
    return intent.actionKind === "create_event"
      ? "What should I call the Calendar event?\nNothing happened."
      : "Which Calendar event would you like to move?\nNothing happened.";
  }
  if (intent.clarificationReason === "unsupported_action") {
    return "I can add, move, or remove one eligible Calendar event, but I can’t contact a business, cancel reservations, handle recurring events, or remove events in bulk.\nNothing happened.";
  }
  if (intent.clarificationReason === "missing_contact") {
    return "Who should I let know? Please use their name, like Gil.\nNothing happened.";
  }
  if (intent.clarificationReason === "ambiguous_contact") {
    return "Who should I let know? Please use their name, like Gil.\nNothing happened.";
  }
  if (intent.clarificationReason === "unpaired_contact") {
    return activeFamilyDisplayLabel
      ? `I can’t message that person yet. Right now Bander can only message ${safeIntentLabel(activeFamilyDisplayLabel)}.\nNothing happened.`
      : "I can’t message family yet. Ask the person who set up Bander to connect someone first.\nNothing happened.";
  }
  if (intent.clarificationReason === "free_form_message_unsupported") {
    return "I can include Bander’s exact appointment update, but I can’t send a custom message.\nNothing happened.";
  }
  if (!intent.targetLocalDate && !intent.targetLocalStart) {
    return intent.actionKind === "create_event"
      ? `What date and time should I add “${title}”?\nNothing happened.`
      : `What date and time should I move “${title}” to?\nNothing happened.`;
  }
  if (!intent.targetLocalDate) {
    return intent.actionKind === "create_event"
      ? `What date should I add “${title}”?\nNothing happened.`
      : `What date should I move “${title}” to?\nNothing happened.`;
  }
  if (!intent.targetLocalStart) {
    return intent.actionKind === "create_event"
      ? `What time should I add “${title}”?\nNothing happened.`
      : `What time should I move “${title}” to?\nNothing happened.`;
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
  familyContacts?: FamilyContactResolver;
}): DraftCompiler {
  return new RealCalendarDraftCompiler(
    input.calendar,
    new OpenAISolIntentSelector(input.apiKey, input.calendarTimeZone),
    input.familyContacts,
    undefined,
    input.calendarTimeZone,
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
