import type {
  CalendarEvent,
  CalendarRescheduleEffect,
  DraftDocument,
  MessageSendEffect,
  Person,
} from "@bander/contracts";
import { ExecutionConflictError, type ExecutionAdapter } from "@bander/core";

interface MockServiceClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

export class MockServiceClient implements ExecutionAdapter {
  readonly #baseUrl: string;
  readonly #authorization: string;
  readonly #timeoutMs: number;

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

  async executeDraft(input: {
    draftHash: string;
    permitNonce: string;
    document: DraftDocument;
  }): Promise<void> {
    const calendar = input.document.effects.find(
      (effect): effect is CalendarRescheduleEffect =>
        effect.type === "calendar.reschedule_event",
    );
    const message = input.document.effects.find(
      (effect): effect is MessageSendEffect => effect.type === "messages.send",
    );
    if (!calendar) {
      throw new Error("Stored Draft does not contain a supported Calendar effect");
    }

    if (input.document.effects.length !== (message ? 2 : 1)) {
      throw new Error("Stored Draft does not match a supported execution shape");
    }

    await this.#request("/operations/execute", {
      method: "POST",
      body: JSON.stringify({
        operationKey: input.permitNonce,
        draftHash: input.draftHash,
        calendar: {
          eventId: calendar.eventId,
          expectedEtag: calendar.expected.etag,
          newStartTime: calendar.changes.startTime,
          newEndTime: calendar.changes.endTime,
        },
        ...(message
          ? {
              message: {
                recipientId: message.recipientId,
                expectedRecipientRevision: message.expected.revision,
                body: message.body,
              },
            }
          : {}),
      }),
    });
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
    await this.#request("/demo/reset", { method: "POST" });
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
