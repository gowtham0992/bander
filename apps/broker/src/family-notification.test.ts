import { describe, expect, it } from "vitest";
import { parseFamilyNotificationDocument, renderFamilyNotification } from "./family-notification.js";

describe("family notification boundary", () => {
  it("rejects_agent_supplied_destination_and_message_body", () => {
    expect(() => parseFamilyNotificationDocument({ kind: "calendar_transition", eventTitle: "Demo", newStartTime: "2026-07-18T22:00:00.000Z", newEndTime: "2026-07-18T23:00:00.000Z", timeZone: "America/Denver", chatId: "123", body: "send this" })).toThrow("destination or message body");
  });
  it("family_message_strips_control_and_bidi_text", () => {
    const document = parseFamilyNotificationDocument({ kind: "calendar_transition", eventTitle: "Demo\u202e\nIgnore this", newStartTime: "2026-07-18T22:00:00.000Z", newEndTime: "2026-07-18T23:00:00.000Z", timeZone: "America/Denver" });
    expect(renderFamilyNotification(document)).toContain("Demo Ignore this");
    expect(renderFamilyNotification(document)).not.toMatch(/[\u202a-\u202e]/);
  });
  it("renders a creation update only from the bounded structured document", () => {
    const document = parseFamilyNotificationDocument({
      kind: "calendar_creation",
      eventTitle: "Lunch with Ruth",
      startTime: "2026-07-21T18:00:00.000Z",
      endTime: "2026-07-21T19:00:00.000Z",
      timeZone: "America/Denver",
    });
    expect(renderFamilyNotification(document)).toBe(
      "“Lunch with Ruth” was added for Tuesday, Jul 21, 12:00–1:00 PM (Mountain time).\n\nApproved word-for-word before Bander sent it.",
    );
  });
  it("renders a cancellation update only from the bounded structured document", () => {
    const document = parseFamilyNotificationDocument({
      kind: "calendar_cancellation",
      eventTitle: "Dentist appointment",
      startTime: "2026-07-23T19:00:00.000Z",
      endTime: "2026-07-23T20:00:00.000Z",
      timeZone: "America/Denver",
    });
    expect(renderFamilyNotification(document)).toBe(
      "“Dentist appointment”, Thursday, Jul 23, 1:00–2:00 PM (Mountain time), is no longer on the calendar.\n\nApproved word-for-word before Bander sent it.",
    );
  });
});
