import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type {
  CalendarEvent,
  DemoSandboxState,
  EmailReplyEffect,
  MockSeed,
  SentMessage,
} from "@bander/contracts";

interface MockServicesOptions {
  token: string;
  seed: MockSeed;
  now?: () => Date;
}

interface UpdateEventBody {
  startTime: string;
  endTime: string;
}

interface SendMessageBody {
  recipientId: string;
  body: string;
}

interface ExecuteOperationBody {
  operationKey: string;
  draftHash: string;
  calendar?: {
    kind?: "reschedule" | "create" | "cancel";
    eventId: string;
    expectedEtag?: string;
    newStartTime?: string;
    newEndTime?: string;
    title?: string;
    startTime?: string;
    endTime?: string;
    timeZone?: string;
  };
  message?: {
    recipientId: string;
    expectedRecipientRevision: number;
    body: string;
  };
  family?: {
    recipientDisplayName: string;
    body: string;
  };
  email?: Pick<EmailReplyEffect, "recipient" | "subject" | "body" | "rfcMessageId">;
}

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual?.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(actual.slice("Bearer ".length));
  const secret = Buffer.from(expected);
  return candidate.length === secret.length && timingSafeEqual(candidate, secret);
}

export function buildMockServices(options: MockServicesOptions): FastifyInstance {
  if (options.token.length < 32) {
    throw new Error("Mock service token must be at least 32 characters");
  }

  const app = Fastify({
    logger: false,
    ajv: { customOptions: { removeAdditional: false } },
  });
  const now = options.now ?? (() => new Date());
  const events = new Map<string, CalendarEvent>();
  const people = new Map<string, (typeof options.seed.people)[number]>();
  const messagesByKey = new Map<string, SentMessage>();
  const familyUpdatesByKey = new Map<
    string,
    { recipientDisplayName: string; body: string; sentAt: string }
  >();
  const sentEmailsByKey = new Map<
    string,
    { recipient: string; subject: string; body: string; sentAt: string }
  >();
  const operationResults = new Map<
    string,
    {
      operationKey: string;
      draftHash: string;
      event?: CalendarEvent;
      message?: SentMessage;
    }
  >();

  const resetSeed = () => {
    events.clear();
    people.clear();
    messagesByKey.clear();
    familyUpdatesByKey.clear();
    sentEmailsByKey.clear();
    operationResults.clear();
    for (const event of structuredClone(options.seed.events)) events.set(event.id, event);
    for (const person of structuredClone(options.seed.people)) people.set(person.id, person);
  };
  resetSeed();

  app.get("/health", async () => ({ status: "ok" }));

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;
    if (!tokenMatches(request.headers.authorization, options.token)) {
      return reply.code(401).send({
        error: { code: "invalid_service_credential", message: "Unauthorized" },
      });
    }
  });

  app.get("/demo/state", async (): Promise<DemoSandboxState> => ({
    calendar: [...events.values()].map((event) => ({
      title: event.title,
      startTime: event.startTime,
      endTime: event.endTime,
      timeZone: event.timeZone,
    })),
    messages: [...messagesByKey.values()].map((message) => ({
      recipientDisplayName:
        people.get(message.recipientId)?.displayName ?? "Unknown recipient",
      body: message.body,
      sentAt: message.sentAt,
    })),
    familyUpdates: [...familyUpdatesByKey.values()],
    inbox: [
      {
        sender: "Ruth <ruth@example.test>",
        subject: "Lunch next week",
        receivedAt: "2026-07-16T15:00:00.000Z",
        excerpt: "Would Tuesday at noon work for lunch?",
      },
      {
        sender: "Dr. Rao’s office <office@example.test>",
        subject: "Appointment options",
        receivedAt: "2026-07-16T15:00:00.000Z",
        excerpt: "Thursday at 2 PM is available. Does that work for you?",
      },
    ],
    sentEmails: [...sentEmailsByKey.values()],
  }));

  app.get<{ Params: { eventId: string } }>(
    "/calendar/events/:eventId",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["eventId"],
          properties: { eventId: { type: "string", minLength: 1, maxLength: 100 } },
        },
      },
    },
    async (request, reply) => {
      const event = events.get(request.params.eventId);
      if (!event) {
        return reply.code(404).send({
          error: { code: "event_not_found", message: "Calendar event not found" },
        });
      }
      return event;
    },
  );

  app.patch<{ Params: { eventId: string }; Body: UpdateEventBody }>(
    "/calendar/events/:eventId",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["eventId"],
          properties: { eventId: { type: "string", minLength: 1, maxLength: 100 } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["startTime", "endTime"],
          properties: {
            startTime: { type: "string", minLength: 20, maxLength: 40 },
            endTime: { type: "string", minLength: 20, maxLength: 40 },
          },
        },
      },
    },
    async (request, reply) => {
      const current = events.get(request.params.eventId);
      if (!current) {
        return reply.code(404).send({
          error: { code: "event_not_found", message: "Calendar event not found" },
        });
      }

      if (request.headers["if-match"] !== current.etag) {
        return reply.code(412).send({
          error: {
            code: "precondition_failed",
            message: "Calendar event changed",
          },
        });
      }

      if (
        !Number.isFinite(new Date(request.body.startTime).getTime()) ||
        !Number.isFinite(new Date(request.body.endTime).getTime()) ||
        new Date(request.body.endTime).getTime() <=
          new Date(request.body.startTime).getTime()
      ) {
        return reply.code(422).send({
          error: {
            code: "invalid_calendar_interval",
            message: "Calendar end must be after start",
          },
        });
      }

      const nextRevision = current.revision + 1;
      const updated: CalendarEvent = {
        ...current,
        startTime: request.body.startTime,
        endTime: request.body.endTime,
        revision: nextRevision,
        etag: `${current.id}-r${nextRevision}`,
      };
      events.set(updated.id, updated);
      return updated;
    },
  );

  app.get<{ Params: { personId: string } }>(
    "/people/:personId",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["personId"],
          properties: { personId: { type: "string", minLength: 1, maxLength: 100 } },
        },
      },
    },
    async (request, reply) => {
      const person = people.get(request.params.personId);
      if (!person) {
        return reply.code(404).send({
          error: { code: "person_not_found", message: "Person not found" },
        });
      }
      return person;
    },
  );

  app.post<{ Body: SendMessageBody }>(
    "/messages",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["recipientId", "body"],
          properties: {
            recipientId: { type: "string", minLength: 1, maxLength: 100 },
            body: { type: "string", minLength: 1, maxLength: 1000 },
          },
        },
      },
    },
    async (request, reply) => {
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || idempotencyKey.length < 16) {
        return reply.code(400).send({
          error: {
            code: "invalid_idempotency_key",
            message: "A valid idempotency key is required",
          },
        });
      }
      if (!people.has(request.body.recipientId)) {
        return reply.code(404).send({
          error: { code: "person_not_found", message: "Recipient not found" },
        });
      }

      const existing = messagesByKey.get(idempotencyKey);
      if (existing) return existing;

      const message: SentMessage = {
        id: `message-${messagesByKey.size + 1}`,
        recipientId: request.body.recipientId,
        body: request.body.body,
        idempotencyKey,
        sentAt: now().toISOString(),
      };
      messagesByKey.set(idempotencyKey, message);
      return reply.code(201).send(message);
    },
  );

  app.get<{ Params: { operationKey: string } }>(
    "/operations/:operationKey",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["operationKey"],
          properties: {
            operationKey: { type: "string", minLength: 16, maxLength: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const result = operationResults.get(request.params.operationKey);
      if (!result) {
        return reply.code(404).send({
          error: { code: "operation_not_found", message: "Operation not found" },
        });
      }
      return result;
    },
  );

  app.post<{ Body: ExecuteOperationBody }>(
    "/operations/execute",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["operationKey", "draftHash"],
          properties: {
            operationKey: { type: "string", minLength: 16, maxLength: 100 },
            draftHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
            calendar: {
              type: "object",
              additionalProperties: false,
              required: ["eventId"],
              properties: {
                kind: { type: "string", enum: ["reschedule", "create", "cancel"] },
                eventId: { type: "string", minLength: 1, maxLength: 100 },
                expectedEtag: { type: "string", minLength: 1, maxLength: 100 },
                newStartTime: { type: "string", minLength: 20, maxLength: 40 },
                newEndTime: { type: "string", minLength: 20, maxLength: 40 },
                title: { type: "string", minLength: 1, maxLength: 160 },
                startTime: { type: "string", minLength: 20, maxLength: 40 },
                endTime: { type: "string", minLength: 20, maxLength: 40 },
                timeZone: { type: "string", minLength: 1, maxLength: 100 },
              },
            },
            message: {
              type: "object",
              additionalProperties: false,
              required: ["recipientId", "expectedRecipientRevision", "body"],
              properties: {
                recipientId: { type: "string", minLength: 1, maxLength: 100 },
                expectedRecipientRevision: { type: "integer", minimum: 1 },
                body: { type: "string", minLength: 1, maxLength: 1000 },
              },
            },
            family: {
              type: "object",
              additionalProperties: false,
              required: ["recipientDisplayName", "body"],
              properties: {
                recipientDisplayName: { type: "string", minLength: 1, maxLength: 80 },
                body: { type: "string", minLength: 1, maxLength: 1000 },
              },
            },
            email: {
              type: "object",
              additionalProperties: false,
              required: ["recipient", "subject", "body", "rfcMessageId"],
              properties: {
                recipient: { type: "string", minLength: 3, maxLength: 254 },
                subject: { type: "string", minLength: 1, maxLength: 200 },
                body: { type: "string", minLength: 1, maxLength: 2000 },
                rfcMessageId: { type: "string", minLength: 5, maxLength: 250 },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const existing = operationResults.get(request.body.operationKey);
      if (existing) {
        if (existing.draftHash !== request.body.draftHash) {
          return reply.code(409).send({
            error: {
              code: "operation_key_reused",
              message: "Operation key is already bound to another Draft",
            },
          });
        }
        return existing;
      }

      const calendar = request.body.calendar;
      const directFamily = request.body.family && !calendar;
      if ([calendar, request.body.email, directFamily ? request.body.family : undefined].filter(Boolean).length !== 1) {
        return reply.code(422).send({
          error: { code: "invalid_operation_shape", message: "One primary operation is required" },
        });
      }
      if (request.body.email) {
        const sent = {
          recipient: request.body.email.recipient,
          subject: request.body.email.subject,
          body: request.body.email.body,
          sentAt: now().toISOString(),
        };
        sentEmailsByKey.set(request.body.operationKey, sent);
        const result = { operationKey: request.body.operationKey, draftHash: request.body.draftHash };
        operationResults.set(request.body.operationKey, result);
        return reply.code(201).send(result);
      }
      if (directFamily && request.body.family) {
        familyUpdatesByKey.set(request.body.operationKey, {
          recipientDisplayName: request.body.family.recipientDisplayName,
          body: request.body.family.body,
          sentAt: now().toISOString(),
        });
        const result = { operationKey: request.body.operationKey, draftHash: request.body.draftHash };
        operationResults.set(request.body.operationKey, result);
        return reply.code(201).send(result);
      }
      const kind = calendar!.kind ?? "reschedule";
      const event = events.get(calendar!.eventId);
      const person = request.body.message
        ? people.get(request.body.message.recipientId)
        : undefined;
      if ((kind !== "create" && !event) || (kind === "create" && event) || (request.body.message && !person)) {
        return reply.code(404).send({
          error: { code: "resource_not_found", message: "Deal resource not found" },
        });
      }
      if (
        (kind !== "create" && event!.etag !== calendar!.expectedEtag) ||
        (request.body.message &&
          person?.revision !== request.body.message.expectedRecipientRevision)
      ) {
        return reply.code(412).send({
          error: {
            code: "precondition_failed",
            message: "A deal resource changed",
          },
        });
      }
      if (
        kind === "create" &&
        (!calendar!.title ||
          !calendar!.startTime ||
          !calendar!.endTime ||
          !calendar!.timeZone)
      ) {
        return reply.code(422).send({
          error: {
            code: "invalid_calendar_create",
            message: "Calendar creation requires a title, interval, and timezone",
          },
        });
      }
      if (
        kind !== "cancel" && (
          !Number.isFinite(new Date(kind === "create" ? calendar!.startTime! : calendar!.newStartTime!).getTime()) ||
          !Number.isFinite(new Date(kind === "create" ? calendar!.endTime! : calendar!.newEndTime!).getTime()) ||
          new Date(kind === "create" ? calendar!.endTime! : calendar!.newEndTime!).getTime() <=
            new Date(kind === "create" ? calendar!.startTime! : calendar!.newStartTime!).getTime()
        )
      ) {
        return reply.code(422).send({
          error: {
            code: "invalid_calendar_interval",
            message: "Calendar end must be after start",
          },
        });
      }

      const updatedEvent: CalendarEvent | undefined = kind === "cancel"
        ? undefined
        : kind === "create"
          ? {
              id: calendar!.eventId,
              title: calendar!.title!,
              startTime: calendar!.startTime!,
              endTime: calendar!.endTime!,
              timeZone: calendar!.timeZone!,
              organizerId: "person-owner",
              attendeeIds: ["person-owner"],
              revision: 1,
              etag: `${calendar!.eventId}-r1`,
            }
          : {
              ...event!,
              startTime: calendar!.newStartTime!,
              endTime: calendar!.newEndTime!,
              revision: event!.revision + 1,
              etag: `${event!.id}-r${event!.revision + 1}`,
            };
      const message =
        request.body.message && person
          ? {
              id: `message-${messagesByKey.size + 1}`,
              recipientId: person.id,
              body: request.body.message.body,
              idempotencyKey: request.body.operationKey,
              sentAt: now().toISOString(),
            }
          : undefined;
      const familyUpdate = request.body.family
        ? {
            recipientDisplayName: request.body.family.recipientDisplayName,
            body: request.body.family.body,
            sentAt: now().toISOString(),
          }
        : undefined;

      // Both seeded effects commit together after every precondition has passed.
      if (kind === "cancel") events.delete(calendar!.eventId);
      else events.set(updatedEvent!.id, updatedEvent!);
      if (message) messagesByKey.set(request.body.operationKey, message);
      if (familyUpdate) familyUpdatesByKey.set(request.body.operationKey, familyUpdate);
      const result = {
        operationKey: request.body.operationKey,
        draftHash: request.body.draftHash,
        ...(updatedEvent ? { event: updatedEvent } : {}),
        ...(message ? { message } : {}),
      };
      operationResults.set(request.body.operationKey, result);
      return reply.code(201).send(result);
    },
  );

  app.post("/demo/reset", async (_request, reply) => {
    resetSeed();
    return reply.code(204).send();
  });

  app.post<{
    Params: { eventId: string };
    Body: { startTime: string };
  }>(
    "/demo/calendar/:eventId/external-change",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["eventId"],
          properties: { eventId: { type: "string", minLength: 1, maxLength: 100 } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["startTime"],
          properties: { startTime: { type: "string", minLength: 20, maxLength: 40 } },
        },
      },
    },
    async (request, reply) => {
      const event = events.get(request.params.eventId);
      if (!event) {
        return reply.code(404).send({
          error: { code: "event_not_found", message: "Calendar event not found" },
        });
      }
      const revision = event.revision + 1;
      const changed: CalendarEvent = {
        ...event,
        startTime: request.body.startTime,
        revision,
        etag: `${event.id}-r${revision}`,
      };
      events.set(changed.id, changed);
      return changed;
    },
  );

  return app;
}
