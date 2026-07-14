import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildMockServices } from "./app.js";
import { loadVersionedSeed } from "./fixtures.js";

const token = "test-token-that-is-at-least-thirty-two-characters";
const authorization = { authorization: `Bearer ${token}` };
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function createApp(): FastifyInstance {
  app = buildMockServices({
    token,
    seed: loadVersionedSeed(),
    now: () => new Date("2026-07-13T18:00:00.000Z"),
  });
  return app;
}

describe("mock-service credential boundary", () => {
  it("rejects downstream reads without Bander's service credential", async () => {
    const response = await createApp().inject({
      method: "GET",
      url: "/calendar/events/event-dinner-sarah",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: "invalid_service_credential", message: "Unauthorized" },
    });
    expect(response.body).not.toContain("Dinner with Sarah");
  });

  it("rejects an incorrect service credential", async () => {
    const response = await createApp().inject({
      method: "GET",
      url: "/calendar/events/event-dinner-sarah",
      headers: { authorization: "Bearer definitely-not-the-service-token" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("allows Bander to resolve a seeded event with the service credential", async () => {
    const response = await createApp().inject({
      method: "GET",
      url: "/calendar/events/event-dinner-sarah",
      headers: authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "event-dinner-sarah",
      title: "Dinner with Sarah",
      etag: "event-dinner-sarah-r1",
    });
  });
});

describe("mock Calendar conditional writes", () => {
  it("fails closed on an ETag mismatch without mutating the event", async () => {
    const instance = createApp();
    const staleWrite = await instance.inject({
      method: "PATCH",
      url: "/calendar/events/event-dinner-sarah",
      headers: { ...authorization, "if-match": "stale-etag" },
      payload: { startTime: "2026-07-14T19:30:00-06:00" },
    });

    expect(staleWrite.statusCode).toBe(412);
    expect(staleWrite.json()).toEqual({
      error: {
        code: "precondition_failed",
        message: "Calendar event changed",
      },
    });

    const readAfterFailure = await instance.inject({
      method: "GET",
      url: "/calendar/events/event-dinner-sarah",
      headers: authorization,
    });
    expect(readAfterFailure.json()).toMatchObject({
      startTime: "2026-07-14T19:00:00-06:00",
      revision: 1,
      etag: "event-dinner-sarah-r1",
    });
  });

  it("updates only the requested start time when the ETag matches", async () => {
    const response = await createApp().inject({
      method: "PATCH",
      url: "/calendar/events/event-dinner-sarah",
      headers: { ...authorization, "if-match": "event-dinner-sarah-r1" },
      payload: { startTime: "2026-07-14T19:30:00-06:00" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      startTime: "2026-07-14T19:30:00-06:00",
      endTime: "2026-07-14T20:30:00-06:00",
      revision: 2,
      etag: "event-dinner-sarah-r2",
    });
  });
});

describe("mock Messages idempotency", () => {
  it("returns one message outcome when Bander retries the same write", async () => {
    const instance = createApp();
    const request = {
      method: "POST" as const,
      url: "/messages",
      headers: {
        ...authorization,
        "idempotency-key": "draft-hash-message-effect-1",
      },
      payload: {
        recipientId: "person-sarah",
        body: "I’ll be about 20 minutes late. See you at 7:30!",
      },
    };

    const first = await instance.inject(request);
    const retry = await instance.inject(request);

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(first.json()).toMatchObject({ id: "message-1", recipientId: "person-sarah" });
  });
});

describe("atomic seeded deal execution", () => {
  it("commits the exact Calendar and Messages effects after all preconditions pass", async () => {
    const instance = createApp();
    const deal = await instance.inject({
      method: "POST",
      url: "/deals/execute",
      headers: authorization,
      payload: {
        draftHash: "a".repeat(64),
        permitNonce: "permit-nonce-long-enough",
        calendar: {
          eventId: "event-dinner-sarah",
          expectedEtag: "event-dinner-sarah-r1",
          newStartTime: "2026-07-14T19:30:00-06:00",
        },
        message: {
          recipientId: "person-sarah",
          expectedRecipientRevision: 1,
          body: "I’ll be about 20 minutes late. See you at 7:30!",
        },
      },
    });

    expect(deal.statusCode).toBe(201);
    expect(deal.json()).toMatchObject({
      event: { startTime: "2026-07-14T19:30:00-06:00", revision: 2 },
      message: { recipientId: "person-sarah" },
    });
  });

  it("restores versioned seed state for a repeatable local demo", async () => {
    const instance = createApp();
    await instance.inject({
      method: "PATCH",
      url: "/calendar/events/event-dinner-sarah",
      headers: { ...authorization, "if-match": "event-dinner-sarah-r1" },
      payload: { startTime: "2026-07-14T20:00:00-06:00" },
    });

    const reset = await instance.inject({
      method: "POST",
      url: "/demo/reset",
      headers: authorization,
    });
    expect(reset.statusCode).toBe(204);

    const restored = await instance.inject({
      method: "GET",
      url: "/calendar/events/event-dinner-sarah",
      headers: authorization,
    });
    expect(restored.json()).toMatchObject({
      startTime: "2026-07-14T19:00:00-06:00",
      revision: 1,
      etag: "event-dinner-sarah-r1",
    });
  });

  it("commits neither effect when any deal precondition is stale", async () => {
    const instance = createApp();
    const deal = await instance.inject({
      method: "POST",
      url: "/deals/execute",
      headers: authorization,
      payload: {
        draftHash: "b".repeat(64),
        permitNonce: "permit-nonce-long-enough",
        calendar: {
          eventId: "event-dinner-sarah",
          expectedEtag: "stale",
          newStartTime: "2026-07-14T19:30:00-06:00",
        },
        message: {
          recipientId: "person-sarah",
          expectedRecipientRevision: 1,
          body: "This must not be sent",
        },
      },
    });

    expect(deal.statusCode).toBe(412);
    const eventAfter = await instance.inject({
      method: "GET",
      url: "/calendar/events/event-dinner-sarah",
      headers: authorization,
    });
    expect(eventAfter.json()).toMatchObject({
      startTime: "2026-07-14T19:00:00-06:00",
      revision: 1,
    });
  });
});
