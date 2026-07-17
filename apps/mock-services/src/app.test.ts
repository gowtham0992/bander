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
  it("exposes the exact seeded Demo Calendar and Messages state only with Bander's credential", async () => {
    const instance = createApp();
    const denied = await instance.inject({ method: "GET", url: "/demo/state" });
    const visible = await instance.inject({
      method: "GET",
      url: "/demo/state",
      headers: authorization,
    });

    expect(denied.statusCode).toBe(401);
    expect(visible.statusCode).toBe(200);
    expect(visible.json()).toEqual({
      calendar: [
        expect.objectContaining({
          title: "Dinner with Sarah",
          startTime: "2026-07-14T19:00:00-06:00",
          endTime: "2026-07-14T20:30:00-06:00",
          timeZone: "America/Denver",
        }),
        expect.objectContaining({ title: "Focus block" }),
        expect.objectContaining({ title: "Bander Demo Appointment" }),
        expect.objectContaining({ title: "Dentist appointment" }),
      ],
      messages: [],
      familyUpdates: [],
    });
    expect(visible.body).not.toContain("event-dinner-sarah");
    expect(visible.body).not.toContain("etag");
  });
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
      payload: {
        startTime: "2026-07-14T19:30:00-06:00",
        endTime: "2026-07-15T03:00:00.000Z",
      },
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

  it("writes the exact duration-preserving interval when the ETag matches", async () => {
    const response = await createApp().inject({
      method: "PATCH",
      url: "/calendar/events/event-dinner-sarah",
      headers: { ...authorization, "if-match": "event-dinner-sarah-r1" },
      payload: {
        startTime: "2026-07-14T19:30:00-06:00",
        endTime: "2026-07-15T03:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      startTime: "2026-07-14T19:30:00-06:00",
      endTime: "2026-07-15T03:00:00.000Z",
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
  it("creates one seeded Calendar event and one byte-exact family update on replay", async () => {
    const instance = createApp();
    const body = "Bander update\n“Lunch with Ruth” was added for Tue, Jul 21, 12:00–1:00 PM MDT.\nThis is the exact update your family approved Bander to send.";
    const request = {
      method: "POST" as const,
      url: "/operations/execute",
      headers: authorization,
      payload: {
        operationKey: "sandbox-create-operation-0001",
        draftHash: "1".repeat(64),
        calendar: {
          kind: "create",
          eventId: "b7c0ffee12345",
          title: "Lunch with Ruth",
          startTime: "2026-07-21T18:00:00.000Z",
          endTime: "2026-07-21T19:00:00.000Z",
          timeZone: "America/Denver",
        },
        family: { recipientDisplayName: "Gil", body },
      },
    };
    const first = await instance.inject(request);
    const replay = await instance.inject(request);
    const visible = await instance.inject({ method: "GET", url: "/demo/state", headers: authorization });

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(visible.json().calendar).toContainEqual(expect.objectContaining({ title: "Lunch with Ruth" }));
    expect(visible.json().familyUpdates).toEqual([{ recipientDisplayName: "Gil", body, sentAt: "2026-07-13T18:00:00.000Z" }]);
  });

  it("removes one seeded Calendar event and sends one byte-exact family update on replay", async () => {
    const instance = createApp();
    const body = "Bander update\n“Dentist appointment,” scheduled for Thu, Jul 23, 1:00–2:00 PM MDT, is no longer on the calendar.\nThis is the exact update your family approved Bander to send.";
    const request = {
      method: "POST" as const,
      url: "/operations/execute",
      headers: authorization,
      payload: {
        operationKey: "sandbox-cancel-operation-0001",
        draftHash: "2".repeat(64),
        calendar: { kind: "cancel", eventId: "event-dentist", expectedEtag: "event-dentist-r1" },
        family: { recipientDisplayName: "Gil", body },
      },
    };
    const first = await instance.inject(request);
    const replay = await instance.inject(request);
    const visible = await instance.inject({ method: "GET", url: "/demo/state", headers: authorization });

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(visible.json().calendar).not.toContainEqual(expect.objectContaining({ title: "Dentist appointment" }));
    expect(visible.json().familyUpdates).toEqual([{ recipientDisplayName: "Gil", body, sentAt: "2026-07-13T18:00:00.000Z" }]);
  });
  it("updates the same Demo Calendar and Messages state that the Hero view reads", async () => {
    const instance = createApp();
    const operation = {
      method: "POST",
      url: "/operations/execute",
      headers: authorization,
      payload: {
        operationKey: "hero-visible-operation-0001",
        draftHash: "a".repeat(64),
        calendar: {
          eventId: "event-dinner-sarah",
          expectedEtag: "event-dinner-sarah-r1",
          newStartTime: "2026-07-14T19:30:00-06:00",
          newEndTime: "2026-07-14T21:00:00-06:00",
        },
        message: {
          recipientId: "person-sarah",
          expectedRecipientRevision: 1,
          body: "I’ll be about 20 minutes late. See you at 7:30!",
        },
      },
    } as const;
    const first = await instance.inject(operation);
    const retry = await instance.inject(operation);

    const visible = await instance.inject({
      method: "GET",
      url: "/demo/state",
      headers: authorization,
    });
    expect(visible.json()).toEqual({
      calendar: expect.arrayContaining([
        expect.objectContaining({
          title: "Dinner with Sarah",
          startTime: "2026-07-14T19:30:00-06:00",
          endTime: "2026-07-14T21:00:00-06:00",
        }),
      ]),
      messages: [
        {
          recipientDisplayName: "Sarah Chen",
          body: "I’ll be about 20 minutes late. See you at 7:30!",
          sentAt: "2026-07-13T18:00:00.000Z",
        },
      ],
      familyUpdates: [],
    });
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
  });

  it("leaves both visible Hero panels unchanged when the committed world conflicts", async () => {
    const instance = createApp();
    const before = await instance.inject({
      method: "GET",
      url: "/demo/state",
      headers: authorization,
    });
    const conflict = await instance.inject({
      method: "POST",
      url: "/operations/execute",
      headers: authorization,
      payload: {
        operationKey: "hero-conflict-operation-0001",
        draftHash: "b".repeat(64),
        calendar: {
          eventId: "event-dinner-sarah",
          expectedEtag: "stale-etag",
          newStartTime: "2026-07-14T19:30:00-06:00",
          newEndTime: "2026-07-14T21:00:00-06:00",
        },
        message: {
          recipientId: "person-sarah",
          expectedRecipientRevision: 1,
          body: "This must not be sent.",
        },
      },
    });
    const after = await instance.inject({
      method: "GET",
      url: "/demo/state",
      headers: authorization,
    });

    expect(conflict.statusCode).toBe(412);
    expect(after.json()).toEqual(before.json());
  });
  it("returns one Calendar mutation for repeated operation-key execution", async () => {
    const instance = createApp();
    const request = {
      method: "POST" as const,
      url: "/operations/execute",
      headers: authorization,
      payload: {
        operationKey: "permit-nonce-calendar-only",
        draftHash: "c".repeat(64),
        calendar: {
          eventId: "event-dinner-sarah",
          expectedEtag: "event-dinner-sarah-r1",
          newStartTime: "2026-07-14T19:30:00-06:00",
          newEndTime: "2026-07-15T03:00:00.000Z",
        },
      },
    };

    const first = await instance.inject(request);
    const retry = await instance.inject(request);

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(retry.json()).toMatchObject({
      event: {
        startTime: "2026-07-14T19:30:00-06:00",
        endTime: "2026-07-15T03:00:00.000Z",
        revision: 2,
      },
    });
  });

  it("rejects reuse of an operation key for a different Draft", async () => {
    const instance = createApp();
    const payload = {
      operationKey: "permit-nonce-bound-to-one-draft",
      draftHash: "e".repeat(64),
      calendar: {
        eventId: "event-dinner-sarah",
        expectedEtag: "event-dinner-sarah-r1",
        newStartTime: "2026-07-14T19:30:00-06:00",
        newEndTime: "2026-07-15T03:00:00.000Z",
      },
    };
    await instance.inject({
      method: "POST",
      url: "/operations/execute",
      headers: authorization,
      payload,
    });

    const reused = await instance.inject({
      method: "POST",
      url: "/operations/execute",
      headers: authorization,
      payload: { ...payload, draftHash: "f".repeat(64) },
    });

    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({
      error: { code: "operation_key_reused" },
    });
  });

  it("returns one combined Calendar and Messages result when retried", async () => {
    const instance = createApp();
    const request = {
      method: "POST" as const,
      url: "/operations/execute",
      headers: authorization,
      payload: {
        operationKey: "permit-nonce-combined-operation",
        draftHash: "d".repeat(64),
        calendar: {
          eventId: "event-dinner-sarah",
          expectedEtag: "event-dinner-sarah-r1",
          newStartTime: "2026-07-14T19:30:00-06:00",
          newEndTime: "2026-07-15T03:00:00.000Z",
        },
        message: {
          recipientId: "person-sarah",
          expectedRecipientRevision: 1,
          body: "See you at 7:30!",
        },
      },
    };

    const first = await instance.inject(request);
    const retry = await instance.inject(request);

    expect(retry.json()).toEqual(first.json());
    expect(retry.json()).toMatchObject({
      event: { revision: 2 },
      message: { id: "message-1" },
    });
  });

  it("commits the exact Calendar and Messages effects after all preconditions pass", async () => {
    const instance = createApp();
    const deal = await instance.inject({
      method: "POST",
      url: "/operations/execute",
      headers: authorization,
      payload: {
        draftHash: "a".repeat(64),
        operationKey: "permit-nonce-long-enough",
        calendar: {
          eventId: "event-dinner-sarah",
          expectedEtag: "event-dinner-sarah-r1",
          newStartTime: "2026-07-14T19:30:00-06:00",
          newEndTime: "2026-07-15T03:00:00.000Z",
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
      payload: {
        startTime: "2026-07-14T20:00:00-06:00",
        endTime: "2026-07-15T03:30:00.000Z",
      },
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
      url: "/operations/execute",
      headers: authorization,
      payload: {
        draftHash: "b".repeat(64),
        operationKey: "permit-nonce-long-enough",
        calendar: {
          eventId: "event-dinner-sarah",
          expectedEtag: "stale",
          newStartTime: "2026-07-14T19:30:00-06:00",
          newEndTime: "2026-07-15T03:00:00.000Z",
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
