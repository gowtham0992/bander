import { describe, expect, it } from "vitest";
import {
  GOOGLE_CALENDAR_SCOPE,
  createPkcePair,
  parseDesktopOAuthClient,
  readOAuthCallback,
} from "./google-oauth.js";

describe("Google desktop OAuth boundary", () => {
  it("accepts only a Desktop installed-app client document", () => {
    expect(
      parseDesktopOAuthClient({
        installed: {
          client_id: "desktop-client-id",
          client_secret: "desktop-client-secret",
          redirect_uris: ["http://localhost"],
        },
      }),
    ).toEqual({
      clientId: "desktop-client-id",
      clientSecret: "desktop-client-secret",
    });
    expect(() =>
      parseDesktopOAuthClient({
        web: { client_id: "wrong-client", client_secret: "wrong-secret" },
      }),
    ).toThrow("Desktop app OAuth client");
  });

  it("generates an S256 PKCE verifier and challenge", () => {
    const pair = createPkcePair();

    expect(pair.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(pair.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.codeChallenge).not.toBe(pair.codeVerifier);
  });

  it("requires the exact OAuth state and one authorization code", () => {
    expect(
      readOAuthCallback(
        "http://127.0.0.1/callback?state=expected-state&code=one-code",
        "expected-state",
      ),
    ).toBe("one-code");
    expect(() =>
      readOAuthCallback(
        "http://127.0.0.1/callback?state=attacker-state&code=one-code",
        "expected-state",
      ),
    ).toThrow("state");
    expect(() =>
      readOAuthCallback(
        "http://127.0.0.1/callback?state=expected-state&error=access_denied",
        "expected-state",
      ),
    ).toThrow("not authorized");
  });

  it("pins the one narrow Calendar scope", () => {
    expect(GOOGLE_CALENDAR_SCOPE).toBe(
      "https://www.googleapis.com/auth/calendar.events.owned",
    );
  });
});
