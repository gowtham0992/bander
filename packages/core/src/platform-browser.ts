import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { CorePlatform } from "./platform-types.js";

const utf8 = new TextEncoder();

function browserCrypto(): Crypto {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Bander requires browser cryptographic randomness");
  }
  return globalThis.crypto;
}

function randomUuid(): string {
  const crypto = browserCrypto();
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("Invalid base64url value");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const decoded = atob(`${normalized}${padding}`);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export const corePlatform: CorePlatform = {
  sha256Hex(input) {
    return bytesToHex(sha256(typeof input === "string" ? utf8.encode(input) : input));
  },
  randomUuid,
  base64UrlToBytes,
};
