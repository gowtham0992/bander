import { createHash, timingSafeEqual } from "node:crypto";

export type ProtectedGroupMemberStatus =
  | "creator"
  | "administrator"
  | "member"
  | "restricted"
  | "left"
  | "kicked"
  | "unknown";

export interface FamilyContactPairingChallenge {
  challengeId: string;
  contactId: string;
  installationId: string;
  displayLabel: string;
  aliases: string[];
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "claimed";
  claimedTelegramUserId?: string;
  claimedPrivateChatId?: string;
  claimedAt?: string;
  consentMessageId?: number;
  acceptCallbackValue?: string;
  declineCallbackValue?: string;
}

export interface ActiveFamilyContact {
  contactId: string;
  installationId: string;
  displayLabel: string;
  aliases: string[];
  telegramUserId: string;
  privateChatId: string;
  status: "active";
  pairedAt: string;
  consentMessageId: number;
  pairingAcceptCallbackHash: string;
  contactRevokeCallbackValue: string;
  ownerRevokeCallbackValue: string;
  contactConfirmationMessageId?: number;
  contactConfirmationDeliveredAt?: string;
  ownerConfirmationMessageId?: number;
  ownerConfirmationDeliveredAt?: string;
}

export interface RevokedFamilyContactAudit {
  contactId: string;
  installationId: string;
  status: "revoked";
  pairedAt: string;
  revokedAt: string;
  revokedBy: "owner" | "contact" | "system";
  contactTelegramUserHash: string;
  contactPrivateChatHash: string;
  contactRevokeCallbackHash: string;
  ownerRevokeCallbackHash: string;
  contactConfirmationMessageId?: number;
  ownerConfirmationMessageId?: number;
}

export interface FamilyContactInstallation {
  id: string;
  ownerTelegramId: string;
  chatId: string;
  pairedAt: string;
}

export class FamilyContactError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FamilyContactError";
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function matchesHash(value: string, expectedHash: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  const actual = Buffer.from(hash(value), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return timingSafeEqual(actual, expected);
}

function safeText(value: string, maxLength: number): string {
  return value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeAlias(value: string): string {
  return safeText(value, 60).toLocaleLowerCase("en-US");
}

export function normalizeFamilyContactConfiguration(input: {
  displayLabel: string;
  aliases: readonly string[];
}): { displayLabel: string; aliases: string[] } {
  const displayLabel = safeText(input.displayLabel, 60);
  if (!displayLabel) {
    throw new FamilyContactError(
      "invalid_contact_label",
      "Family contact name must contain visible text",
    );
  }
  const aliases = [normalizeAlias(displayLabel), ...input.aliases.map(normalizeAlias)]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);
  if (aliases.length < 1 || aliases.length > 10) {
    throw new FamilyContactError(
      "invalid_contact_aliases",
      "Configure between one and ten family contact aliases",
    );
  }
  return { displayLabel, aliases };
}

function assertOpaque(value: string, field: string): void {
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(value)) {
    throw new FamilyContactError(
      "invalid_family_contact_state",
      `Invalid ${field} in family contact state`,
    );
  }
}

function assertCallback(value: string, field: string): void {
  if (
    value.length < 12 ||
    Buffer.byteLength(value, "utf8") > 64 ||
    !/^[A-Za-z0-9:_-]+$/.test(value)
  ) {
    throw new FamilyContactError(
      "invalid_family_contact_state",
      `Invalid ${field} in family contact state`,
    );
  }
}

function assertTimestamp(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new FamilyContactError(
      "invalid_family_contact_state",
      `Invalid ${field} in family contact state`,
    );
  }
}

function assertPositiveTelegramId(value: string, field: string): void {
  const numeric = Number(value);
  if (
    !/^[1-9]\d{0,15}$/.test(value) ||
    !Number.isSafeInteger(numeric) ||
    numeric <= 0
  ) {
    throw new FamilyContactError(
      "invalid_family_contact_state",
      `Invalid ${field} in family contact state`,
    );
  }
}

function assertInstallation(installation: FamilyContactInstallation | undefined): asserts installation is FamilyContactInstallation {
  if (!installation) {
    throw new FamilyContactError(
      "installation_missing",
      "The Bander Telegram installation must be paired first",
    );
  }
  assertOpaque(installation.id, "installation ID");
  assertPositiveTelegramId(installation.ownerTelegramId, "owner Telegram ID");
  const numericChatId = Number(installation.chatId);
  if (
    !/^-?[1-9]\d{0,15}$/.test(installation.chatId) ||
    !Number.isSafeInteger(numericChatId) ||
    numericChatId === 0
  ) {
    throw new FamilyContactError(
      "invalid_family_contact_state",
      "Invalid protected group in family contact state",
    );
  }
  assertTimestamp(installation.pairedAt, "installation pairing timestamp");
}

function assertOutsideProtectedGroup(status: ProtectedGroupMemberStatus): void {
  if (status !== "left" && status !== "kicked") {
    throw new FamilyContactError(
      status === "unknown"
        ? "protected_group_membership_unavailable"
        : "contact_in_protected_group",
      status === "unknown"
        ? "Bander could not verify that this contact is outside the protected owner group"
        : "The family contact must leave the protected owner group before pairing",
    );
  }
}

export function createFamilyContactChallenge(input: {
  installationId: string;
  displayLabel: string;
  aliases: readonly string[];
  token: string;
  challengeId: string;
  contactId: string;
  now: Date;
  ttlMs: number;
}): FamilyContactPairingChallenge {
  assertOpaque(input.installationId, "installation ID");
  assertOpaque(input.challengeId, "challenge ID");
  assertOpaque(input.contactId, "contact ID");
  if (
    !/^[A-Za-z0-9_-]{16,48}$/.test(input.token) ||
    !Number.isFinite(input.now.getTime()) ||
    input.ttlMs < 60_000 ||
    input.ttlMs > 15 * 60_000
  ) {
    throw new FamilyContactError(
      "invalid_family_contact_challenge",
      "Family contact pairing requires a short valid challenge",
    );
  }
  const normalized = normalizeFamilyContactConfiguration(input);
  return {
    challengeId: input.challengeId,
    contactId: input.contactId,
    installationId: input.installationId,
    displayLabel: normalized.displayLabel,
    aliases: normalized.aliases,
    tokenHash: hash(input.token),
    createdAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + input.ttlMs).toISOString(),
    status: "pending",
  };
}

export function claimFamilyContactChallenge(input: {
  challenge: FamilyContactPairingChallenge;
  installation: FamilyContactInstallation;
  token: string;
  now: Date;
  claimant: {
    userId: string;
    chatId: string;
    chatType: string;
    isBot: boolean;
  };
  protectedGroupStatus: ProtectedGroupMemberStatus;
  consentMessageId?: number;
  acceptCallbackValue: string;
  declineCallbackValue: string;
}): { challenge: FamilyContactPairingChallenge; replayed: boolean } {
  assertInstallation(input.installation);
  if (input.challenge.installationId !== input.installation.id) {
    throw new FamilyContactError(
      "installation_mismatch",
      "The family contact challenge belongs to another installation",
    );
  }
  if (
    !Number.isFinite(input.now.getTime()) ||
    input.now.getTime() >= Date.parse(input.challenge.expiresAt)
  ) {
    throw new FamilyContactError(
      "family_pairing_expired",
      "That family contact link expired",
    );
  }
  if (!matchesHash(input.token, input.challenge.tokenHash)) {
    throw new FamilyContactError(
      "invalid_family_pairing_token",
      "That family contact link is invalid",
    );
  }
  const claimant = input.claimant;
  if (
    claimant.isBot ||
    claimant.chatType !== "private" ||
    claimant.chatId !== claimant.userId ||
    !/^[1-9]\d{0,15}$/.test(claimant.userId) ||
    !Number.isSafeInteger(Number(claimant.userId)) ||
    claimant.userId === input.installation.ownerTelegramId
  ) {
    throw new FamilyContactError(
      "invalid_family_claimant",
      "Only the invited human contact can claim this private link",
    );
  }
  assertOutsideProtectedGroup(input.protectedGroupStatus);
  if (input.challenge.status === "claimed") {
    if (
      input.challenge.claimedTelegramUserId === claimant.userId &&
      input.challenge.claimedPrivateChatId === claimant.chatId
    ) {
      return { challenge: input.challenge, replayed: true };
    }
    throw new FamilyContactError(
      "family_pairing_already_claimed",
      "That family contact challenge is already claimed",
    );
  }
  if (
    input.consentMessageId !== undefined &&
    (!Number.isSafeInteger(input.consentMessageId) || input.consentMessageId <= 0)
  ) {
    throw new FamilyContactError(
      "invalid_family_contact_state",
      "Invalid consent message in family contact state",
    );
  }
  assertCallback(input.acceptCallbackValue, "accept callback");
  assertCallback(input.declineCallbackValue, "decline callback");
  return {
    replayed: false,
    challenge: {
      ...input.challenge,
      status: "claimed",
      claimedTelegramUserId: claimant.userId,
      claimedPrivateChatId: claimant.chatId,
      claimedAt: input.now.toISOString(),
      ...(input.consentMessageId !== undefined
        ? { consentMessageId: input.consentMessageId }
        : {}),
      acceptCallbackValue: input.acceptCallbackValue,
      declineCallbackValue: input.declineCallbackValue,
    },
  };
}

export function acceptFamilyContactChallenge(input: {
  challenge: FamilyContactPairingChallenge;
  installation: FamilyContactInstallation;
  now: Date;
  protectedGroupStatus: ProtectedGroupMemberStatus;
  callback: {
    fromUserId: string;
    isBot: boolean;
    chatId: string;
    chatType: string;
    messageId: number;
    data: string;
  };
  contactRevokeCallbackValue: string;
  ownerRevokeCallbackValue: string;
}): ActiveFamilyContact {
  assertInstallation(input.installation);
  const challenge = input.challenge;
  if (
    challenge.installationId !== input.installation.id ||
    challenge.status !== "claimed"
  ) {
    throw new FamilyContactError(
      "installation_mismatch",
      "The family contact challenge does not belong to this installation",
    );
  }
  if (
    !Number.isFinite(input.now.getTime()) ||
    input.now.getTime() >= Date.parse(challenge.expiresAt)
  ) {
    throw new FamilyContactError(
      "family_pairing_expired",
      "That family contact link expired",
    );
  }
  assertOutsideProtectedGroup(input.protectedGroupStatus);
  const callback = input.callback;
  if (
    callback.isBot ||
    callback.chatType !== "private" ||
    callback.fromUserId !== challenge.claimedTelegramUserId ||
    callback.chatId !== challenge.claimedPrivateChatId ||
    callback.chatId !== callback.fromUserId ||
    callback.messageId !== challenge.consentMessageId ||
    callback.data !== challenge.acceptCallbackValue ||
    callback.fromUserId === input.installation.ownerTelegramId
  ) {
    throw new FamilyContactError(
      "invalid_family_consent",
      "That family contact consent is not valid here",
    );
  }
  assertCallback(input.contactRevokeCallbackValue, "contact revoke callback");
  assertCallback(input.ownerRevokeCallbackValue, "owner revoke callback");
  return {
    contactId: challenge.contactId,
    installationId: challenge.installationId,
    displayLabel: challenge.displayLabel,
    aliases: [...challenge.aliases],
    telegramUserId: callback.fromUserId,
    privateChatId: callback.chatId,
    status: "active",
    pairedAt: input.now.toISOString(),
    consentMessageId: challenge.consentMessageId!,
    pairingAcceptCallbackHash: hash(challenge.acceptCallbackValue!),
    contactRevokeCallbackValue: input.contactRevokeCallbackValue,
    ownerRevokeCallbackValue: input.ownerRevokeCallbackValue,
  };
}

function surfaceHash(kind: "user" | "chat", value: string): string {
  return hash(`family-contact-${kind}:${value}`);
}

export function revokeActiveFamilyContact(
  contact: ActiveFamilyContact,
  input: { now: Date; revokedBy: "owner" | "contact" | "system" },
): RevokedFamilyContactAudit {
  if (!Number.isFinite(input.now.getTime())) {
    throw new FamilyContactError(
      "invalid_family_contact_state",
      "Invalid family contact revocation time",
    );
  }
  return {
    contactId: contact.contactId,
    installationId: contact.installationId,
    status: "revoked",
    pairedAt: contact.pairedAt,
    revokedAt: input.now.toISOString(),
    revokedBy: input.revokedBy,
    contactTelegramUserHash: surfaceHash("user", contact.telegramUserId),
    contactPrivateChatHash: surfaceHash("chat", contact.privateChatId),
    contactRevokeCallbackHash: hash(contact.contactRevokeCallbackValue),
    ownerRevokeCallbackHash: hash(contact.ownerRevokeCallbackValue),
    ...(contact.contactConfirmationMessageId
      ? { contactConfirmationMessageId: contact.contactConfirmationMessageId }
      : {}),
    ...(contact.ownerConfirmationMessageId
      ? { ownerConfirmationMessageId: contact.ownerConfirmationMessageId }
      : {}),
  };
}

export function isRevokedContactSurface(
  audit: RevokedFamilyContactAudit,
  input: { userId: string; chatId: string },
): boolean {
  return (
    matchesHash(`family-contact-user:${input.userId}`, audit.contactTelegramUserHash) &&
    matchesHash(`family-contact-chat:${input.chatId}`, audit.contactPrivateChatHash)
  );
}

function validateChallenge(
  challenge: FamilyContactPairingChallenge,
  installation: FamilyContactInstallation,
): void {
  assertOpaque(challenge.challengeId, "challenge ID");
  assertOpaque(challenge.contactId, "contact ID");
  if (challenge.installationId !== installation.id) {
    throw new FamilyContactError(
      "installation_mismatch",
      "Family contact challenge installation mismatch",
    );
  }
  const normalized = normalizeFamilyContactConfiguration(challenge);
  if (
    normalized.displayLabel !== challenge.displayLabel ||
    JSON.stringify(normalized.aliases) !== JSON.stringify(challenge.aliases) ||
    !/^[a-f0-9]{64}$/.test(challenge.tokenHash)
  ) {
    throw new FamilyContactError(
      "invalid_family_contact_state",
      "Invalid family contact state",
    );
  }
  assertTimestamp(challenge.createdAt, "challenge creation timestamp");
  assertTimestamp(challenge.expiresAt, "challenge expiry timestamp");
  const lifetime =
    Date.parse(challenge.expiresAt) - Date.parse(challenge.createdAt);
  if (lifetime < 60_000 || lifetime > 15 * 60_000) {
    throw new FamilyContactError(
      "invalid_family_contact_state",
      "Invalid family contact state",
    );
  }
  if (
    challenge.status === "pending" &&
    (challenge.claimedTelegramUserId !== undefined ||
      challenge.claimedPrivateChatId !== undefined ||
      challenge.claimedAt !== undefined ||
      challenge.consentMessageId !== undefined ||
      challenge.acceptCallbackValue !== undefined ||
      challenge.declineCallbackValue !== undefined)
  ) {
    throw new FamilyContactError(
      "invalid_family_contact_state",
      "Invalid family contact state",
    );
  }
  if (challenge.status === "claimed") {
    assertPositiveTelegramId(challenge.claimedTelegramUserId ?? "", "claimed user");
    assertPositiveTelegramId(challenge.claimedPrivateChatId ?? "", "claimed chat");
    if (
      challenge.claimedTelegramUserId !== challenge.claimedPrivateChatId ||
      challenge.claimedTelegramUserId === installation.ownerTelegramId ||
      !challenge.acceptCallbackValue ||
      !challenge.declineCallbackValue ||
      !challenge.claimedAt
    ) {
      throw new FamilyContactError(
        "invalid_family_contact_state",
        "Invalid family contact state",
      );
    }
    assertTimestamp(challenge.claimedAt, "challenge claim timestamp");
    assertCallback(challenge.acceptCallbackValue, "accept callback");
    assertCallback(challenge.declineCallbackValue, "decline callback");
    if (
      challenge.consentMessageId !== undefined &&
      (!Number.isSafeInteger(challenge.consentMessageId) ||
        challenge.consentMessageId <= 0)
    ) {
      throw new FamilyContactError(
        "invalid_family_contact_state",
        "Invalid family contact state",
      );
    }
  }
}

function validateActiveContact(
  contact: ActiveFamilyContact,
  installation: FamilyContactInstallation,
): void {
  assertOpaque(contact.contactId, "contact ID");
  if (contact.installationId !== installation.id) {
    throw new FamilyContactError(
      "installation_mismatch",
      "Family contact installation mismatch",
    );
  }
  const normalized = normalizeFamilyContactConfiguration(contact);
  if (
    normalized.displayLabel !== contact.displayLabel ||
    JSON.stringify(normalized.aliases) !== JSON.stringify(contact.aliases) ||
    contact.status !== "active"
  ) {
    throw new FamilyContactError(
      "invalid_family_contact_state",
      "Invalid family contact state",
    );
  }
  assertPositiveTelegramId(contact.telegramUserId, "contact Telegram user");
  assertPositiveTelegramId(contact.privateChatId, "contact private chat");
  if (
    contact.telegramUserId !== contact.privateChatId ||
    contact.telegramUserId === installation.ownerTelegramId
  ) {
    throw new FamilyContactError(
      "invalid_family_contact_state",
      "Invalid family contact state",
    );
  }
  assertTimestamp(contact.pairedAt, "contact pairing timestamp");
  if (
    !Number.isSafeInteger(contact.consentMessageId) ||
    contact.consentMessageId <= 0 ||
    !/^[a-f0-9]{64}$/.test(contact.pairingAcceptCallbackHash)
  ) {
    throw new FamilyContactError(
      "invalid_family_contact_state",
      "Invalid family contact state",
    );
  }
  assertCallback(contact.contactRevokeCallbackValue, "contact revoke callback");
  assertCallback(contact.ownerRevokeCallbackValue, "owner revoke callback");
  for (const value of [
    contact.contactConfirmationMessageId,
    contact.ownerConfirmationMessageId,
  ]) {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value <= 0)
    ) {
      throw new FamilyContactError(
        "invalid_family_contact_state",
        "Invalid family contact state",
      );
    }
  }
  for (const value of [
    contact.contactConfirmationDeliveredAt,
    contact.ownerConfirmationDeliveredAt,
  ]) {
    if (value !== undefined) assertTimestamp(value, "confirmation timestamp");
  }
  if (
    (contact.contactConfirmationDeliveredAt !== undefined) !==
      (contact.contactConfirmationMessageId !== undefined) ||
    (contact.ownerConfirmationDeliveredAt !== undefined) !==
      (contact.ownerConfirmationMessageId !== undefined)
  ) {
    throw new FamilyContactError(
      "invalid_family_contact_state",
      "Invalid family contact state",
    );
  }
}

function validateAudit(
  audit: RevokedFamilyContactAudit,
  installation: FamilyContactInstallation,
): void {
  assertOpaque(audit.contactId, "revoked contact ID");
  if (audit.installationId !== installation.id || audit.status !== "revoked") {
    throw new FamilyContactError(
      "installation_mismatch",
      "Revoked family contact installation mismatch",
    );
  }
  assertTimestamp(audit.pairedAt, "revoked contact pairing timestamp");
  assertTimestamp(audit.revokedAt, "contact revocation timestamp");
  if (
    !["owner", "contact", "system"].includes(audit.revokedBy) ||
    Date.parse(audit.revokedAt) < Date.parse(audit.pairedAt)
  ) {
    throw new FamilyContactError(
      "invalid_family_contact_state",
      "Invalid family contact state",
    );
  }
  for (const value of [
    audit.contactTelegramUserHash,
    audit.contactPrivateChatHash,
    audit.contactRevokeCallbackHash,
    audit.ownerRevokeCallbackHash,
  ]) {
    if (!/^[a-f0-9]{64}$/.test(value)) {
      throw new FamilyContactError(
        "invalid_family_contact_state",
        "Invalid family contact state",
      );
    }
  }
}

export function validateFamilyContactState(input: {
  installation?: FamilyContactInstallation;
  familyPairing?: FamilyContactPairingChallenge;
  familyContact?: ActiveFamilyContact;
  familyContactAudit?: RevokedFamilyContactAudit;
}): void {
  if (!input.familyPairing && !input.familyContact && !input.familyContactAudit) return;
  assertInstallation(input.installation);
  if (input.familyPairing && input.familyContact) {
    throw new FamilyContactError(
      "invalid_family_contact_state",
      "An active family contact cannot have a pending challenge",
    );
  }
  if (input.familyPairing) validateChallenge(input.familyPairing, input.installation);
  if (input.familyContact) validateActiveContact(input.familyContact, input.installation);
  if (input.familyContactAudit) validateAudit(input.familyContactAudit, input.installation);
}

export function tokenMatchesFamilyChallenge(
  challenge: FamilyContactPairingChallenge,
  token: string,
): boolean {
  return matchesHash(token, challenge.tokenHash);
}

export function callbackMatchesHash(value: string, expectedHash: string): boolean {
  return matchesHash(value, expectedHash);
}

export function hashFamilyCallback(value: string): string {
  return hash(value);
}
