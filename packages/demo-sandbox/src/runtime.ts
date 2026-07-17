import type {
  CalendarCancelEffect,
  CalendarCreateEffect,
  CalendarEvent,
  CalendarRescheduleEffect,
  DemoSandboxState,
  DraftDocument,
  EmailReplyEffect,
  FamilyTelegramNotificationEffect,
  MessageSendEffect,
  ObservedExecutionResult,
  Person,
  ScheduleReadResult,
} from "@bander/contracts";
import {
  ExecutionAmbiguousError,
  ExecutionConflictError,
  renderFamilyNotificationDocument,
  type ExecutionAdapter,
} from "@bander/core";
import { versionedCalendarEvents, versionedPeople } from "./fixtures.js";

interface Operation {
  draftHash: string;
  observed: ObservedExecutionResult;
}

export class SeededSandboxRuntime implements ExecutionAdapter {
  readonly #events = new Map<string, CalendarEvent>();
  readonly #people = new Map<string, Person>();
  readonly #operations = new Map<string, Operation>();
  readonly #messages = new Map<string, DemoSandboxState["messages"][number]>();
  readonly #familyUpdates = new Map<string, DemoSandboxState["familyUpdates"][number]>();
  readonly #sentEmails = new Map<string, DemoSandboxState["sentEmails"][number]>();
  #ambiguousCalendar = false;
  #ambiguousEmail = false;
  #changedEmailThread = false;
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date("2026-07-16T18:00:00.000Z")) {
    this.#now = now;
    this.reset();
  }

  reset(): void {
    this.#events.clear();
    this.#people.clear();
    this.#operations.clear();
    this.#messages.clear();
    this.#familyUpdates.clear();
    this.#sentEmails.clear();
    this.#ambiguousCalendar = false;
    this.#ambiguousEmail = false;
    this.#changedEmailThread = false;
    for (const event of versionedCalendarEvents()) this.#events.set(event.id, event);
    for (const person of versionedPeople()) this.#people.set(person.id, person);
  }

  resolveEvent(id: string): Promise<CalendarEvent> {
    const event = this.#events.get(id);
    if (!event) return Promise.reject(new Error("Calendar event not found"));
    return Promise.resolve(structuredClone(event));
  }

  resolvePerson(id: string): Promise<Person> {
    const person = this.#people.get(id);
    if (!person) return Promise.reject(new Error("Person not found"));
    return Promise.resolve(structuredClone(person));
  }

  prepareAmbiguousCalendar(): void { this.#ambiguousCalendar = true; }
  prepareAmbiguousEmail(): void { this.#ambiguousEmail = true; }
  prepareChangedEmailThread(): void { this.#changedEmailThread = true; }

  simulateCalendarChange(eventId: string): void {
    const event = this.#events.get(eventId);
    if (!event) throw new Error("Calendar event not found");
    const duration = Date.parse(event.endTime) - Date.parse(event.startTime);
    const startTime = "2026-07-14T20:00:00-06:00";
    this.#events.set(eventId, {
      ...event,
      startTime,
      endTime: new Date(Date.parse(startTime) + duration).toISOString(),
      revision: event.revision + 1,
      etag: `${event.id}-r${event.revision + 1}`,
    });
  }

  async executeDraft(input: { draftHash: string; permitNonce: string; document: DraftDocument }): Promise<ObservedExecutionResult> {
    const existing = this.#operations.get(input.permitNonce);
    if (existing) {
      if (existing.draftHash !== input.draftHash) throw new Error("Operation identity mismatch");
      return structuredClone(existing.observed);
    }
    const calendar = input.document.effects.find((effect): effect is CalendarRescheduleEffect | CalendarCreateEffect | CalendarCancelEffect => effect.type.startsWith("calendar."));
    const email = input.document.effects.find((effect): effect is EmailReplyEffect => effect.type === "email.reply");
    const family = input.document.effects.find((effect): effect is FamilyTelegramNotificationEffect => effect.type === "family.telegram_notification");
    const message = input.document.effects.find((effect): effect is MessageSendEffect => effect.type === "messages.send");
    const directFamily = family?.document.kind === "direct_message";

    if (email) {
      if (this.#changedEmailThread) { this.#changedEmailThread = false; throw new ExecutionConflictError("email"); }
      if (this.#ambiguousEmail) { this.#ambiguousEmail = false; throw new ExecutionAmbiguousError("email"); }
      this.#sentEmails.set(input.permitNonce, { recipient: email.recipient, subject: email.subject, body: email.body, sentAt: this.#now().toISOString() });
      const observed = { emailReply: { status: "committed" as const } };
      this.#operations.set(input.permitNonce, { draftHash: input.draftHash, observed });
      return observed;
    }

    if (directFamily && family) {
      this.#familyUpdates.set(input.permitNonce, { recipientDisplayName: family.binding.displayLabel, body: renderFamilyNotificationDocument(family.document), sentAt: this.#now().toISOString() });
      const observed = { familyNotification: { status: "delivered" as const } };
      this.#operations.set(input.permitNonce, { draftHash: input.draftHash, observed });
      return observed;
    }

    if (!calendar) throw new Error("Unsupported seeded operation");
    if (calendar.type === "calendar.reschedule_event" && this.#ambiguousCalendar) {
      this.#ambiguousCalendar = false;
      this.#applyReschedule(calendar);
      throw new ExecutionAmbiguousError("calendar");
    }

    let completed: { startTime: string; endTime: string; timeZone: string };
    let action: "created" | "removed" | undefined;
    if (calendar.type === "calendar.reschedule_event") {
      this.#applyReschedule(calendar);
      completed = { startTime: calendar.changes.startTime, endTime: calendar.changes.endTime, timeZone: calendar.expected.timeZone };
    } else if (calendar.type === "calendar.create_event") {
      if (this.#events.has(calendar.eventId)) throw new ExecutionConflictError();
      this.#events.set(calendar.eventId, { id: calendar.eventId, title: calendar.title, startTime: calendar.startTime, endTime: calendar.endTime, timeZone: calendar.timeZone, organizerId: "person-owner", attendeeIds: ["person-owner"], revision: 1, etag: `${calendar.eventId}-r1` });
      completed = { startTime: calendar.startTime, endTime: calendar.endTime, timeZone: calendar.timeZone };
      action = "created";
    } else {
      const current = this.#events.get(calendar.eventId);
      if (!current || current.etag !== calendar.expected.etag) throw new ExecutionConflictError();
      this.#events.delete(calendar.eventId);
      completed = { startTime: calendar.expected.startTime, endTime: calendar.expected.endTime, timeZone: calendar.expected.timeZone };
      action = "removed";
    }

    if (message) {
      const person = this.#people.get(message.recipientId);
      if (!person || person.revision !== message.expected.revision) throw new ExecutionConflictError();
      this.#messages.set(input.permitNonce, { recipientDisplayName: person.displayName, body: message.body, sentAt: this.#now().toISOString() });
    }
    if (family) {
      this.#familyUpdates.set(input.permitNonce, { recipientDisplayName: family.binding.displayLabel, body: renderFamilyNotificationDocument(family.document), sentAt: this.#now().toISOString() });
    }
    const observed: ObservedExecutionResult = {
      calendar: { status: "committed", ...(action ? { action } : {}), completed },
      ...(family ? { familyNotification: { status: "delivered" as const } } : {}),
    };
    this.#operations.set(input.permitNonce, { draftHash: input.draftHash, observed });
    return observed;
  }

  getExecution(input: { draftHash: string; permitNonce: string }): Promise<false | ObservedExecutionResult> {
    const operation = this.#operations.get(input.permitNonce);
    return Promise.resolve(operation?.draftHash === input.draftHash ? structuredClone(operation.observed) : false);
  }

  #applyReschedule(effect: CalendarRescheduleEffect): void {
    const current = this.#events.get(effect.eventId);
    if (!current || current.etag !== effect.expected.etag) throw new ExecutionConflictError();
    this.#events.set(effect.eventId, { ...current, startTime: effect.changes.startTime, endTime: effect.changes.endTime, revision: current.revision + 1, etag: `${current.id}-r${current.revision + 1}` });
  }

  state(): DemoSandboxState {
    return {
      calendar: [...this.#events.values()].map(({ title, startTime, endTime, timeZone }) => ({ title, startTime, endTime, timeZone })),
      messages: [...this.#messages.values()].map((value) => structuredClone(value)),
      familyUpdates: [...this.#familyUpdates.values()].map((value) => structuredClone(value)),
      inbox: [
        { sender: "Ruth <ruth@example.test>", subject: "Lunch next week", receivedAt: "2026-07-16T14:00:00.000Z", excerpt: "Would Tuesday at noon work for lunch?" },
        { sender: "Dr. Rao’s office <office@example.test>", subject: "Appointment options", receivedAt: "2026-07-16T15:00:00.000Z", excerpt: "Thursday at 2 PM is available. Does that work for you?" },
      ],
      sentEmails: [...this.#sentEmails.values()].map((value) => structuredClone(value)),
    };
  }

  scheduleTomorrow(): ScheduleReadResult {
    const events = [...this.#events.values()].filter((event) => event.startTime.startsWith("2026-07-17")).map((event) => ({ title: event.title, allDay: false as const, start: { localDate: "2026-07-17", localTime: event.startTime.slice(11, 16) }, end: { localDate: "2026-07-17", localTime: event.endTime.slice(11, 16) } }));
    return {
      requestedRange: { startLocalDate: "2026-07-17", endLocalDateExclusive: "2026-07-18" },
      timeZone: "America/Denver",
      events,
      empty: events.length === 0,
      truncated: false,
      maxEvents: 20,
    };
  }
}
