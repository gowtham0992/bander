import type { DraftDocument } from "@bander/contracts";
import { corePlatform } from "#bander/platform";

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function hashDraft(document: DraftDocument): string {
  return hashCanonical(document);
}

export function hashCanonical(value: unknown): string {
  return corePlatform.sha256Hex(canonicalJson(value));
}
