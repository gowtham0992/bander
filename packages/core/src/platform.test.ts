import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { corePlatform as browserPlatform } from "./platform-browser.js";
import { corePlatform as nodePlatform } from "./platform-node.js";
import { canonicalJson } from "./canonical.js";

describe("core platform cryptography", () => {
  it("matches the published SHA-256 known vector", () => {
    const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(nodePlatform.sha256Hex("abc")).toBe(expected);
    expect(browserPlatform.sha256Hex("abc")).toBe(expected);
  });

  it("keeps Node and browser canonical hashes byte-identical", () => {
    const canonical = canonicalJson({ z: "family", a: [1, { b: true, a: "calendar" }] });
    expect(browserPlatform.sha256Hex(canonical)).toBe(nodePlatform.sha256Hex(canonical));
    expect(browserPlatform.sha256Hex(canonical)).toBe(
      createHash("sha256").update(canonical).digest("hex"),
    );
  });

  it("decodes base64url identically", () => {
    const encoded = Buffer.from("Bander exact bytes").toString("base64url");
    expect(browserPlatform.base64UrlToBytes(encoded)).toEqual(nodePlatform.base64UrlToBytes(encoded));
  });

  it("produces RFC 4122 version-four UUIDs from browser CSPRNG", () => {
    expect(browserPlatform.randomUuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
