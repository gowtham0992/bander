import { describe, expect, it } from "vitest";
import { GmailDispatchUnconfirmedError, localDateBoundaryEpochSeconds } from "./google-gmail.js";

describe("Gmail local-date query boundaries", () => {
  it("uses the connected timezone across Mountain daylight-saving boundaries", () => {
    expect(new Date(localDateBoundaryEpochSeconds("2026-01-15", "America/Denver") * 1000).toISOString()).toBe("2026-01-15T07:00:00.000Z");
    expect(new Date(localDateBoundaryEpochSeconds("2026-07-16", "America/Denver") * 1000).toISOString()).toBe("2026-07-16T06:00:00.000Z");
  });

  it("classifies every post-dispatch Google error as unconfirmed without leaking the raw error", () => {
    const error = new GmailDispatchUnconfirmedError();
    expect(error).toMatchObject({ ambiguous: true, message: "gmail_send_result_unconfirmed" });
    expect(JSON.stringify(error)).not.toContain("token");
  });
});
