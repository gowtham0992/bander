import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

type PrivateMessageUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; is_bot: boolean };
    chat: { id: number; type: string };
    text?: string;
  };
};

export type FamilyContactSpikeState = {
  tokenHash: string;
  ownerTelegramId: number;
  expiresAt: number;
  status: "pending" | "paired" | "revoked";
  contactTelegramId?: number;
  contactChatId?: number;
  capabilities: readonly ["receive_canary"];
};

type ClaimResult =
  | { status: "paired"; state: FamilyContactSpikeState }
  | { status: "rejected"; reason: string; state: FamilyContactSpikeState };

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tokenMatches(expectedHash: string, token: string): boolean {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createFamilyContactChallenge(input: {
  ownerTelegramId: number;
  now: number;
  ttlMs: number;
}): { token: string; state: FamilyContactSpikeState } {
  if (input.ttlMs <= 0) {
    throw new Error("invalid_family_contact_challenge");
  }
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    state: {
      tokenHash: hashToken(token),
      ownerTelegramId: input.ownerTelegramId,
      expiresAt: input.now + input.ttlMs,
      status: "pending",
      capabilities: ["receive_canary"],
    },
  };
}

export function claimFamilyContact(
  state: FamilyContactSpikeState,
  update: PrivateMessageUpdate,
  now: number,
): ClaimResult {
  const message = update.message;
  const from = message?.from;
  if (state.status !== "pending") {
    return { status: "rejected", reason: "challenge_not_pending", state };
  }
  if (now > state.expiresAt) {
    return { status: "rejected", reason: "challenge_expired", state };
  }
  if (
    !message ||
    !from ||
    from.is_bot ||
    message.chat.type !== "private" ||
    message.chat.id !== from.id ||
    from.id === state.ownerTelegramId
  ) {
    return { status: "rejected", reason: "invalid_claimant_surface", state };
  }
  const match = message.text?.match(/^\/start family_([A-Za-z0-9_-]+)$/);
  if (!match?.[1] || !tokenMatches(state.tokenHash, match[1])) {
    return { status: "rejected", reason: "invalid_pairing_token", state };
  }
  return {
    status: "paired",
    state: {
      ...state,
      status: "paired",
      contactTelegramId: from.id,
      contactChatId: message.chat.id,
    },
  };
}

export function revokeFamilyContact(
  state: FamilyContactSpikeState,
  update: PrivateMessageUpdate,
):
  | { status: "revoked"; state: FamilyContactSpikeState }
  | { status: "rejected"; reason: string; state: FamilyContactSpikeState } {
  const message = update.message;
  if (
    state.status !== "paired" ||
    !message?.from ||
    message.from.is_bot ||
    message.chat.type !== "private" ||
    message.from.id !== state.contactTelegramId ||
    message.chat.id !== state.contactChatId ||
    message.text?.trim() !== "/revoke"
  ) {
    return { status: "rejected", reason: "invalid_revoke_surface", state };
  }
  return {
    status: "revoked",
    state: {
      tokenHash: state.tokenHash,
      ownerTelegramId: state.ownerTelegramId,
      expiresAt: state.expiresAt,
      status: "revoked",
      capabilities: ["receive_canary"],
    },
  };
}

export function sanitizeFamilyContactEvidence(input: {
  paired: boolean;
  canaryConfirmed: boolean;
  revoked: boolean;
  productionStateUnchanged?: boolean;
}) {
  return {
    explicitPrivateConsent: input.paired,
    destinationFromAuthenticatedUpdate: input.paired,
    canaryDeliveryConfirmed: input.canaryConfirmed,
    ownerAuthorityGranted: false,
    contactCapabilities: ["receive_canary"],
    ownerAndContactDistinct: input.paired,
    agentSuppliedDestinationAccepted: false,
    calendarOrAuthorityTouched: false,
    temporaryPairingRevoked: input.revoked,
    productionPairingStateUnchanged: input.productionStateUnchanged ?? true,
    privateIdentifiersPrinted: false,
  } as const;
}
