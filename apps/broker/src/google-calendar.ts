import type {
  CalendarCancelEffect,
  CalendarEvent,
  CalendarCreateEffect,
  CalendarRescheduleEffect,
  DraftDocument,
  Person,
  ScheduleReadEvent,
  ScheduleReadResult,
  ObservedExecutionResult,
} from "@bander/contracts";
import {
  ExecutionAlreadyAbsentError,
  ExecutionAmbiguousError,
  ExecutionConflictError,
  ExecutionRejectedError,
  type ExecutionAdapter,
} from "@bander/core";
import { google } from "googleapis";
import {
  localDateRangeToInstants,
  sanitizeScheduleTitle,
} from "./read-schedule.js";

type GoogleOAuth2Client = InstanceType<typeof google.auth.OAuth2>;

export interface GoogleEventResource {
  id?: string | null;
  etag?: string | null;
  summary?: string | null;
  status?: string | null;
  recurringEventId?: string | null;
  recurrence?: string[] | null;
  eventType?: string | null;
  location?: string | null;
  description?: string | null;
  conferenceData?: unknown;
  attachments?: unknown[] | null;
  reminders?: { useDefault?: boolean | null; overrides?: unknown[] | null } | null;
  sequence?: number | null;
  organizer?: { self?: boolean | null; email?: string | null } | null;
  attendees?: Array<{ self?: boolean | null; email?: string | null }> | null;
  start?: { date?: string | null; dateTime?: string | null; timeZone?: string | null } | null;
  end?: { date?: string | null; dateTime?: string | null; timeZone?: string | null } | null;
}

export interface GoogleCalendarBoundary {
  listEvents(input: {
    calendarId: "primary";
    timeMin: string;
    timeMax: string;
  }): Promise<GoogleEventResource[]>;
  getPrimaryTimeZone(): Promise<string>;
  listScheduleEvents(input: {
    calendarId: "primary";
    timeMin: string;
    timeMax: string;
    timeZone: string;
    maxResults: number;
  }): Promise<{
    events: GoogleEventResource[];
    timeZone: string;
    truncated: boolean;
  }>;
  getEvent(input: {
    calendarId: "primary";
    eventId: string;
  }): Promise<GoogleEventResource>;
  patchEvent(input: {
    calendarId: "primary";
    eventId: string;
    sendUpdates: "none";
    requestBody: {
      start: { dateTime: string; timeZone: string };
      end: { dateTime: string; timeZone: string };
    };
    ifMatch: string;
  }): Promise<GoogleEventResource>;
  insertEvent(input: {
    calendarId: "primary";
    sendUpdates: "none";
    conferenceDataVersion: 0;
    supportsAttachments: false;
    requestBody: {
      id: string;
      summary: string;
      eventType: "default";
      start: { dateTime: string; timeZone: string };
      end: { dateTime: string; timeZone: string };
    };
  }): Promise<GoogleEventResource>;
  deleteEvent(input: {
    calendarId: "primary";
    eventId: string;
    sendUpdates: "none";
    ifMatch: string;
  }): Promise<void>;
}

export class GoogleCalendarError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function normalize(value: string): string {
  return sanitizeScheduleTitle(value).toLocaleLowerCase("en-US");
}

function localDateOf(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).formatToParts(new Date(instant));
  const part = (name: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === name)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
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

export function resolveLocalStart(input: {
  localDate: string;
  localTime: string;
  timeZone: string;
}): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.localDate) ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.localTime)
  ) {
    throw new GoogleCalendarError(
      "invalid_local_start",
      "Bander requires one complete, minute-precise local start",
    );
  }
  const center = Date.parse(`${input.localDate}T${input.localTime}:00.000Z`);
  const matches: string[] = [];
  for (
    let candidate = center - 18 * 60 * 60_000;
    candidate <= center + 18 * 60 * 60_000;
    candidate += 60_000
  ) {
    const instant = new Date(candidate).toISOString();
    const local = localMinuteParts(instant, input.timeZone);
    if (local.date === input.localDate && local.time === input.localTime) {
      matches.push(instant);
    }
  }
  if (matches.length !== 1) {
    throw new GoogleCalendarError(
      "ambiguous_local_start",
      "The requested local start is missing or ambiguous in this timezone",
    );
  }
  return matches[0]!;
}

function discoveryWindow(localDate: string): { timeMin: string; timeMax: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    throw new GoogleCalendarError(
      "invalid_date_hint",
      "Bander requires one complete local Calendar date",
    );
  }
  const midnightUtc = Date.parse(`${localDate}T00:00:00.000Z`);
  if (!Number.isFinite(midnightUtc)) {
    throw new GoogleCalendarError(
      "invalid_date_hint",
      "Bander requires one complete local Calendar date",
    );
  }
  // Every IANA offset falls inside this deliberately broad UTC window. The
  // authoritative local-date comparison below performs the actual selection.
  return {
    timeMin: new Date(midnightUtc - 18 * 60 * 60_000).toISOString(),
    timeMax: new Date(midnightUtc + 42 * 60 * 60_000).toISOString(),
  };
}

function upcomingDiscoveryWindow(now: Date): { timeMin: string; timeMax: string } {
  if (!Number.isFinite(now.getTime())) {
    throw new GoogleCalendarError(
      "invalid_discovery_clock",
      "Bander could not establish the upcoming Calendar window",
    );
  }
  return {
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + 31 * 24 * 60 * 60_000).toISOString(),
  };
}

function isUnsupported(resource: GoogleEventResource): boolean {
  return (
    resource.status === "cancelled" ||
    !resource.id ||
    !resource.etag ||
    !resource.summary ||
    !resource.start?.dateTime ||
    !resource.end?.dateTime ||
    Boolean(resource.start.date || resource.end.date) ||
    Boolean(resource.recurringEventId) ||
    Boolean(resource.recurrence?.length) ||
    (resource.eventType !== undefined &&
      resource.eventType !== null &&
      resource.eventType !== "default") ||
    resource.organizer?.self !== true ||
    Boolean(resource.attendees?.length)
  );
}

function toCalendarEvent(resource: GoogleEventResource): CalendarEvent {
  if (isUnsupported(resource)) {
    throw new GoogleCalendarError(
      "unsupported_event_shape",
      "Bander only supports one timed, non-recurring, owner-organized event with no attendees",
    );
  }
  const timeZone =
    resource.start!.timeZone ??
    resource.end!.timeZone;
  if (!timeZone) {
    throw new GoogleCalendarError(
      "unsupported_event_shape",
      "The Calendar event has no authoritative timezone",
    );
  }
  const startTime = resource.start!.dateTime!;
  const endTime = resource.end!.dateTime!;
  if (
    !Number.isFinite(Date.parse(startTime)) ||
    !Number.isFinite(Date.parse(endTime)) ||
    Date.parse(endTime) <= Date.parse(startTime)
  ) {
    throw new GoogleCalendarError(
      "unsupported_event_shape",
      "The Calendar event has an invalid interval",
    );
  }
  return {
    id: resource.id!,
    title: sanitizeScheduleTitle(resource.summary!),
    startTime,
    endTime,
    timeZone,
    organizerId: "google-primary-owner",
    attendeeIds: [],
    revision: resource.sequence ?? 0,
    etag: resource.etag!,
  };
}

function responseStatus(error: unknown): number | undefined {
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

function exactCreatedEvent(
  resource: GoogleEventResource,
  effect: CalendarCreateEffect,
): boolean {
  return (
    resource.id === effect.eventId &&
    resource.summary === effect.title &&
    resource.status !== "cancelled" &&
    (resource.eventType ?? "default") === "default" &&
    sameInstant(resource.start?.dateTime, effect.startTime) &&
    sameInstant(resource.end?.dateTime, effect.endTime) &&
    resource.start?.timeZone === effect.timeZone &&
    resource.end?.timeZone === effect.timeZone &&
    !resource.start?.date &&
    !resource.end?.date &&
    !resource.attendees?.length &&
    !resource.recurrence?.length &&
    !resource.recurringEventId &&
    !resource.location &&
    !resource.description &&
    !resource.conferenceData &&
    !resource.attachments?.length &&
    !resource.reminders?.overrides?.length
  );
}

function scheduleLocalParts(instant: string, timeZone: string) {
  if (!Number.isFinite(Date.parse(instant))) {
    throw new GoogleCalendarError(
      "unsupported_schedule_event",
      "Google Calendar returned an invalid event time",
    );
  }
  return localMinuteParts(new Date(instant).toISOString(), timeZone);
}

function scheduleEvent(resource: GoogleEventResource, timeZone: string): ScheduleReadEvent {
  const title = sanitizeScheduleTitle(resource.summary);
  const startDate = resource.start?.date;
  const endDate = resource.end?.date;
  const startDateTime = resource.start?.dateTime;
  const endDateTime = resource.end?.dateTime;
  if (
    startDate &&
    endDate &&
    !startDateTime &&
    !endDateTime &&
    /^\d{4}-\d{2}-\d{2}$/.test(startDate) &&
    /^\d{4}-\d{2}-\d{2}$/.test(endDate) &&
    Date.parse(`${endDate}T00:00:00.000Z`) >
      Date.parse(`${startDate}T00:00:00.000Z`)
  ) {
    return {
      title,
      allDay: true,
      startLocalDate: startDate,
      endLocalDateExclusive: endDate,
    };
  }
  if (startDateTime && endDateTime && !startDate && !endDate) {
    const start = scheduleLocalParts(startDateTime, timeZone);
    const end = scheduleLocalParts(endDateTime, timeZone);
    if (Date.parse(endDateTime) <= Date.parse(startDateTime)) {
      throw new GoogleCalendarError(
        "unsupported_schedule_event",
        "Google Calendar returned an invalid event interval",
      );
    }
    return {
      title,
      allDay: false,
      start: { localDate: start.date, localTime: start.time },
      end: { localDate: end.date, localTime: end.time },
    };
  }
  throw new GoogleCalendarError(
    "unsupported_schedule_event",
    "Google Calendar returned an unsupported event interval",
  );
}

function scheduleSortKey(event: ScheduleReadEvent): string {
  return event.allDay
    ? `${event.startLocalDate}T00:00:00|0|${event.title}`
    : `${event.start.localDate}T${event.start.localTime}:00|1|${event.title}`;
}

export class GoogleCalendarAdapter implements ExecutionAdapter {
  readonly #executions = new Map<
    string,
    { draftHash: string; result: ObservedExecutionResult }
  >();
  readonly #createDispatches = new Map<string, string>();
  readonly #cancelDispatches = new Map<string, string>();
  #primaryTimeZone: string | undefined;

  constructor(
    readonly boundary: GoogleCalendarBoundary,
    readonly now: () => Date = () => new Date(),
  ) {}

  async getAuthoritativeTimeZone(): Promise<string> {
    if (this.#primaryTimeZone) return this.#primaryTimeZone;
    let timeZone: string;
    try {
      timeZone = await this.boundary.getPrimaryTimeZone();
      new Intl.DateTimeFormat("en-US", { timeZone }).format();
    } catch {
      throw new GoogleCalendarError(
        "google_calendar_unavailable",
        "Google Calendar could not provide its authoritative timezone",
      );
    }
    this.#primaryTimeZone = timeZone;
    return timeZone;
  }

  async readSchedule(input: {
    startLocalDate: string;
    endLocalDateExclusive: string;
    timeZone: string;
    maxEvents: number;
  }): Promise<ScheduleReadResult> {
    if (
      input.maxEvents < 1 ||
      input.maxEvents > 50 ||
      input.timeZone !== (await this.getAuthoritativeTimeZone())
    ) {
      throw new GoogleCalendarError(
        "invalid_schedule_read",
        "Bander rejected an invalid schedule read",
      );
    }
    const instants = localDateRangeToInstants(input);
    let page;
    try {
      page = await this.boundary.listScheduleEvents({
        calendarId: "primary",
        ...instants,
        timeZone: input.timeZone,
        maxResults: input.maxEvents + 1,
      });
    } catch (error) {
      if (
        error instanceof GoogleCalendarError &&
        error.code !== "google_calendar_response_mismatch"
      ) {
        throw error;
      }
      throw new GoogleCalendarError(
        "google_calendar_unavailable",
        "Google Calendar is temporarily unavailable",
      );
    }
    if (page.timeZone !== input.timeZone) {
      throw new GoogleCalendarError(
        "google_calendar_timezone_mismatch",
        "Google Calendar returned an unexpected timezone",
      );
    }
    const mapped = page.events
      .filter((resource) => resource.status !== "cancelled")
      .map((resource) => scheduleEvent(resource, input.timeZone))
      .sort((left, right) => scheduleSortKey(left).localeCompare(scheduleSortKey(right)));
    const events = mapped.slice(0, input.maxEvents);
    return {
      requestedRange: {
        startLocalDate: input.startLocalDate,
        endLocalDateExclusive: input.endLocalDateExclusive,
      },
      timeZone: input.timeZone,
      events,
      empty: events.length === 0,
      truncated: page.truncated || mapped.length > input.maxEvents,
      maxEvents: input.maxEvents,
    };
  }

  async discoverEvent(input: {
    titleHint: string;
    sourceLocalDateHint: string | null;
  }): Promise<CalendarEvent> {
    const window = input.sourceLocalDateHint
      ? discoveryWindow(input.sourceLocalDateHint)
      : upcomingDiscoveryWindow(this.now());
    let resources: GoogleEventResource[];
    try {
      resources = await this.boundary.listEvents({
        calendarId: "primary",
        ...window,
      });
    } catch {
      throw new GoogleCalendarError(
        "google_calendar_unavailable",
        "Google Calendar is temporarily unavailable",
      );
    }
    const titleMatches = resources.filter(
      (resource) =>
        typeof resource.summary === "string" &&
        normalize(resource.summary) === normalize(input.titleHint),
    );
    const sourceMatches = titleMatches.filter((resource) => {
      if (!input.sourceLocalDateHint) return true;
      const start = resource.start?.dateTime ?? resource.start?.date;
      if (!start) return false;
      if (resource.start?.date) return start === input.sourceLocalDateHint;
      const resourceTimeZone =
        resource.start?.timeZone ?? resource.end?.timeZone;
      if (!resourceTimeZone) return false;
      return localDateOf(start, resourceTimeZone) === input.sourceLocalDateHint;
    });
    const eligibleMatches: CalendarEvent[] = [];
    let unsupportedMatches = 0;
    for (const resource of sourceMatches) {
      try {
        eligibleMatches.push(toCalendarEvent(resource));
      } catch (error) {
        if (
          error instanceof GoogleCalendarError &&
          error.code === "unsupported_event_shape"
        ) {
          unsupportedMatches += 1;
          continue;
        }
        throw error;
      }
    }
    if (eligibleMatches.length === 0) {
      if (unsupportedMatches > 0) {
        throw new GoogleCalendarError(
          "unsupported_event_shape",
          "The matching Calendar event is not eligible for Bander",
        );
      }
      throw new GoogleCalendarError(
        "event_not_found",
        "Bander could not find one eligible Calendar event",
      );
    }
    if (eligibleMatches.length > 1) {
      throw new GoogleCalendarError(
        "ambiguous_event_match",
        "Bander could not identify exactly one eligible Calendar event",
      );
    }
    return eligibleMatches[0]!;
  }

  async resolveEvent(id: string): Promise<CalendarEvent> {
    try {
      const resource = await this.boundary.getEvent({
        calendarId: "primary",
        eventId: id,
      });
      return toCalendarEvent(resource);
    } catch (error) {
      if (error instanceof GoogleCalendarError) throw error;
      throw new GoogleCalendarError(
        "google_calendar_unavailable",
        "Google Calendar is temporarily unavailable",
      );
    }
  }

  async resolvePerson(_id: string): Promise<Person> {
    throw new Error("Google Calendar does not provide a Messages identity");
  }

  async executeDraft(input: {
    draftHash: string;
    permitNonce: string;
    document: DraftDocument;
  }): Promise<ObservedExecutionResult> {
    const existing = this.#executions.get(input.permitNonce);
    if (existing) {
      if (existing.draftHash !== input.draftHash) {
        throw new GoogleCalendarError(
          "google_execution_identity_mismatch",
          "The Calendar execution identity does not match the approved deal",
        );
      }
      return structuredClone(existing.result);
    }
    const created = input.document.effects.find(
      (effect): effect is CalendarCreateEffect =>
        effect.type === "calendar.create_event",
    );
    if (created) {
      return this.#executeCreate(input, created);
    }
    const cancelled = input.document.effects.find(
      (effect): effect is CalendarCancelEffect =>
        effect.type === "calendar.cancel_event",
    );
    if (cancelled) {
      return this.#executeCancel(input, cancelled);
    }
    const calendar = input.document.effects.find(
      (effect): effect is CalendarRescheduleEffect =>
        effect.type === "calendar.reschedule_event",
    );
    if (
      input.document.effects.length !== 1 ||
      !calendar ||
      calendar.expected.organizerId !== "google-primary-owner" ||
      calendar.expected.attendeeIds.length !== 0 ||
      !calendar.expected.etag ||
      !calendar.expected.timeZone
    ) {
      throw new GoogleCalendarError(
        "unsupported_real_execution_shape",
        "Real mode accepts exactly one eligible Calendar reschedule",
      );
    }
    if (
      Date.parse(calendar.changes.endTime) - Date.parse(calendar.changes.startTime) !==
        Date.parse(calendar.expected.endTime) - Date.parse(calendar.expected.startTime) ||
      Date.parse(calendar.changes.endTime) <= Date.parse(calendar.changes.startTime)
    ) {
      throw new GoogleCalendarError(
        "unsupported_real_execution_shape",
        "The approved Calendar duration must remain unchanged",
      );
    }
    const committedResult = (
      status: "committed" | "observed_target",
    ): ObservedExecutionResult => ({
      calendar: {
        status,
        completed: {
          startTime: calendar.changes.startTime,
          endTime: calendar.changes.endTime,
          timeZone: calendar.expected.timeZone,
        },
      },
    });
    try {
      const committed = await this.boundary.patchEvent({
        calendarId: "primary",
        eventId: calendar.eventId,
        sendUpdates: "none",
        ifMatch: calendar.expected.etag,
        requestBody: {
          start: {
            dateTime: calendar.changes.startTime,
            timeZone: calendar.expected.timeZone,
          },
          end: {
            dateTime: calendar.changes.endTime,
            timeZone: calendar.expected.timeZone,
          },
        },
      });
      const actual = toCalendarEvent(committed);
      if (
        actual.id !== calendar.eventId ||
        !sameInstant(actual.startTime, calendar.changes.startTime) ||
        !sameInstant(actual.endTime, calendar.changes.endTime) ||
        actual.timeZone !== calendar.expected.timeZone
      ) {
        throw new GoogleCalendarError(
          "google_calendar_response_mismatch",
          "Google Calendar did not return the approved interval",
        );
      }
      const result = committedResult("committed");
      this.#executions.set(input.permitNonce, {
        draftHash: input.draftHash,
        result,
      });
      return result;
    } catch (error) {
      if (responseStatus(error) === 412) throw new ExecutionConflictError();
      const status = responseStatus(error);
      if (status && status >= 400 && status < 500 && ![408, 429].includes(status)) {
        throw new GoogleCalendarError(
          "google_calendar_unavailable",
          "Google Calendar rejected the approved update",
        );
      }
      try {
        const current = await this.resolveEvent(calendar.eventId);
        if (
          sameInstant(current.startTime, calendar.changes.startTime) &&
          sameInstant(current.endTime, calendar.changes.endTime) &&
          current.timeZone === calendar.expected.timeZone
        ) {
          const result = committedResult("observed_target");
          this.#executions.set(input.permitNonce, {
            draftHash: input.draftHash,
            result,
          });
          return result;
        }
      } catch {
        // The causal result remains unknowable. Never issue another patch.
      }
      throw new ExecutionAmbiguousError();
    }
  }

  async #executeCreate(
    input: { draftHash: string; permitNonce: string; document: DraftDocument },
    created: CalendarCreateEffect,
  ): Promise<ObservedExecutionResult> {
    if (
      input.document.effects.length !== 1 ||
      created.calendarId !== "primary" ||
      created.eventType !== "default" ||
      !/^[0-9a-v]{5,1024}$/.test(created.eventId) ||
      !created.title ||
      Date.parse(created.endTime) <= Date.parse(created.startTime) ||
      Date.parse(created.endTime) - Date.parse(created.startTime) < 15 * 60_000 ||
      Date.parse(created.endTime) - Date.parse(created.startTime) > 12 * 60 * 60_000
    ) {
      throw new GoogleCalendarError(
        "unsupported_real_execution_shape",
        "Real mode accepts one bounded Calendar creation",
      );
    }
    const priorDispatch = this.#createDispatches.get(input.permitNonce);
    if (priorDispatch) {
      if (priorDispatch !== input.draftHash) {
        throw new GoogleCalendarError(
          "google_execution_identity_mismatch",
          "The Calendar execution identity does not match the approved deal",
        );
      }
      return this.#reconcileCreate(created, input, false);
    }
    this.#createDispatches.set(input.permitNonce, input.draftHash);
    try {
      const response = await this.boundary.insertEvent({
        calendarId: "primary",
        sendUpdates: "none",
        conferenceDataVersion: 0,
        supportsAttachments: false,
        requestBody: {
          id: created.eventId,
          summary: created.title,
          eventType: "default",
          start: { dateTime: created.startTime, timeZone: created.timeZone },
          end: { dateTime: created.endTime, timeZone: created.timeZone },
        },
      });
      if (!exactCreatedEvent(response, created)) {
        throw new GoogleCalendarError(
          "google_calendar_response_mismatch",
          "Google Calendar did not return the exact approved event",
        );
      }
      return this.#recordCreateResult(input, created, "committed");
    } catch (error) {
      const status = responseStatus(error);
      if (status === 409) {
        return this.#reconcileCreate(created, input, true);
      }
      if (status && status >= 400 && status < 500 && ![408, 429].includes(status)) {
        throw new ExecutionRejectedError("create");
      }
      return this.#reconcileCreate(created, input, false);
    }
  }

  async #reconcileCreate(
    created: CalendarCreateEffect,
    input: { draftHash: string; permitNonce: string },
    duplicateId: boolean,
  ): Promise<ObservedExecutionResult> {
    try {
      const resource = await this.boundary.getEvent({
        calendarId: "primary",
        eventId: created.eventId,
      });
      if (!exactCreatedEvent(resource, created)) {
        throw new GoogleCalendarError(
          "google_event_identity_collision",
          "The approved Calendar event identity exists with different content",
        );
      }
      return this.#recordCreateResult(input, created, "observed_target");
    } catch (error) {
      if (
        error instanceof GoogleCalendarError &&
        error.code === "google_event_identity_collision"
      ) {
        throw error;
      }
      if (duplicateId) {
        throw new GoogleCalendarError(
          "google_event_identity_collision",
          "Google reported a duplicate event identity that Bander could not validate",
        );
      }
      throw new ExecutionAmbiguousError();
    }
  }

  #recordCreateResult(
    input: { draftHash: string; permitNonce: string },
    created: CalendarCreateEffect,
    status: "committed" | "observed_target",
  ): ObservedExecutionResult {
    const result: ObservedExecutionResult = {
      calendar: {
        action: "created",
        status,
        completed: {
          startTime: created.startTime,
          endTime: created.endTime,
          timeZone: created.timeZone,
        },
      },
    };
    this.#executions.set(input.permitNonce, {
      draftHash: input.draftHash,
      result,
    });
    return structuredClone(result);
  }

  async #executeCancel(
    input: { draftHash: string; permitNonce: string; document: DraftDocument },
    cancelled: CalendarCancelEffect,
  ): Promise<ObservedExecutionResult> {
    if (
      input.document.effects.length !== 1 ||
      cancelled.calendarId !== "primary" ||
      !cancelled.eventId ||
      !cancelled.expected.etag ||
      !cancelled.expected.title ||
      cancelled.expected.eventType !== "default" ||
      cancelled.expected.organizerMustBeOwner !== true ||
      cancelled.expected.attendeeIdsExactly.length !== 0 ||
      cancelled.expected.recurring !== false ||
      !cancelled.expected.timeZone ||
      !Number.isFinite(Date.parse(cancelled.expected.startTime)) ||
      !Number.isFinite(Date.parse(cancelled.expected.endTime)) ||
      Date.parse(cancelled.expected.endTime) <= Date.parse(cancelled.expected.startTime)
    ) {
      throw new GoogleCalendarError(
        "unsupported_real_execution_shape",
        "Real mode accepts one bounded Calendar cancellation",
      );
    }
    const priorDispatch = this.#cancelDispatches.get(input.permitNonce);
    if (priorDispatch) {
      if (priorDispatch !== input.draftHash) {
        throw new GoogleCalendarError(
          "google_execution_identity_mismatch",
          "The Calendar execution identity does not match the approved deal",
        );
      }
      return this.#reconcileCancel(cancelled, input);
    }
    this.#cancelDispatches.set(input.permitNonce, input.draftHash);
    try {
      await this.boundary.deleteEvent({
        calendarId: "primary",
        eventId: cancelled.eventId,
        sendUpdates: "none",
        ifMatch: cancelled.expected.etag,
      });
      return this.#recordCancelResult(input, cancelled, "committed");
    } catch (error) {
      const status = responseStatus(error);
      if (status === 412) throw new ExecutionConflictError();
      if (status === 404 || status === 410) {
        throw new ExecutionAlreadyAbsentError();
      }
      if (status && status >= 400 && status < 500 && ![408, 429].includes(status)) {
        throw new ExecutionRejectedError("cancel");
      }
      return this.#reconcileCancel(cancelled, input);
    }
  }

  async #reconcileCancel(
    cancelled: CalendarCancelEffect,
    input: { draftHash: string; permitNonce: string },
  ): Promise<ObservedExecutionResult> {
    try {
      const resource = await this.boundary.getEvent({
        calendarId: "primary",
        eventId: cancelled.eventId,
      });
      if (resource.id === cancelled.eventId && resource.status === "cancelled") {
        return this.#recordCancelResult(input, cancelled, "observed_target");
      }
      throw new ExecutionAmbiguousError();
    } catch (error) {
      const status = responseStatus(error);
      if (status === 404 || status === 410) {
        return this.#recordCancelResult(input, cancelled, "observed_target");
      }
      if (error instanceof ExecutionAmbiguousError) throw error;
      throw new ExecutionAmbiguousError();
    }
  }

  #recordCancelResult(
    input: { draftHash: string; permitNonce: string },
    cancelled: CalendarCancelEffect,
    status: "committed" | "observed_target",
  ): ObservedExecutionResult {
    const result: ObservedExecutionResult = {
      calendar: {
        action: "removed",
        status,
        completed: {
          startTime: cancelled.expected.startTime,
          endTime: cancelled.expected.endTime,
          timeZone: cancelled.expected.timeZone,
        },
      },
    };
    this.#executions.set(input.permitNonce, {
      draftHash: input.draftHash,
      result,
    });
    return structuredClone(result);
  }

  async getExecution(_input: {
    draftHash: string;
    permitNonce: string;
    document: DraftDocument;
  }): Promise<boolean | ObservedExecutionResult> {
    const execution = this.#executions.get(_input.permitNonce);
    if (execution?.draftHash === _input.draftHash) {
      return structuredClone(execution.result);
    }
    const created = _input.document.effects.find(
      (effect): effect is CalendarCreateEffect => effect.type === "calendar.create_event",
    );
    if (created && _input.document.effects.length === 1) {
      if (this.#createDispatches.get(_input.permitNonce) !== _input.draftHash) {
        return false;
      }
      try {
        return await this.#reconcileCreate(created, _input, false);
      } catch (error) {
        if (error instanceof ExecutionAmbiguousError) return false;
        throw error;
      }
    }
    const cancelled = _input.document.effects.find(
      (effect): effect is CalendarCancelEffect =>
        effect.type === "calendar.cancel_event",
    );
    if (cancelled && _input.document.effects.length === 1) {
      if (this.#cancelDispatches.get(_input.permitNonce) !== _input.draftHash) {
        return false;
      }
      try {
        return await this.#reconcileCancel(cancelled, _input);
      } catch (error) {
        if (error instanceof ExecutionAmbiguousError) return false;
        throw error;
      }
    }
    const calendar = _input.document.effects.find(
      (effect): effect is CalendarRescheduleEffect =>
        effect.type === "calendar.reschedule_event",
    );
    if (!calendar || _input.document.effects.length !== 1) return false;
    const current = await this.resolveEvent(calendar.eventId);
    if (
      !sameInstant(current.startTime, calendar.changes.startTime) ||
      !sameInstant(current.endTime, calendar.changes.endTime) ||
      current.timeZone !== calendar.expected.timeZone
    ) {
      return false;
    }
    const result: ObservedExecutionResult = {
      calendar: {
        status: "observed_target",
        completed: {
          startTime: calendar.changes.startTime,
          endTime: calendar.changes.endTime,
          timeZone: calendar.expected.timeZone,
        },
      },
    };
    this.#executions.set(_input.permitNonce, {
      draftHash: _input.draftHash,
      result,
    });
    return structuredClone(result);
  }
}

export function createGoogleCalendarBoundary(
  auth: GoogleOAuth2Client,
): GoogleCalendarBoundary {
  const calendar = google.calendar({ version: "v3", auth });
  return {
    async listEvents(input) {
      const events: GoogleEventResource[] = [];
      const seenPageTokens = new Set<string>();
      let pageToken: string | undefined;
      do {
        const response = await calendar.events.list({
          calendarId: input.calendarId,
          timeMin: input.timeMin,
          timeMax: input.timeMax,
          singleEvents: false,
          showDeleted: false,
          maxResults: 2500,
          ...(pageToken ? { pageToken } : {}),
        });
        events.push(...(response.data.items ?? []));
        const nextPageToken = response.data.nextPageToken ?? undefined;
        if (nextPageToken && seenPageTokens.has(nextPageToken)) {
          throw new GoogleCalendarError(
            "google_calendar_pagination_invalid",
            "Google Calendar returned an invalid pagination sequence",
          );
        }
        if (nextPageToken) seenPageTokens.add(nextPageToken);
        pageToken = nextPageToken;
      } while (pageToken);
      return events;
    },
    async getPrimaryTimeZone() {
      const response = await calendar.events.list({
        calendarId: "primary",
        maxResults: 1,
        showDeleted: false,
        fields: "timeZone",
      });
      const timeZone = response.data.timeZone;
      if (!timeZone) {
        throw new GoogleCalendarError(
          "google_calendar_timezone_missing",
          "Google Calendar did not return its timezone",
        );
      }
      return timeZone;
    },
    async listScheduleEvents(input) {
      const response = await calendar.events.list({
        calendarId: input.calendarId,
        timeMin: input.timeMin,
        timeMax: input.timeMax,
        timeZone: input.timeZone,
        singleEvents: true,
        orderBy: "startTime",
        showDeleted: false,
        maxResults: input.maxResults,
        fields: "timeZone,nextPageToken,items(summary,status,start,end)",
      });
      const timeZone = response.data.timeZone;
      if (!timeZone) {
        throw new GoogleCalendarError(
          "google_calendar_timezone_missing",
          "Google Calendar did not return its timezone",
        );
      }
      return {
        events: response.data.items ?? [],
        timeZone,
        truncated: Boolean(response.data.nextPageToken),
      };
    },
    async getEvent(input) {
      const response = await calendar.events.get({
        calendarId: input.calendarId,
        eventId: input.eventId,
      });
      return response.data;
    },
    async patchEvent(input) {
      const response = await calendar.events.patch(
        {
          calendarId: input.calendarId,
          eventId: input.eventId,
          sendUpdates: input.sendUpdates,
          requestBody: input.requestBody,
        },
        { headers: { "If-Match": input.ifMatch } },
      );
      return response.data;
    },
    async insertEvent(input) {
      const response = await calendar.events.insert({
        calendarId: input.calendarId,
        sendUpdates: input.sendUpdates,
        conferenceDataVersion: input.conferenceDataVersion,
        supportsAttachments: input.supportsAttachments,
        requestBody: input.requestBody,
      });
      return response.data;
    },
    async deleteEvent(input) {
      await calendar.events.delete(
        {
          calendarId: input.calendarId,
          eventId: input.eventId,
          sendUpdates: input.sendUpdates,
        },
        { headers: { "If-Match": input.ifMatch } },
      );
    },
  };
}
