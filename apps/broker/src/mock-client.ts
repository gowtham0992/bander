import type {
  CalendarEvent,
  CalendarCreateEffect,
  CalendarCancelEffect,
  CalendarRescheduleEffect,
  DemoSandboxState,
  DraftDocument,
  MessageSendEffect,
  FamilyTelegramNotificationEffect,
  ObservedExecutionResult,
  Person,
} from "@bander/contracts";
import {
  ExecutionAmbiguousError,
  ExecutionConflictError,
  type ExecutionAdapter,
} from "@bander/core";
import { renderFamilyNotificationDocument } from "@bander/core";

interface MockServiceClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

export class MockServiceClient implements ExecutionAdapter {
  readonly #baseUrl: string;
  readonly #authorization: string;
  readonly #timeoutMs: number;
  #ambiguousNextCalendar = false;

  constructor(options: MockServiceClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#authorization = `Bearer ${options.token}`;
    this.#timeoutMs = options.timeoutMs ?? 3_000;
  }

  resolveEvent(id: string): Promise<CalendarEvent> {
    return this.#request(`/calendar/events/${encodeURIComponent(id)}`);
  }

  resolvePerson(id: string): Promise<Person> {
    return this.#request(`/people/${encodeURIComponent(id)}`);
  }

  readDemoState(): Promise<DemoSandboxState> {
    return this.#request("/demo/state");
  }

  async executeDraft(input: {
    draftHash: string;
    permitNonce: string;
    document: DraftDocument;
  }): Promise<void | ObservedExecutionResult> {
    const calendar = input.document.effects.find(
      (effect): effect is CalendarRescheduleEffect | CalendarCreateEffect | CalendarCancelEffect =>
        effect.type === "calendar.reschedule_event" ||
        effect.type === "calendar.create_event" ||
        effect.type === "calendar.cancel_event",
    );
    const message = input.document.effects.find(
      (effect): effect is MessageSendEffect => effect.type === "messages.send",
    );
    const family = input.document.effects.find(
      (effect): effect is FamilyTelegramNotificationEffect =>
        effect.type === "family.telegram_notification",
    );
    if (!calendar) {
      throw new Error("Stored Draft does not contain a supported Calendar effect");
    }

    if (message && family) throw new Error("Stored Draft has conflicting notification effects");
    if (input.document.effects.length !== (message || family ? 2 : 1)) {
      throw new Error("Stored Draft does not match a supported execution shape");
    }

    if (this.#ambiguousNextCalendar) {
      if (calendar.type !== "calendar.reschedule_event") {
        throw new Error("The seeded ambiguous simulation supports rescheduling only");
      }
      this.#ambiguousNextCalendar = false;
      await this.#request(`/calendar/events/${encodeURIComponent(calendar.eventId)}`, {
        method: "PATCH",
        headers: { "if-match": calendar.expected.etag },
        body: JSON.stringify({
          startTime: calendar.changes.startTime,
          endTime: calendar.changes.endTime,
        }),
      });
      throw new ExecutionAmbiguousError();
    }

    const calendarOperation = calendar.type === "calendar.reschedule_event"
      ? {
          kind: "reschedule" as const,
          eventId: calendar.eventId,
          expectedEtag: calendar.expected.etag,
          newStartTime: calendar.changes.startTime,
          newEndTime: calendar.changes.endTime,
        }
      : calendar.type === "calendar.create_event"
        ? {
            kind: "create" as const,
            eventId: calendar.eventId,
            title: calendar.title,
            startTime: calendar.startTime,
            endTime: calendar.endTime,
            timeZone: calendar.timeZone,
          }
        : {
            kind: "cancel" as const,
            eventId: calendar.eventId,
            expectedEtag: calendar.expected.etag,
          };
    await this.#request("/operations/execute", {
      method: "POST",
      body: JSON.stringify({
        operationKey: input.permitNonce,
        draftHash: input.draftHash,
        calendar: calendarOperation,
        ...(message
          ? {
              message: {
                recipientId: message.recipientId,
                expectedRecipientRevision: message.expected.revision,
                body: message.body,
              },
            }
          : {}),
        ...(family
          ? {
              family: {
                recipientDisplayName: family.binding.displayLabel,
                body: renderFamilyNotificationDocument(family.document),
              },
            }
          : {}),
      }),
    });
    const completed = calendar.type === "calendar.reschedule_event"
      ? {
          startTime: calendar.changes.startTime,
          endTime: calendar.changes.endTime,
          timeZone: calendar.expected.timeZone,
        }
      : calendar.type === "calendar.create_event"
        ? {
            startTime: calendar.startTime,
            endTime: calendar.endTime,
            timeZone: calendar.timeZone,
          }
        : {
            startTime: calendar.expected.startTime,
            endTime: calendar.expected.endTime,
            timeZone: calendar.expected.timeZone,
          };
    return {
      calendar: {
        ...(calendar.type === "calendar.create_event" ? { action: "created" as const } : {}),
        ...(calendar.type === "calendar.cancel_event" ? { action: "removed" as const } : {}),
        status: "committed",
        completed,
      },
      ...(family ? { familyNotification: { status: "delivered" as const } } : {}),
    };
  }

  async getExecution(input: {
    draftHash: string;
    permitNonce: string;
  }): Promise<boolean> {
    const response = await fetch(
      `${this.#baseUrl}/operations/${encodeURIComponent(input.permitNonce)}`,
      {
        headers: { authorization: this.#authorization },
        signal: AbortSignal.timeout(this.#timeoutMs),
      },
    );
    if (response.status === 404) return false;
    const body = (await response.json()) as {
      draftHash?: string;
      error?: { code: string };
    };
    if (!response.ok) {
      throw new Error(body.error?.code ?? `mock_service_${response.status}`);
    }
    return body.draftHash === input.draftHash;
  }

  async resetDemo(): Promise<void> {
    this.#ambiguousNextCalendar = false;
    await this.#request("/demo/reset", { method: "POST" });
  }

  prepareAmbiguousCalendarOutcome(): void {
    this.#ambiguousNextCalendar = true;
  }

  async simulateCalendarChange(eventId: string): Promise<void> {
    await this.#request(`/demo/calendar/${encodeURIComponent(eventId)}/external-change`, {
      method: "POST",
      body: JSON.stringify({ startTime: "2026-07-14T20:00:00-06:00" }),
    });
  }

  async #request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      authorization: this.#authorization,
    };
    if (init?.body !== undefined) headers["content-type"] = "application/json";
    if (init?.headers) Object.assign(headers, init.headers);
    const response = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (response.status === 204) return undefined as T;
    const body = (await response.json()) as T & {
      error?: { code: string; message: string };
    };
    if (response.status === 412) {
      throw new ExecutionConflictError();
    }
    if (!response.ok) {
      throw new Error(body.error?.code ?? `mock_service_${response.status}`);
    }
    return body;
  }
}
