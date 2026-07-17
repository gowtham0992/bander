import { createHash } from "node:crypto";
import { renderFamilyNotificationDocument } from "@bander/core";
import type {
  FamilyNotificationDocument,
  FamilyTelegramNotificationEffect,
} from "@bander/contracts";
import type { ActiveFamilyContact } from "./family-contact.js";

export type { FamilyNotificationDocument } from "@bander/contracts";

export type FamilyNotificationOperation = {
  requestId: string;
  installationId: string;
  contactId: string;
  pairingRevision: string;
  contentDigest: string;
  document: FamilyNotificationDocument;
  status: "prepared" | "dispatching" | "delivered" | "ambiguous" | "not_sent";
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
  const transitionKeys = ["eventTitle", "kind", "newEndTime", "newStartTime", "timeZone"];
  const creationKeys = ["endTime", "eventTitle", "kind", "startTime", "timeZone"];
  if (
    JSON.stringify(keys) !== JSON.stringify(transitionKeys) &&
    JSON.stringify(keys) !== JSON.stringify(creationKeys)
  ) throw new FamilyNotificationError("invalid_document", "Family notifications cannot include a destination or message body");
  const creation = input.kind === "calendar_creation";
  const cancellation = input.kind === "calendar_cancellation";
  const start = creation || cancellation ? input.startTime : input.newStartTime;
  const end = creation || cancellation ? input.endTime : input.newEndTime;
  if ((input.kind !== "calendar_transition" && !creation && !cancellation) || typeof input.eventTitle !== "string" || typeof start !== "string" || typeof end !== "string" || typeof input.timeZone !== "string") throw new FamilyNotificationError("invalid_document", "Invalid family notification document");
  const eventTitle = clean(input.eventTitle, 120);
  const timeZone = clean(input.timeZone, 80);
  if (!eventTitle || !timeZone || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(end) <= Date.parse(start)) throw new FamilyNotificationError("invalid_document", "Invalid family notification document");
  try { new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(start)); } catch { throw new FamilyNotificationError("invalid_document", "Invalid family notification timezone"); }
  return creation
    ? { kind: "calendar_creation", eventTitle, startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString(), timeZone }
    : cancellation
      ? { kind: "calendar_cancellation", eventTitle, startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString(), timeZone }
      : { kind: "calendar_transition", eventTitle, newStartTime: new Date(start).toISOString(), newEndTime: new Date(end).toISOString(), timeZone };
}

export function notificationDigest(document: FamilyNotificationDocument): string { return digest(JSON.stringify(document)); }
export function pairingRevision(contact: ActiveFamilyContact): string { return digest(JSON.stringify([contact.installationId, contact.contactId, contact.pairedAt, contact.telegramUserId, contact.privateChatId])); }
export function renderFamilyNotification(document: FamilyNotificationDocument): string {
  return renderFamilyNotificationDocument(document);
}
export function deliveryResult(operation: FamilyNotificationOperation): { status: "delivered" | "ambiguous" | "not_sent" } {
  return {
    status:
      operation.status === "delivered"
        ? "delivered"
        : operation.status === "not_sent"
          ? "not_sent"
          : "ambiguous",
  };
}
export function sameFamilyBinding(
  operation: Pick<FamilyNotificationOperation, "installationId" | "contactId" | "pairingRevision">,
  binding: FamilyTelegramNotificationEffect["binding"],
): boolean {
  return operation.installationId === binding.installationId && operation.contactId === binding.contactId && operation.pairingRevision === binding.pairingRevision;
}
