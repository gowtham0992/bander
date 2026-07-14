import type {
  CalendarEvent,
  CalendarUpdateEffect,
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
      (effect): effect is CalendarUpdateEffect => effect.type === "calendar.update_event",
    );
    const message = input.document.effects.find(
      (effect): effect is MessageSendEffect => effect.type === "messages.send",
    );
    if (!calendar) {
      throw new Error("Stored Draft does not contain a supported Calendar effect");
    }

    if (!message && input.document.effects.length === 1) {
      await this.#request(`/calendar/events/${encodeURIComponent(calendar.eventId)}`, {
        method: "PATCH",
        headers: { "if-match": calendar.expected.etag },
        body: JSON.stringify({ startTime: calendar.changes.startTime }),
      });
      return;
    }

    if (!message || input.document.effects.length !== 2) {
      throw new Error("Stored Draft does not match a supported execution shape");
    }

    await this.#request("/deals/execute", {
      method: "POST",
      body: JSON.stringify({
        draftHash: input.draftHash,
        permitNonce: input.permitNonce,
        calendar: {
          eventId: calendar.eventId,
          expectedEtag: calendar.expected.etag,
          newStartTime: calendar.changes.startTime,
        },
        message: {
          recipientId: message.recipientId,
          expectedRecipientRevision: message.expected.revision,
          body: message.body,
        },
      }),
    });
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
