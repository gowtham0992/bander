import { describe, expect, it } from "vitest";
import {
  acceptFamilyContactChallenge,
  claimFamilyContactChallenge,
  createFamilyContactChallenge,
  isRevokedContactSurface,
  normalizeFamilyContactConfiguration,
  revokeActiveFamilyContact,
  validateFamilyContactState,
} from "./family-contact.js";

const now = Date.parse("2026-07-16T18:00:00.000Z");
const installation = {
  id: "installation-owner",
  ownerTelegramId: "101",
  chatId: "-500",
  pairedAt: "2026-07-14T18:00:00.000Z",
};

function pending() {
  return createFamilyContactChallenge({
    installationId: installation.id,
    displayLabel: "Gil",
    aliases: ["my son", "son"],
    token: "family-contact-secret-token",
    challengeId: "family-challenge",
    contactId: "family-contact",
    now: new Date(now),
    ttlMs: 10 * 60_000,
  });
}

function claimed() {
  return claimFamilyContactChallenge({
    challenge: pending(),
    installation,
    token: "family-contact-secret-token",
    now: new Date(now + 1_000),
    claimant: { userId: "202", chatId: "202", chatType: "private", isBot: false },
    protectedGroupStatus: "left",
    consentMessageId: 41,
    acceptCallbackValue: "family-accept:opaque",
    declineCallbackValue: "family-decline:opaque",
  });
}

function active() {
  return acceptFamilyContactChallenge({
    challenge: claimed().challenge,
    installation,
    now: new Date(now + 2_000),
    protectedGroupStatus: "left",
    callback: {
      fromUserId: "202",
      isBot: false,
      chatId: "202",
      chatType: "private",
      messageId: 41,
      data: "family-accept:opaque",
    },
    contactRevokeCallbackValue: "family-contact-off:opaque",
    ownerRevokeCallbackValue: "family-owner-off:opaque",
  });
}

describe("production family-contact state boundary", () => {
  it("normalizes only operator-configured labels and aliases", () => {
    expect(
      normalizeFamilyContactConfiguration({
        displayLabel: "  GIL\u202e  ",
        aliases: [" My   Son ", "SON", "my son"],
      }),
    ).toEqual({ displayLabel: "GIL", aliases: ["gil", "my son", "son"] });
  });

  it("stores only the challenge token hash", () => {
    const challenge = pending();
    expect(challenge.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(challenge)).not.toContain("family-contact-secret-token");
    expect(challenge.status).toBe("pending");
  });

  it.each([
    ["expired", { now: new Date(now + 11 * 60_000) }],
    ["wrong token", { token: "wrong-token" }],
    ["wrong installation", { installation: { ...installation, id: "other" } }],
    ["owner", { claimant: { userId: "101", chatId: "101", chatType: "private", isBot: false } }],
    ["bot", { claimant: { userId: "202", chatId: "202", chatType: "private", isBot: true } }],
    ["group", { claimant: { userId: "202", chatId: "-500", chatType: "group", isBot: false } }],
    ["supergroup", { claimant: { userId: "202", chatId: "-501", chatType: "supergroup", isBot: false } }],
    ["channel", { claimant: { userId: "202", chatId: "-502", chatType: "channel", isBot: false } }],
    ["identity collision", { claimant: { userId: "202", chatId: "203", chatType: "private", isBot: false } }],
    ["still in protected group", { protectedGroupStatus: "member" }],
    ["restricted in protected group", { protectedGroupStatus: "restricted" }],
    ["membership unavailable", { protectedGroupStatus: "unknown" }],
  ] as const)("rejects %s claims without binding a destination", (_name, override) => {
    expect(() =>
      claimFamilyContactChallenge({
        challenge: pending(),
        installation,
        token: "family-contact-secret-token",
        now: new Date(now + 1_000),
        claimant: { userId: "202", chatId: "202", chatType: "private", isBot: false },
        protectedGroupStatus: "left",
        consentMessageId: 41,
        acceptCallbackValue: "family-accept:opaque",
        declineCallbackValue: "family-decline:opaque",
        ...override,
      }),
    ).toThrow();
  });

  it("locks the first valid claimant and rejects a racing second claimant", () => {
    const first = claimed();
    expect(first.challenge.claimedTelegramUserId).toBe("202");
    expect(() =>
      claimFamilyContactChallenge({
        challenge: first.challenge,
        installation,
        token: "family-contact-secret-token",
        now: new Date(now + 2_000),
        claimant: { userId: "303", chatId: "303", chatType: "private", isBot: false },
        protectedGroupStatus: "left",
        consentMessageId: 42,
        acceptCallbackValue: "family-accept:second",
        declineCallbackValue: "family-decline:second",
      }),
    ).toThrow("already claimed");
  });

  it("makes same-claimant token replay idempotent without changing callbacks", () => {
    const first = claimed();
    const replay = claimFamilyContactChallenge({
      challenge: first.challenge,
      installation,
      token: "family-contact-secret-token",
      now: new Date(now + 2_000),
      claimant: { userId: "202", chatId: "202", chatType: "private", isBot: false },
      protectedGroupStatus: "left",
      consentMessageId: 99,
      acceptCallbackValue: "family-accept:changed",
      declineCallbackValue: "family-decline:changed",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.challenge).toEqual(first.challenge);
  });

  it("rejects an old token after an operator creates a new challenge", () => {
    const replacement = createFamilyContactChallenge({
      installationId: installation.id,
      displayLabel: "Gil",
      aliases: ["my son"],
      token: "replacement-family-token",
      challengeId: "replacement-challenge",
      contactId: "replacement-contact",
      now: new Date(now + 2_000),
      ttlMs: 10 * 60_000,
    });

    expect(() =>
      claimFamilyContactChallenge({
        challenge: replacement,
        installation,
        token: "family-contact-secret-token",
        now: new Date(now + 3_000),
        claimant: {
          userId: "202",
          chatId: "202",
          chatType: "private",
          isBot: false,
        },
        protectedGroupStatus: "left",
        consentMessageId: 41,
        acceptCallbackValue: "family-accept:opaque",
        declineCallbackValue: "family-decline:opaque",
      }),
    ).toThrow("invalid");
  });

  it.each([
    ["wrong user", { fromUserId: "303" }],
    ["owner", { fromUserId: "101", chatId: "101" }],
    ["bot", { isBot: true }],
    ["wrong chat", { chatId: "203" }],
    ["group", { chatId: "-500", chatType: "group" }],
    ["wrong message", { messageId: 42 }],
    ["wrong callback", { data: "family-accept:wrong" }],
  ])("rejects consent from the %s surface", (_name, override) => {
    expect(() =>
      acceptFamilyContactChallenge({
        challenge: claimed().challenge,
        installation,
        now: new Date(now + 2_000),
        protectedGroupStatus: "left",
        callback: {
          fromUserId: "202",
          isBot: false,
          chatId: "202",
          chatType: "private",
          messageId: 41,
          data: "family-accept:opaque",
          ...override,
        },
        contactRevokeCallbackValue: "family-contact-off:opaque",
        ownerRevokeCallbackValue: "family-owner-off:opaque",
      }),
    ).toThrow();
  });

  it("rechecks protected-group membership at consent time", () => {
    expect(() =>
      acceptFamilyContactChallenge({
        challenge: claimed().challenge,
        installation,
        now: new Date(now + 2_000),
        protectedGroupStatus: "member",
        callback: {
          fromUserId: "202",
          isBot: false,
          chatId: "202",
          chatType: "private",
          messageId: 41,
          data: "family-accept:opaque",
        },
        contactRevokeCallbackValue: "family-contact-off:opaque",
        ownerRevokeCallbackValue: "family-owner-off:opaque",
      }),
    ).toThrow("protected owner group");
  });

  it("activates one immutable contact without owner authority", () => {
    const contact = active();
    expect(contact).toMatchObject({
      contactId: "family-contact",
      installationId: installation.id,
      displayLabel: "Gil",
      aliases: ["gil", "my son", "son"],
      telegramUserId: "202",
      privateChatId: "202",
      status: "active",
    });
    expect(contact).not.toHaveProperty("ownerTelegramId");
    expect(contact).not.toHaveProperty("approval");
  });

  it("revocation erases the routable destination but retains opaque replay audit", () => {
    const current = active();
    const audit = revokeActiveFamilyContact(current, {
      now: new Date(now + 3_000),
      revokedBy: "contact",
    });
    const serialized = JSON.stringify(audit);
    expect(audit.status).toBe("revoked");
    expect(serialized).not.toContain('"202"');
    expect(serialized).not.toContain("Gil");
    expect(serialized).not.toContain("my son");
    expect(
      isRevokedContactSurface(audit, { userId: "202", chatId: "202" }),
    ).toBe(true);
  });

  it("validates restart state and fails closed on corruption or wrong installation", () => {
    const contact = active();
    expect(() =>
      validateFamilyContactState({
        installation,
        familyContact: contact,
      }),
    ).not.toThrow();
    expect(() =>
      validateFamilyContactState({
        installation,
        familyContact: { ...contact, installationId: "other" },
      }),
    ).toThrow("installation");
    expect(() =>
      validateFamilyContactState({
        installation,
        familyContact: { ...contact, privateChatId: "not-a-telegram-id" },
      }),
    ).toThrow("family contact state");
  });
});
