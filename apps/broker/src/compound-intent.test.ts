import { describe, expect, it } from "vitest";
import {
  CompoundIntentOutputSchema,
  CompoundIntentError,
  probeCompoundIntent,
  validateCompoundIntent,
  type CompoundIntentOutput,
} from "./compound-intent.js";

const context = {
  nowLocalDate: "2026-07-15",
  timeZone: "America/Denver",
  contacts: [
    { key: "contact-gil", aliases: ["gil", "son"] },
    { key: "contact-alex-1", aliases: ["alex"] },
    { key: "contact-alex-2", aliases: ["alex"] },
  ],
};

function ready(overrides: Partial<CompoundIntentOutput> = {}): CompoundIntentOutput {
  return {
    classification: "ready",
    eventTitleHint: "Bander Demo Appointment",
    sourceLocalDateHint: null,
    targetLocalDate: "2026-07-17",
    targetLocalStart: "14:00",
    familyNotificationRequested: true,
    familyContactAlias: "Gil",
    clarificationReason: null,
    clarificationQuestion: null,
    ...overrides,
  };
}

describe("bounded compound-intent output", () => {
  it("accepts only hints and resolves a paired alias without exposing routing", () => {
    const result = validateCompoundIntent(ready(), context);
    expect(result).toEqual({
      status: "ready",
      eventTitleHint: "Bander Demo Appointment",
      sourceLocalDateHint: null,
      targetLocalDate: "2026-07-17",
      targetLocalStart: "14:00",
      familyNotificationRequested: true,
      contactKey: "contact-gil",
    });
    expect(JSON.stringify(result)).not.toMatch(/telegram|chat|username|address/i);
  });

  it.each([
    ["calendar ID", { calendarId: "primary" }],
    ["event ID", { eventId: "event-secret" }],
    ["etag", { etag: "revision" }],
    ["end time", { endTime: "15:00" }],
    ["duration", { duration: 60 }],
    ["recipient address", { telegramId: 123456 }],
    ["message body", { messageBody: "Bring the documents" }],
    ["effects", { effects: ["move", "notify"] }],
    ["ordering", { executionOrdering: ["calendar", "telegram"] }],
    ["authority", { permit: "approve-me" }],
    ["idempotency", { idempotencyKey: "key" }],
  ])("rejects model-authored %s", (_label, forbidden) => {
    expect(() => CompoundIntentOutputSchema.parse({ ...ready(), ...forbidden })).toThrow();
  });

  it.each([
    ["unpaired", ready({ familyContactAlias: "Sarah" }), "unpaired_contact"],
    ["multiple", ready({ familyContactAlias: "Alex" }), "ambiguous_contact"],
    ["pronoun", ready({ familyContactAlias: "him" }), "ambiguous_contact"],
    ["missing date", ready({ targetLocalDate: null }), "missing_target_date"],
    ["missing time", ready({ targetLocalStart: null }), "missing_target_time"],
    ["missing title", ready({ eventTitleHint: null }), "missing_event_title"],
  ])("fails closed for %s", (_label, output, reason) => {
    expect(validateCompoundIntent(output, context)).toMatchObject({
      status: "clarification_required",
      reason,
    });
  });

  it("preserves unsupported classifications without manufacturing authority", () => {
    const result = validateCompoundIntent(
      ready({
        classification: "unsupported",
        familyNotificationRequested: false,
        familyContactAlias: null,
        clarificationReason: "unsupported_action",
        clarificationQuestion: "I can only help move one appointment and notify a paired contact.",
      }),
      context,
    );
    expect(result).toEqual({
      status: "unsupported",
      reason: "unsupported_action",
      question: "I can only help move one appointment and notify a paired contact.",
    });
  });

  it("normalizes multiple-event broadening to unsupported", () => {
    expect(
      validateCompoundIntent(
        ready({
          classification: "clarification",
          clarificationReason: "multiple_events_unsupported",
          clarificationQuestion: "Please choose one.",
        }),
        context,
      ),
    ).toMatchObject({
      status: "unsupported",
      reason: "multiple_events_unsupported",
    });
  });

  it("normalizes an unresolved model pronoun to deterministic ambiguity", () => {
    expect(
      validateCompoundIntent(
        ready({
          classification: "clarification",
          familyContactAlias: "him",
          clarificationReason: "unpaired_contact",
          clarificationQuestion: "Who is him?",
        }),
        context,
      ),
    ).toEqual({
      status: "clarification_required",
      reason: "ambiguous_contact",
      question: "Which paired family contact should I notify?",
    });
  });

  it("lets Bander's local directory, not the model, decide that an alias is paired", () => {
    expect(
      validateCompoundIntent(
        ready({
          classification: "clarification",
          familyContactAlias: "my son",
          clarificationReason: "unpaired_contact",
          clarificationQuestion: "Is your son paired?",
        }),
        {
          ...context,
          contacts: [
            ...context.contacts,
            { key: "contact-gil", aliases: ["my son"] },
          ],
        },
      ),
    ).toMatchObject({ status: "ready", contactKey: "contact-gil" });

    expect(
      validateCompoundIntent(
        ready({
          classification: "clarification",
          familyContactAlias: "Sarah",
          clarificationReason: "unpaired_contact",
          clarificationQuestion: "Is Sarah paired?",
        }),
        context,
      ),
    ).toMatchObject({
      status: "clarification_required",
      reason: "unpaired_contact",
    });
  });

  it("fails closed on malformed structured output", async () => {
    await expect(
      probeCompoundIntent(
        { select: async () => ({ ...ready(), messageBody: "forged" }) },
        "request",
        context,
      ),
    ).resolves.toEqual({ status: "invalid_model_output" });
  });

  it("fails closed when the model times out or is unavailable", async () => {
    await expect(
      probeCompoundIntent(
        {
          select: async () => {
            throw new CompoundIntentError("model_unavailable", "sanitized");
          },
        },
        "request",
        context,
      ),
    ).resolves.toEqual({ status: "model_unavailable" });
  });
});
