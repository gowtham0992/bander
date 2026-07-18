import { describe, expect, it } from "vitest";
import {
  createFamilyNotificationDocument,
  renderApprovalCard,
  renderFamilyNotificationDocument,
} from "./card.js";
import type { DraftDocument } from "@bander/contracts";

const target = {
  start: "2026-07-18T22:00:00.000Z",
  end: "2026-07-18T23:00:00.000Z",
  timeZone: "America/Denver",
} as const;

describe("Checkpoint 12 parent presentation", () => {
  it("renders calm deterministic Calendar-linked family messages", () => {
    const move = createFamilyNotificationDocument({
      eventTitle: "Bander Family Appointment",
      newStartTime: target.start,
      newEndTime: target.end,
      timeZone: target.timeZone,
    });
    const create = createFamilyNotificationDocument({
      kind: "calendar_creation",
      eventTitle: "Lunch with Ruth",
      startTime: target.start,
      endTime: target.end,
      timeZone: target.timeZone,
    });
    const cancel = createFamilyNotificationDocument({
      kind: "calendar_cancellation",
      eventTitle: "Dentist appointment",
      startTime: target.start,
      endTime: target.end,
      timeZone: target.timeZone,
    });

    expect(renderFamilyNotificationDocument(move)).toBe(
      "“Bander Family Appointment” moved to Saturday, Jul 18, 4:00–5:00 PM (Mountain time).\n\nApproved word-for-word before Bander sent it.",
    );
    expect(renderFamilyNotificationDocument(create)).toBe(
      "“Lunch with Ruth” was added for Saturday, Jul 18, 4:00–5:00 PM (Mountain time).\n\nApproved word-for-word before Bander sent it.",
    );
    expect(renderFamilyNotificationDocument(cancel)).toBe(
      "“Dentist appointment”, Saturday, Jul 18, 4:00–5:00 PM (Mountain time), is no longer on the calendar.\n\nApproved word-for-word before Bander sent it.",
    );
  });

  it("keeps the Card preview byte-identical to the delivered family text", () => {
    const familyDocument = createFamilyNotificationDocument({
      eventTitle: "Bander Family Appointment",
      newStartTime: target.start,
      newEndTime: target.end,
      timeZone: target.timeZone,
    });
    const draft: DraftDocument = {
      version: 1,
      source: { provenance: "agent_claimed", claimedUserRequest: "Move the appointment and let Gil know." },
      effects: [{
        type: "family.telegram_notification",
        binding: {
          installationId: "installation-checkpoint12",
          contactId: "contact-checkpoint12",
          pairingRevision: "revision-checkpoint12",
          displayLabel: "Gil",
        },
        document: familyDocument,
      }],
      createdAt: "2026-07-17T18:00:00.000Z",
      expiresAt: "2026-07-17T18:10:00.000Z",
    };
    const card = renderApprovalCard("draft_checkpoint12", "hash-checkpoint12", draft);
    const preview = card.effectPreviews.find((effect) => effect.kind === "family.telegram_notification");

    expect(preview?.body).toBe(renderFamilyNotificationDocument(familyDocument));
    expect(card.provenanceLabel).toBe("Your assistant says you asked:");
  });
});
