import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import type { CorePlatform } from "./platform-types.js";

export const corePlatform: CorePlatform = {
  sha256Hex(input) {
    return createHash("sha256").update(input).digest("hex");
  },
  randomUuid: randomUUID,
  base64UrlToBytes(value) {
    return new Uint8Array(Buffer.from(value, "base64url"));
  },
};
