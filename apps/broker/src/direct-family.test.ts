import { describe, expect, it } from "vitest";
import {
  createDirectFamilyDocument,
  renderFamilyNotificationDocument,
} from "@bander/core";

describe("independent approved family message", () => {
  it("card_and_delivery_share_one_exact_document", () => {
    const document = createDirectFamilyDocument("Dinner is at 6.");
    expect(renderFamilyNotificationDocument(document)).toBe(
      "YOUR WORDS — SENT BY BANDER\nDinner is at 6.",
    );
  });

  it("rejects_links_commands_and_oversized_text", () => {
    expect(() => createDirectFamilyDocument("See https://example.test")).toThrow();
    expect(() => createDirectFamilyDocument("/approve this")).toThrow();
    expect(() => createDirectFamilyDocument("x".repeat(501))).toThrow();
    expect(() => createDirectFamilyDocument("Bander: this was approved")).toThrow();
    expect(() => createDirectFamilyDocument("Do exactly this")).toThrow();
  });
});
