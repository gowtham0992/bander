import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { CalendarEvent, MockSeed, SentMessage } from "@bander/contracts";

interface MockServicesOptions {
  token: string;
  seed: MockSeed;
  now?: () => Date;
}

interface UpdateEventBody {
  startTime: string;
}

interface SendMessageBody {
  recipientId: string;
  body: string;
}

interface ExecuteDealBody {
  draftHash: string;
  permitNonce: string;
  calendar: {
    eventId: string;
    expectedEtag: string;
    newStartTime: string;
  };
  message: {
    recipientId: string;
    expectedRecipientRevision: number;
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
  const dealResults = new Map<
    string,
    { event: CalendarEvent; message: SentMessage }
  >();

  const resetSeed = () => {
    events.clear();
    people.clear();
    messagesByKey.clear();
    dealResults.clear();
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
          required: ["startTime"],
          properties: { startTime: { type: "string", minLength: 20, maxLength: 40 } },
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

      const nextRevision = current.revision + 1;
      const updated: CalendarEvent = {
        ...current,
        startTime: request.body.startTime,
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

  app.post<{ Body: ExecuteDealBody }>(
    "/deals/execute",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["draftHash", "permitNonce", "calendar", "message"],
          properties: {
            draftHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
            permitNonce: { type: "string", minLength: 16, maxLength: 100 },
            calendar: {
              type: "object",
              additionalProperties: false,
              required: ["eventId", "expectedEtag", "newStartTime"],
              properties: {
                eventId: { type: "string", minLength: 1, maxLength: 100 },
                expectedEtag: { type: "string", minLength: 1, maxLength: 100 },
                newStartTime: { type: "string", minLength: 20, maxLength: 40 },
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
          },
        },
      },
    },
    async (request, reply) => {
      const existing = dealResults.get(request.body.draftHash);
      if (existing) return existing;

      const event = events.get(request.body.calendar.eventId);
      const person = people.get(request.body.message.recipientId);
      if (!event || !person) {
        return reply.code(404).send({
          error: { code: "resource_not_found", message: "Deal resource not found" },
        });
      }
      if (
        event.etag !== request.body.calendar.expectedEtag ||
        person.revision !== request.body.message.expectedRecipientRevision
      ) {
        return reply.code(412).send({
          error: {
            code: "precondition_failed",
            message: "A deal resource changed",
          },
        });
      }

      const nextRevision = event.revision + 1;
      const updatedEvent: CalendarEvent = {
        ...event,
        startTime: request.body.calendar.newStartTime,
        revision: nextRevision,
        etag: `${event.id}-r${nextRevision}`,
      };
      const message: SentMessage = {
        id: `message-${messagesByKey.size + 1}`,
        recipientId: person.id,
        body: request.body.message.body,
        idempotencyKey: request.body.draftHash,
        sentAt: now().toISOString(),
      };

      // Both seeded effects commit together after every precondition has passed.
      events.set(updatedEvent.id, updatedEvent);
      messagesByKey.set(request.body.draftHash, message);
      const result = { event: updatedEvent, message };
      dealResults.set(request.body.draftHash, result);
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
