import { createHash } from "node:crypto";
import { formatCalendarIntervalWithContext } from "@bander/core";
import type { ActiveFamilyContact } from "./family-contact.js";

export type FamilyNotificationDocument = {
  kind: "calendar_transition";
  eventTitle: string;
  newStartTime: string;
  newEndTime: string;
  timeZone: string;
};

export type FamilyNotificationOperation = {
  requestId: string;
  installationId: string;
  contactId: string;
  pairingRevision: string;
  contentDigest: string;
  document: FamilyNotificationDocument;
  status: "prepared" | "dispatching" | "delivered" | "ambiguous";
  createdAt: string;
  dispatchStartedAt?: string;
  deliveredAt?: string;
  telegramMessageId?: number;
  ambiguousAt?: string;
};

export class FamilyNotificationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function clean(value: string, maximum: number): string {
  return value.normalize("NFKC").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

export function parseFamilyNotificationDocument(value: unknown): FamilyNotificationDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FamilyNotificationError("invalid_document", "A structured family notification is required");
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["eventTitle", "kind", "newEndTime", "newStartTime", "timeZone"])) throw new FamilyNotificationError("invalid_document", "Family notifications cannot include a destination or message body");
  if (input.kind !== "calendar_transition" || typeof input.eventTitle !== "string" || typeof input.newStartTime !== "string" || typeof input.newEndTime !== "string" || typeof input.timeZone !== "string") throw new FamilyNotificationError("invalid_document", "Invalid family notification document");
  const eventTitle = clean(input.eventTitle, 120);
  const timeZone = clean(input.timeZone, 80);
  if (!eventTitle || !timeZone || !Number.isFinite(Date.parse(input.newStartTime)) || !Number.isFinite(Date.parse(input.newEndTime)) || Date.parse(input.newEndTime) <= Date.parse(input.newStartTime)) throw new FamilyNotificationError("invalid_document", "Invalid family notification document");
  try { new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(input.newStartTime)); } catch { throw new FamilyNotificationError("invalid_document", "Invalid family notification timezone"); }
  return { kind: "calendar_transition", eventTitle, newStartTime: new Date(input.newStartTime).toISOString(), newEndTime: new Date(input.newEndTime).toISOString(), timeZone };
}

export function notificationDigest(document: FamilyNotificationDocument): string { return digest(JSON.stringify(document)); }
export function pairingRevision(contact: ActiveFamilyContact): string { return digest(JSON.stringify([contact.installationId, contact.contactId, contact.pairedAt, contact.telegramUserId, contact.privateChatId])); }
export function renderFamilyNotification(document: FamilyNotificationDocument): string {
  return ["Bander update", `“${document.eventTitle}” is now ${formatCalendarIntervalWithContext(document.newStartTime, document.newEndTime, document.timeZone)}.`, "This update was sent by Bander at the owner’s request."].join("\n");
}
export function deliveryResult(operation: FamilyNotificationOperation): { status: "delivered" | "ambiguous" } {
  return { status: operation.status === "delivered" ? "delivered" : "ambiguous" };
}
