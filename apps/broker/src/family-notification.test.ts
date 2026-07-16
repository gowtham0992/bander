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
});
