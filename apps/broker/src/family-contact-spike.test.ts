import { describe, expect, it } from "vitest";
import {
  claimFamilyContact,
  createFamilyContactChallenge,
  revokeFamilyContact,
  sanitizeFamilyContactEvidence,
} from "./family-contact-spike.js";

const now = Date.parse("2026-07-15T12:00:00-06:00");
const ownerTelegramId = 111_111;
const contactTelegramId = 222_222;

function challenge() {
  return createFamilyContactChallenge({
    ownerTelegramId,
    now,
    ttlMs: 5 * 60_000,
  });
}

function privateStart(fromId: number, token: string) {
  return {
    update_id: 9001,
    message: {
      message_id: 41,
      from: { id: fromId, is_bot: false },
      chat: { id: fromId, type: "private" as const },
      text: `/start family_${token}`,
    },
  };
}

describe("isolated family-contact spike boundary", () => {
  it("derives the contact destination only from a valid authenticated private update", () => {
    const current = challenge();

    const result = claimFamilyContact(
      current.state,
      privateStart(contactTelegramId, current.token),
      now + 1_000,
    );

    expect(result.status).toBe("paired");
    if (result.status !== "paired") throw new Error("expected pairing");
    expect(result.state.contactTelegramId).toBe(contactTelegramId);
    expect(result.state.contactChatId).toBe(contactTelegramId);
    expect(result.state.capabilities).toEqual(["receive_canary"]);
  });

  it.each(["owner", "group", "bot", "wrong token"])(
    "rejects %s claims",
    (kind) => {
      const current = challenge();
      const valid = privateStart(contactTelegramId, current.token);
      const update =
        kind === "owner"
          ? privateStart(ownerTelegramId, current.token)
          : kind === "group"
            ? {
                ...valid,
                message: {
                  ...valid.message,
                  chat: { id: -999_999, type: "group" as const },
                },
              }
            : kind === "bot"
              ? {
                  ...valid,
                  message: {
                    ...valid.message,
                    from: { id: contactTelegramId, is_bot: true },
                  },
                }
              : privateStart(contactTelegramId, "redirect_to_someone_else");
      expect(claimFamilyContact(current.state, update, now + 1_000).status).toBe(
        "rejected",
      );
    },
  );

  it("locks the first valid claimant and cannot be redirected", () => {
    const current = challenge();
    const first = claimFamilyContact(
      current.state,
      privateStart(contactTelegramId, current.token),
      now + 1_000,
    );
    if (first.status !== "paired") throw new Error("expected pairing");

    const second = claimFamilyContact(
      first.state,
      privateStart(333_333, current.token),
      now + 2_000,
    );
    expect(second.status).toBe("rejected");
    expect(second.state.contactTelegramId).toBe(contactTelegramId);
    expect(second.state.contactChatId).toBe(contactTelegramId);
  });

  it("expires, revokes only from the paired private chat, and emits identifier-free evidence", () => {
    const current = challenge();
    expect(
      claimFamilyContact(
        current.state,
        privateStart(contactTelegramId, current.token),
        now + 6 * 60_000,
      ).status,
    ).toBe("rejected");

    const paired = claimFamilyContact(
      current.state,
      privateStart(contactTelegramId, current.token),
      now + 1_000,
    );
    if (paired.status !== "paired") throw new Error("expected pairing");
    expect(
      revokeFamilyContact(paired.state, {
        ...privateStart(333_333, current.token),
        message: {
          ...privateStart(333_333, current.token).message,
          text: "/revoke",
        },
      }).status,
    ).toBe("rejected");

    const revoked = revokeFamilyContact(paired.state, {
      ...privateStart(contactTelegramId, current.token),
      message: {
        ...privateStart(contactTelegramId, current.token).message,
        text: "/revoke",
      },
    });
    expect(revoked.status).toBe("revoked");
    const evidence = sanitizeFamilyContactEvidence({
      paired: true,
      canaryConfirmed: true,
      revoked: true,
    });
    expect(evidence).toEqual({
      explicitPrivateConsent: true,
      destinationFromAuthenticatedUpdate: true,
      canaryDeliveryConfirmed: true,
      ownerAuthorityGranted: false,
      contactCapabilities: ["receive_canary"],
      ownerAndContactDistinct: true,
      agentSuppliedDestinationAccepted: false,
      calendarOrAuthorityTouched: false,
      temporaryPairingRevoked: true,
      productionPairingStateUnchanged: true,
      privateIdentifiersPrinted: false,
    });
    expect(JSON.stringify(evidence)).not.toMatch(
      new RegExp(`${ownerTelegramId}|${contactTelegramId}`),
    );
  });
});
