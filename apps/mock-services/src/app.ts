import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type {
  CalendarEvent,
  DemoSandboxState,
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
  calendar: {
    eventId: string;
    expectedEtag: string;
    newStartTime: string;
    newEndTime: string;
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
  const operationResults = new Map<
    string,
    {
      operationKey: string;
      draftHash: string;
      event: CalendarEvent;
      message?: SentMessage;
    }
  >();

  const resetSeed = () => {
    events.clear();
    people.clear();
    messagesByKey.clear();
    familyUpdatesByKey.clear();
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
          required: ["operationKey", "draftHash", "calendar"],
          properties: {
            operationKey: { type: "string", minLength: 16, maxLength: 100 },
            draftHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
            calendar: {
              type: "object",
              additionalProperties: false,
              required: ["eventId", "expectedEtag", "newStartTime", "newEndTime"],
              properties: {
                eventId: { type: "string", minLength: 1, maxLength: 100 },
                expectedEtag: { type: "string", minLength: 1, maxLength: 100 },
                newStartTime: { type: "string", minLength: 20, maxLength: 40 },
                newEndTime: { type: "string", minLength: 20, maxLength: 40 },
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

      const event = events.get(request.body.calendar.eventId);
      const person = request.body.message
        ? people.get(request.body.message.recipientId)
        : undefined;
      if (!event || (request.body.message && !person)) {
        return reply.code(404).send({
          error: { code: "resource_not_found", message: "Deal resource not found" },
        });
      }
      if (
        event.etag !== request.body.calendar.expectedEtag ||
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
        !Number.isFinite(new Date(request.body.calendar.newStartTime).getTime()) ||
        !Number.isFinite(new Date(request.body.calendar.newEndTime).getTime()) ||
        new Date(request.body.calendar.newEndTime).getTime() <=
          new Date(request.body.calendar.newStartTime).getTime()
      ) {
        return reply.code(422).send({
          error: {
            code: "invalid_calendar_interval",
            message: "Calendar end must be after start",
          },
        });
      }

      const nextRevision = event.revision + 1;
      const updatedEvent: CalendarEvent = {
        ...event,
        startTime: request.body.calendar.newStartTime,
        endTime: request.body.calendar.newEndTime,
        revision: nextRevision,
        etag: `${event.id}-r${nextRevision}`,
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
      events.set(updatedEvent.id, updatedEvent);
      if (message) messagesByKey.set(request.body.operationKey, message);
      if (familyUpdate) familyUpdatesByKey.set(request.body.operationKey, familyUpdate);
      const result = {
        operationKey: request.body.operationKey,
        draftHash: request.body.draftHash,
        event: updatedEvent,
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
