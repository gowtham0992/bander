import { createHash, randomUUID } from "node:crypto";
import type {
  AgentReceipt,
  ApprovalCard,
  Band,
  CalendarEvent,
  DraftDocument,
  DraftEffect,
  FamilyNotificationDocument,
  HumanReceipt,
  OneTimeBand,
  ObservedExecutionResult,
  Permit,
  Person,
  StandingBand,
  StandingBandCandidate,
  StandingBandCard,
  StandingBandPredicate,
  StandingExecutionRequest,
  StoredDraft,
} from "@bander/contracts";
import { hashCanonical, hashDraft } from "./canonical.js";
import {
  renderApprovalCard,
  createDirectFamilyDocument,
  createFamilyNotificationDocument,
  sanitizeFamilyNotificationTitle,
  renderHumanReceipt,
  renderStandingBandCard,
} from "./card.js";
import { KeyedLock } from "./lock.js";
import { AuthorityStore } from "./store.js";

export interface DraftFixture {
  id: string;
  claimedUserRequest: string;
  calendar?:
    | {
        kind: "reschedule";
        eventId: string;
        expectedEtag: string;
        newStartTime: string;
      }
      | {
        kind: "create";
        eventId: string;
        title: string;
        startTime: string;
        endTime: string;
        timeZone: string;
      }
    | {
        kind: "cancel";
        eventId: string;
        expectedEtag: string;
      };
  emailReply?: Extract<DraftEffect, { type: "email.reply" }>;
  message?: {
    recipientId: string;
    expectedRecipientRevision: number;
    body: string;
  };
  familyNotification?: {
    installationId: string;
    contactId: string;
    pairingRevision: string;
    displayLabel: string;
    document: FamilyNotificationDocument;
  };
}

export interface ExecutionAdapter {
  resolveEvent(id: string): Promise<CalendarEvent>;
  resolvePerson(id: string): Promise<Person>;
  executeDraft(input: {
    draftHash: string;
    permitNonce: string;
    document: DraftDocument;
  }): Promise<void | ObservedExecutionResult>;
  getExecution(input: {
    draftHash: string;
    permitNonce: string;
    document: DraftDocument;
  }): Promise<boolean | ObservedExecutionResult>;
}

export class ExecutionConflictError extends Error {
  constructor(readonly kind: "calendar" | "email" = "calendar") {
    super("A downstream resource changed");
  }
}

export class ExecutionAmbiguousError extends Error {
  constructor(readonly kind: "calendar" | "email" | "family" = "calendar") {
    super("The downstream result could not be confirmed");
  }
}

export class ExecutionAlreadyAbsentError extends Error {
  constructor() {
    super("The downstream resource was already absent before this execution");
  }
}

export class ExecutionRejectedError extends Error {
  constructor(readonly action: "create" | "cancel") {
    super(`The downstream service definitively rejected the ${action} operation`);
  }
}

export class ExecutionEmailRejectedError extends Error {
  constructor() {
    super("The email service definitively rejected the approved reply");
  }
}

export class AuthorityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

interface AuthorityEngineOptions {
  store: AuthorityStore;
  adapter: ExecutionAdapter;
  now?: () => Date;
  id?: () => string;
  proposalLimit?: number;
  proposalWindowMinutes?: number;
}

export type StandingRunResult =
  | { status: "executed"; receipt: HumanReceipt }
  | { status: "review_required"; card: ApprovalCard };

export interface StandingBandSummary {
  bandId: string;
  status: "active" | "revoked" | "expired";
  actionsUsed: number;
  maxActions: number;
  rollingHours: number;
}

export function digestStandingRequest(fixture: DraftFixture): string {
  if (!fixture.calendar) {
    throw new AuthorityError(
      "standing_communication_unsupported",
      "Email and family messages require one-time review",
      422,
    );
  }
  if (fixture.calendar.kind === "create") {
    throw new AuthorityError(
      "standing_create_unsupported",
      "Calendar creation requires one-time review",
      422,
    );
  }
  if (fixture.calendar.kind === "cancel") {
    throw new AuthorityError(
      "standing_cancel_unsupported",
      "Calendar cancellation requires one-time review",
      422,
    );
  }
  return hashCanonical({
    version: 1,
    request: {
      claimedUserRequest: fixture.claimedUserRequest,
      calendar: {
        eventId: fixture.calendar.eventId,
        expectedEtag: fixture.calendar.expectedEtag,
        newStartTime: fixture.calendar.newStartTime,
      },
      ...(fixture.message
        ? {
            message: {
              recipientId: fixture.message.recipientId,
              expectedRecipientRevision: fixture.message.expectedRecipientRevision,
              body: fixture.message.body,
            },
          }
        : {}),
    },
  });
}

function sameIds(actual: string[], expected: string[]): boolean {
  return (
    actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index])
  );
}

function localTimeParts(value: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(new Date(value));
  const find = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    weekday: find("weekday"),
    time: `${find("hour")}:${find("minute")}`,
    date: `${find("year")}-${find("month")}-${find("day")}`,
  };
}

function deriveRescheduledEnd(
  originalStart: string,
  originalEnd: string,
  newStart: string,
): string {
  const originalStartMs = new Date(originalStart).getTime();
  const originalEndMs = new Date(originalEnd).getTime();
  const newStartMs = new Date(newStart).getTime();
  if (
    !Number.isFinite(originalStartMs) ||
    !Number.isFinite(originalEndMs) ||
    !Number.isFinite(newStartMs) ||
    originalEndMs <= originalStartMs
  ) {
    throw new AuthorityError(
      "invalid_calendar_interval",
      "The Calendar event does not have a valid interval",
      422,
    );
  }
  const newEndMs = newStartMs + (originalEndMs - originalStartMs);
  if (!Number.isFinite(newEndMs) || newEndMs <= newStartMs) {
    throw new AuthorityError(
      "invalid_calendar_interval",
      "The proposed Calendar interval is invalid",
      422,
    );
  }
  return new Date(newEndMs).toISOString();
}

function standingBandAllows(
  band: StandingBand,
  draft: StoredDraft,
  now: Date,
): boolean {
  if (
    band.predicateHash !==
    hashCanonical({ predicate: band.predicate, expiresAt: band.expiresAt })
  ) {
    return false;
  }
  if (draft.document.effects.length !== 1) return false;
  const effect = draft.document.effects[0];
  if (!effect || effect.type !== band.predicate.actionType) return false;
  if (
    effect.expected.organizerId !== band.predicate.ownerId ||
    !sameIds(effect.expected.attendeeIds, band.predicate.resource.attendeeIdsExactly)
  ) {
    return false;
  }
  if (!band.predicate.duration.mustRemainUnchanged) {
    return false;
  }

  const localStart = localTimeParts(
    effect.changes.startTime,
    band.predicate.time.timeZone,
  );
  const localEnd = localTimeParts(
    effect.changes.endTime,
    band.predicate.time.timeZone,
  );
  const originalDuration =
    new Date(effect.expected.endTime).getTime() -
    new Date(effect.expected.startTime).getTime();
  const resultingDuration =
    new Date(effect.changes.endTime).getTime() -
    new Date(effect.changes.startTime).getTime();
  if (
    !band.predicate.time.weekDays.includes(
      localStart.weekday as (typeof band.predicate.time.weekDays)[number],
    ) ||
    localStart.date !== localEnd.date ||
    localStart.time < band.predicate.time.startLocal ||
    localEnd.time > band.predicate.time.endLocal ||
    originalDuration <= 0 ||
    resultingDuration !== originalDuration
  ) {
    return false;
  }

  const cutoff = now.getTime() - band.predicate.limits.rollingHours * 60 * 60_000;
  const recentActions = band.actionTimestamps.filter(
    (timestamp) => new Date(timestamp).getTime() > cutoff,
  );
  return recentActions.length < band.predicate.limits.maxActions;
}

export class AuthorityEngine {
  readonly #store: AuthorityStore;
  readonly #adapter: ExecutionAdapter;
  readonly #now: () => Date;
  readonly #id: () => string;
  readonly #lock = new KeyedLock();
  readonly #proposalHistory = new Map<string, number[]>();
  readonly #proposalLimit: number;
  readonly #proposalWindowMinutes: number;

  constructor(options: AuthorityEngineOptions) {
    this.#store = options.store;
    this.#adapter = options.adapter;
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomUUID;
    this.#proposalLimit = options.proposalLimit ?? 5;
    this.#proposalWindowMinutes = options.proposalWindowMinutes ?? 10;
  }

  async proposeFixture(
    fixture: DraftFixture,
    agentId = "demo-agent",
  ): Promise<ApprovalCard> {
    const activity = this.#recordProposal(agentId);
    const draft = await this.#storeFixtureDraft(fixture);
    return {
      ...renderApprovalCard(draft.id, draft.hash, draft.document),
      proposalActivity: activity,
    };
  }

  async proposeFixtureForFreshReview(
    fixture: DraftFixture,
    agentId = "demo-agent",
  ): Promise<ApprovalCard> {
    // The requested effect stays fixture-defined; only the human-visible expected
    // state is rebound to the authoritative world for a new one-time review.
    const activity = this.#recordProposal(agentId);
    const draft = await this.#storeFixtureDraft(fixture, true);
    return {
      ...renderApprovalCard(draft.id, draft.hash, draft.document),
      proposalActivity: activity,
    };
  }

  createStandingBandCandidate(): StandingBandCard {
    const createdAt = this.#now();
    const expiresAt = new Date(createdAt.getTime() + 30 * 24 * 60 * 60_000).toISOString();
    const predicate: StandingBandPredicate = {
      version: 1,
      actionType: "calendar.reschedule_event",
      ownerId: "person-owner",
      resource: {
        organizerMustBeOwner: true,
        attendeeIdsExactly: ["person-owner"],
      },
      duration: { mustRemainUnchanged: true },
      time: {
        weekDays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
        startLocal: "09:00",
        endLocal: "17:00",
        timeZone: "America/Denver",
      },
      limits: {
        maxActions: 3,
        rollingHours: 24,
        maxNewRecipients: 0,
        maxSpendCents: 0,
      },
    };
    const predicateHash = hashCanonical({ predicate, expiresAt });
    const candidate: StandingBandCandidate = {
      id: `standing_candidate_${this.#id()}`,
      predicateHash,
      predicate,
      createdAt: createdAt.toISOString(),
      expiresAt,
      status: "proposed",
    };
    this.#store.saveStandingCandidate(candidate);
    return renderStandingBandCard(candidate);
  }

  async approveStandingBand(
    candidateId: string,
    predicateHash: string,
  ): Promise<{ bandId: string; expiresAt: string }> {
    return this.#lock.run(candidateId, async () => {
      const candidate = this.#store.getStandingCandidate(candidateId);
      if (!candidate) {
        throw new AuthorityError(
          "standing_candidate_not_found",
          "Standing Band proposal not found",
          404,
        );
      }
      if (
        candidate.predicateHash !== predicateHash ||
        hashCanonical({
          predicate: candidate.predicate,
          expiresAt: candidate.expiresAt,
        }) !== predicateHash
      ) {
        throw new AuthorityError(
          "standing_predicate_hash_mismatch",
          "The standing rule does not match what was reviewed",
          409,
        );
      }
      if (candidate.status === "approved" && candidate.approvedBandId) {
        const existing = this.#store.getBand(candidate.approvedBandId);
        if (
          !existing ||
          existing.mode !== "standing" ||
          existing.predicateHash !== predicateHash ||
          existing.expiresAt !== candidate.expiresAt ||
          hashCanonical({
            predicate: existing.predicate,
            expiresAt: existing.expiresAt,
          }) !== predicateHash
        ) {
          throw new AuthorityError(
            "standing_candidate_state_mismatch",
            "The approved standing rule is inconsistent",
            409,
          );
        }
        return { bandId: existing.id, expiresAt: existing.expiresAt };
      }
      if (candidate.status !== "proposed") {
        throw new AuthorityError(
          "standing_candidate_not_approvable",
          "This standing rule has already been used",
          409,
        );
      }
      if (new Date(candidate.expiresAt).getTime() <= this.#now().getTime()) {
        throw new AuthorityError(
          "standing_candidate_expired",
          "This standing rule proposal expired",
          409,
        );
      }
      const band: StandingBand = {
        id: `band_${this.#id()}`,
        mode: "standing",
        predicateHash: candidate.predicateHash,
        predicate: candidate.predicate,
        approvedAt: this.#now().toISOString(),
        expiresAt: candidate.expiresAt,
        status: "active",
        actionTimestamps: [],
      };
      this.#store.saveBand(band);
      this.#store.updateStandingCandidate({
        ...candidate,
        status: "approved",
        approvedBandId: band.id,
      });
      return { bandId: band.id, expiresAt: band.expiresAt };
    });
  }

  async declineStandingBandCandidate(
    candidateId: string,
    predicateHash: string,
  ): Promise<{ status: "declined" }> {
    return this.#lock.run(candidateId, async () => {
      const candidate = this.#store.getStandingCandidate(candidateId);
      if (!candidate) {
        throw new AuthorityError(
          "standing_candidate_not_found",
          "Standing rule proposal not found",
          404,
        );
      }
      if (
        candidate.predicateHash !== predicateHash ||
        hashCanonical({
          predicate: candidate.predicate,
          expiresAt: candidate.expiresAt,
        }) !== predicateHash
      ) {
        throw new AuthorityError(
          "standing_predicate_hash_mismatch",
          "The standing rule does not match what was reviewed",
          409,
        );
      }
      if (candidate.status === "declined") return { status: "declined" };
      if (candidate.status !== "proposed") {
        throw new AuthorityError(
          "standing_candidate_not_declineable",
          "This standing rule has already been used",
          409,
        );
      }
      this.#store.updateStandingCandidate({ ...candidate, status: "declined" });
      return { status: "declined" };
    });
  }

  async runStandingBand(
    bandId: string,
    fixture: DraftFixture,
    requestId: string,
    agentId = "demo-agent",
  ): Promise<StandingRunResult> {
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(requestId)) {
      throw new AuthorityError(
        "invalid_standing_request_id",
        "A valid client request ID is required",
        400,
      );
    }
    const requestDigest = digestStandingRequest(fixture);

    return this.#lock.run(bandId, async () => {
      const currentBand = this.#store.getBand(bandId);
      if (!currentBand || currentBand.mode !== "standing") {
        throw new AuthorityError("standing_band_not_found", "Standing Band not found", 404);
      }

      const existing = this.#store.getStandingRequest(bandId, requestId);
      if (existing) {
        if (existing.requestDigest !== requestDigest) {
          throw new AuthorityError(
            "standing_request_mismatch",
            "This request ID is already bound to different content",
            409,
          );
        }
        return this.#resumeStandingRequest(existing, currentBand, agentId);
      }

      if (
        currentBand.status !== "active" ||
        new Date(currentBand.expiresAt).getTime() <= this.#now().getTime()
      ) {
        throw new AuthorityError(
          "standing_band_inactive",
          "This standing Band is not active",
          409,
        );
      }

      const draft = await this.#storeFixtureDraft(fixture);
      const standingRequest: StandingExecutionRequest = {
        bandId: currentBand.id,
        requestId,
        requestDigest,
        draftId: draft.id,
        status: "drafted",
        createdAt: this.#now().toISOString(),
      };
      this.#store.saveStandingRequest(standingRequest);
      return this.#resumeStandingRequest(standingRequest, currentBand, agentId);
    });
  }

  getStandingBandSummary(bandId: string): StandingBandSummary {
    const band = this.#store.getBand(bandId);
    if (!band || band.mode !== "standing") {
      throw new AuthorityError("standing_band_not_found", "Standing Band not found", 404);
    }
    const now = this.#now();
    const cutoff =
      now.getTime() - band.predicate.limits.rollingHours * 60 * 60_000;
    const actionsUsed = band.actionTimestamps.filter(
      (timestamp) => new Date(timestamp).getTime() > cutoff,
    ).length;
    return {
      bandId: band.id,
      status:
        band.status === "revoked"
          ? "revoked"
          : new Date(band.expiresAt).getTime() <= now.getTime()
            ? "expired"
            : "active",
      actionsUsed,
      maxActions: band.predicate.limits.maxActions,
      rollingHours: band.predicate.limits.rollingHours,
    };
  }

  getStandingAgentReceipt(
    bandId: string,
    requestId: string,
  ): AgentReceipt | undefined {
    const request = this.#store.getStandingRequest(bandId, requestId);
    return request ? this.getAgentReceipt(request.draftId) : undefined;
  }

  async #resumeStandingRequest(
    request: StandingExecutionRequest,
    band: StandingBand,
    agentId: string,
  ): Promise<StandingRunResult> {
    const draft = this.#requireDraft(request.draftId);
    if (request.bandId !== band.id || draft.hash !== hashDraft(draft.document)) {
      throw new AuthorityError(
        "invalid_standing_request_state",
        "The stored standing request is inconsistent",
        409,
      );
    }

    if (request.status === "review_required") {
      if (draft.status !== "proposed" || !request.proposalActivity) {
        throw new AuthorityError(
          "standing_request_not_resumable",
          "This standing request cannot be resumed",
          409,
        );
      }
      return {
        status: "review_required",
        card: {
          ...renderApprovalCard(draft.id, draft.hash, draft.document),
          proposalActivity: request.proposalActivity,
        },
      };
    }

    if (request.status === "conflict") {
      throw new AuthorityError(
        "standing_request_not_resumable",
        "This standing request cannot be resumed",
        409,
      );
    }

    if (request.permitId) {
      const permit = this.#store.getPermit(request.permitId);
      if (
        !permit ||
        permit.bandId !== request.bandId ||
        permit.draftId !== request.draftId ||
        permit.draftHash !== draft.hash ||
        permit.executor !== "bander_executor"
      ) {
        throw new AuthorityError(
          "invalid_standing_request_state",
          "The stored standing request is inconsistent",
          409,
        );
      }
      try {
        const receipt = await this.#executeStoredDraft(request.permitId);
        this.#store.updateStandingRequest({
          ...request,
          status: "executed",
          receiptId: receipt.id,
        });
        return { status: "executed", receipt };
      } catch (error) {
        if (error instanceof AuthorityError && error.code === "conflict") {
          this.#store.updateStandingRequest({ ...request, status: "conflict" });
        }
        throw error;
      }
    }

    if (
      request.status !== "drafted" ||
      draft.status !== "proposed" ||
      new Date(draft.document.expiresAt).getTime() <= this.#now().getTime()
    ) {
      throw new AuthorityError(
        "standing_request_not_resumable",
        "This standing request cannot be resumed",
        409,
      );
    }
    if (
      band.status !== "active" ||
      new Date(band.expiresAt).getTime() <= this.#now().getTime()
    ) {
      throw new AuthorityError(
        "standing_band_inactive",
        "This standing Band is not active",
        409,
      );
    }

    if (!standingBandAllows(band, draft, this.#now())) {
      const activity = this.#recordProposal(agentId);
      this.#store.updateStandingRequest({
        ...request,
        status: "review_required",
        proposalActivity: activity,
      });
      return {
        status: "review_required",
        card: {
          ...renderApprovalCard(draft.id, draft.hash, draft.document),
          proposalActivity: activity,
        },
      };
    }

    this.#store.updateDraft({ ...draft, status: "approved" });
    const permit = this.#createPermit(band.id, draft);
    const executingRequest: StandingExecutionRequest = {
      ...request,
      status: "executing",
      permitId: permit.id,
    };
    this.#store.updateStandingRequest(executingRequest);
    try {
      const receipt = await this.#executeStoredDraft(permit.id);
      this.#store.updateStandingRequest({
        ...executingRequest,
        status: "executed",
        receiptId: receipt.id,
      });
      return { status: "executed", receipt };
    } catch (error) {
      if (error instanceof AuthorityError && error.code === "conflict") {
        this.#store.updateStandingRequest({
          ...executingRequest,
          status: "conflict",
        });
      }
      throw error;
    }
  }

  resetDemo(): void {
    this.#store.reset();
    this.#proposalHistory.clear();
  }

  getCard(draftId: string): ApprovalCard {
    const draft = this.#requireDraft(draftId);
    return renderApprovalCard(draft.id, draft.hash, draft.document);
  }

  getAgentReceipt(draftId: string): AgentReceipt {
    const draft = this.#requireDraft(draftId);
    return { draftId: draft.id, status: draft.status };
  }

  getHumanReceipt(receiptId: string): HumanReceipt {
    const receipt = this.#store.getReceipt(receiptId);
    if (!receipt) throw new AuthorityError("receipt_not_found", "Receipt not found", 404);
    return receipt;
  }

  async approveAndExecute(draftId: string, approvedHash: string): Promise<HumanReceipt> {
    const authorization = await this.#lock.run(draftId, async () => {
      const draft = this.#requireDraft(draftId);
      this.#verifyApprovedHash(draft, approvedHash);

      if (draft.status === "proposed") {
        if (new Date(draft.document.expiresAt).getTime() <= this.#now().getTime()) {
          this.#store.updateDraft({ ...draft, status: "expired" });
          throw new AuthorityError("draft_expired", "This deal has expired", 409);
        }
        return this.#createOneTimeAuthorization(draft);
      }

      if (draft.status !== "approved" && draft.status !== "executed") {
        throw new AuthorityError(
          "draft_not_resumable",
          "This Draft cannot resume execution",
          409,
        );
      }

      const bands = this.#store.getOneTimeBandsForDraft(draft.id);
      const permits = this.#store.getPermitsForDraft(draft.id);
      if (bands.length !== 1 || permits.length !== 1) {
        throw new AuthorityError(
          "invalid_authority_state",
          "The existing execution authority is inconsistent",
          409,
        );
      }
      const [band] = bands;
      const [permit] = permits;
      if (
        !band ||
        band.mode !== "one_time" ||
        !permit ||
        band.draftHash !== approvedHash ||
        permit.bandId !== band.id ||
        permit.draftHash !== approvedHash ||
        permit.executor !== "bander_executor" ||
        (draft.status === "approved" && band.status !== "active") ||
        (draft.status === "executed" &&
          (band.status !== "consumed" || !permit.consumedAt || !permit.receiptId))
      ) {
        throw new AuthorityError(
          "invalid_authority_state",
          "The existing execution authority is inconsistent",
          409,
        );
      }
      return { bandId: band.id, permitId: permit.id };
    });
    return this.executePermit(authorization.permitId);
  }

  async approve(
    draftId: string,
    approvedHash: string,
  ): Promise<{ bandId: string; permitId: string }> {
    return this.#lock.run(draftId, async () => {
      const draft = this.#requireDraft(draftId);
      if (draft.status !== "proposed") {
        throw new AuthorityError(
          "draft_not_approvable",
          "This Draft is no longer awaiting approval",
          409,
        );
      }
      this.#verifyApprovedHash(draft, approvedHash);
      if (new Date(draft.document.expiresAt).getTime() <= this.#now().getTime()) {
        this.#store.updateDraft({ ...draft, status: "expired" });
        throw new AuthorityError("draft_expired", "This deal has expired", 409);
      }

      return this.#createOneTimeAuthorization(draft);
    });
  }

  async executePermit(permitId: string): Promise<HumanReceipt> {
    const permit = this.#store.getPermit(permitId);
    if (!permit) {
      throw new AuthorityError("invalid_permit", "Execution authority is invalid", 403);
    }
    const band = this.#store.getBand(permit.bandId);
    if (!band) {
      throw new AuthorityError("invalid_band", "The approved Band is not active", 409);
    }
    return this.#lock.run(band.id, () => this.#executeStoredDraft(permitId));
  }

  async revokeBand(bandId: string): Promise<void> {
    const band = this.#store.getBand(bandId);
    if (!band) throw new AuthorityError("band_not_found", "Band not found", 404);
    await this.#lock.run(band.id, async () => {
      const currentBand = this.#store.getBand(bandId);
      if (!currentBand || currentBand.status !== "active") return;
      this.#store.updateBand({ ...currentBand, status: "revoked" });
      if (currentBand.mode === "one_time") {
        const draft = this.#requireDraft(currentBand.draftId);
        if (draft.status === "approved") {
          this.#store.updateDraft({ ...draft, status: "revoked" });
        }
      }
    });
  }

  decline(draftId: string): AgentReceipt {
    const draft = this.#requireDraft(draftId);
    if (draft.status === "declined") {
      return { draftId, status: "declined" };
    }
    if (draft.status !== "proposed") {
      throw new AuthorityError("draft_not_declinable", "This Draft is no longer pending", 409);
    }
    const declined: StoredDraft = { ...draft, status: "declined" };
    this.#store.updateDraft(declined);
    return { draftId, status: "declined" };
  }

  async #storeFixtureDraft(
    fixture: DraftFixture,
    bindToCurrentState = false,
  ): Promise<StoredDraft> {
    const directFamily = fixture.familyNotification?.document.kind === "direct_message";
    const primaryCount = [fixture.calendar, fixture.emailReply, directFamily ? fixture.familyNotification : undefined].filter(Boolean).length;
    if (primaryCount !== 1 || (fixture.emailReply && (fixture.message || fixture.familyNotification))) {
      throw new AuthorityError(
        "invalid_deal_shape",
        "Bander requires one bounded primary action",
        422,
      );
    }
    const creating = fixture.calendar?.kind === "create";
    const cancelling = fixture.calendar?.kind === "cancel";
    const createFixture = creating
      ? (fixture.calendar as Extract<NonNullable<DraftFixture["calendar"]>, { kind: "create" }>)
      : undefined;
    const cancelFixture = cancelling
      ? (fixture.calendar as Extract<NonNullable<DraftFixture["calendar"]>, { kind: "cancel" }>)
      : undefined;
    const rescheduleFixture = fixture.calendar && !creating && !cancelling
      ? (fixture.calendar as Extract<NonNullable<DraftFixture["calendar"]>, { kind: "reschedule" }>)
      : undefined;
    if (creating) {
      const duration = Date.parse(createFixture!.endTime) - Date.parse(createFixture!.startTime);
      const sanitizedTitle = sanitizeFamilyNotificationTitle(createFixture!.title);
      if (
        !/^[0-9a-v]{5,1024}$/.test(createFixture!.eventId) ||
        sanitizedTitle !== createFixture!.title ||
        duration < 15 * 60_000 ||
        duration > 12 * 60 * 60_000
      ) {
        throw new AuthorityError(
          "invalid_calendar_create",
          "The Calendar creation request is outside Bander’s supported shape",
          422,
        );
      }
    }
    const event = !fixture.calendar || creating
      ? undefined
      : await this.#adapter.resolveEvent(
          cancelling ? cancelFixture!.eventId : rescheduleFixture!.eventId,
        );
    const person = fixture.message
      ? await this.#adapter.resolvePerson(fixture.message.recipientId)
      : undefined;

    if (
      fixture.calendar && !creating &&
      !bindToCurrentState &&
      event!.etag !== (cancelling ? cancelFixture!.expectedEtag : rescheduleFixture!.expectedEtag)
    ) {
      throw new AuthorityError(
        "fixture_precondition_mismatch",
        "The seeded calendar no longer matches this proposal",
        409,
      );
    }
    if (
      !bindToCurrentState &&
      fixture.message &&
      (!person || person.revision !== fixture.message.expectedRecipientRevision)
    ) {
      throw new AuthorityError(
        "fixture_precondition_mismatch",
        "The seeded recipient no longer matches this proposal",
        409,
      );
    }
    if (fixture.emailReply) {
      const reply = fixture.emailReply;
      const mimeBytes = Buffer.from(reply.rawMimeBase64Url, "base64url");
      if (
        reply.type !== "email.reply" ||
        !/^[a-f0-9]{64}$/.test(reply.mimeDigest) ||
        createHash("sha256").update(mimeBytes).digest("hex") !== reply.mimeDigest ||
        !/^<[^\r\n<>\s]+@[^\r\n<>\s]+>$/.test(reply.rfcMessageId) ||
        !/^[a-f0-9]{64}$/.test(reply.reconciliationToken) ||
        /[\r\n]/.test(reply.recipient) ||
        /[\r\n]/.test(reply.subject) ||
        !reply.body.trim()
      ) {
        throw new AuthorityError(
          "invalid_email_reply",
          "The email reply is outside Bander’s supported shape",
          422,
        );
      }
    }

    const effects: DraftEffect[] = fixture.emailReply
      ? [structuredClone(fixture.emailReply)]
      : !fixture.calendar
        ? []
        : creating
        ? [
          {
            type: "calendar.create_event",
            calendarId: "primary",
            eventId: createFixture!.eventId,
            title: createFixture!.title,
            startTime: createFixture!.startTime,
            endTime: createFixture!.endTime,
            timeZone: createFixture!.timeZone,
            eventType: "default",
          },
        ]
        : cancelling
        ? [
            {
              type: "calendar.cancel_event",
              calendarId: "primary",
              eventId: event!.id,
              expected: {
                etag: event!.etag,
                title: event!.title,
                startTime: event!.startTime,
                endTime: event!.endTime,
                timeZone: event!.timeZone,
                eventType: "default",
                organizerMustBeOwner: true,
                attendeeIdsExactly: [],
                recurring: false,
              },
            },
          ]
        : [
      {
        type: "calendar.reschedule_event",
        eventId: event!.id,
        expected: {
          etag: event!.etag,
          title: event!.title,
          startTime: event!.startTime,
          endTime: event!.endTime,
          timeZone: event!.timeZone,
          organizerId: event!.organizerId,
          attendeeIds: event!.attendeeIds,
        },
        changes: {
          startTime: rescheduleFixture!.newStartTime,
          endTime: deriveRescheduledEnd(
            event!.startTime,
            event!.endTime,
            rescheduleFixture!.newStartTime,
          ),
        },
      },
    ];
    if (fixture.message && person) {
      effects.push({
        type: "messages.send",
        recipientId: person.id,
        expected: { revision: person.revision, displayName: person.displayName },
        body: fixture.message.body,
      });
    }
    if (fixture.familyNotification) {
      const binding = fixture.familyNotification;
      if (
        !/^[A-Za-z0-9_-]{8,100}$/.test(binding.installationId) ||
        !/^[A-Za-z0-9_-]{8,100}$/.test(binding.contactId) ||
        !/^[a-f0-9]{64}$/.test(binding.pairingRevision) ||
        !binding.displayLabel.trim()
      ) {
        throw new AuthorityError(
          "invalid_family_contact_binding",
          "The family contact binding is invalid",
          422,
        );
      }
      const canonicalDocument = directFamily
        ? createDirectFamilyDocument((fixture.familyNotification.document as Extract<FamilyNotificationDocument, { kind: "direct_message" }>).body)
        : creating
        ? createFamilyNotificationDocument({
            kind: "calendar_creation",
            eventTitle: createFixture!.title,
            startTime: createFixture!.startTime,
            endTime: createFixture!.endTime,
            timeZone: createFixture!.timeZone,
          })
        : cancelling
          ? createFamilyNotificationDocument({
              kind: "calendar_cancellation",
              eventTitle: event!.title,
              startTime: event!.startTime,
              endTime: event!.endTime,
              timeZone: event!.timeZone,
            })
          : createFamilyNotificationDocument({
            kind: "calendar_transition",
            eventTitle: event!.title,
            newStartTime: rescheduleFixture!.newStartTime,
            newEndTime: deriveRescheduledEnd(
              event!.startTime,
              event!.endTime,
              rescheduleFixture!.newStartTime,
            ),
            timeZone: event!.timeZone,
          });
      if (
        hashCanonical(canonicalDocument) !==
        hashCanonical(fixture.familyNotification.document)
      ) {
        throw new AuthorityError(
          "family_notification_mismatch",
          "The family notification does not match the Calendar transition",
          422,
        );
      }
      effects.push({
        type: "family.telegram_notification",
        binding: {
          installationId: fixture.familyNotification.installationId,
          contactId: fixture.familyNotification.contactId,
          pairingRevision: fixture.familyNotification.pairingRevision,
          displayLabel: fixture.familyNotification.displayLabel,
        },
        document: canonicalDocument,
      });
    }

    const createdAt = this.#now();
    const document: DraftDocument = {
      version: 1,
      source: {
        provenance: "agent_claimed",
        claimedUserRequest: fixture.claimedUserRequest,
      },
      effects,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 10 * 60_000).toISOString(),
    };
    const hash = hashDraft(document);
    const draft: StoredDraft = {
      id: `draft_${this.#id()}`,
      hash,
      document,
      status: "proposed",
    };
    this.#store.saveDraft(draft);
    return draft;
  }

  #createPermit(bandId: string, draft: StoredDraft): Permit {
    const permit: Permit = {
      id: `permit_${this.#id()}`,
      nonce: this.#id(),
      bandId,
      draftId: draft.id,
      draftHash: draft.hash,
      executor: "bander_executor",
      expiresAt: new Date(this.#now().getTime() + 30_000).toISOString(),
    };
    this.#store.savePermit(permit);
    return permit;
  }

  #createOneTimeAuthorization(
    draft: StoredDraft,
  ): { bandId: string; permitId: string } {
    const band: OneTimeBand = {
      id: `band_${this.#id()}`,
      mode: "one_time",
      draftId: draft.id,
      draftHash: draft.hash,
      approvedAt: this.#now().toISOString(),
      expiresAt: draft.document.expiresAt,
      status: "active",
    };
    this.#store.saveBand(band);
    this.#store.updateDraft({ ...draft, status: "approved" });
    const permit = this.#createPermit(band.id, draft);
    return { bandId: band.id, permitId: permit.id };
  }

  #verifyApprovedHash(draft: StoredDraft, approvedHash: string): void {
    if (draft.hash !== approvedHash || hashDraft(draft.document) !== approvedHash) {
      throw new AuthorityError(
        "draft_hash_mismatch",
        "The approved deal does not match the stored Draft",
        409,
      );
    }
  }

  async #executeStoredDraft(permitId: string): Promise<HumanReceipt> {
    let permit = this.#store.getPermit(permitId);
    if (!permit || permit.executor !== "bander_executor") {
      throw new AuthorityError("invalid_permit", "Execution authority is invalid", 403);
    }
    if (permit.consumedAt) {
      if (permit.receiptId) return this.getHumanReceipt(permit.receiptId);
      throw new AuthorityError("permit_consumed", "Execution authority was already used", 409);
    }

    const band = this.#store.getBand(permit.bandId);
    if (!band) {
      throw new AuthorityError("invalid_band", "The approved Band is not active", 409);
    }
    const draft = this.#requireDraft(permit.draftId);
    if (draft.hash !== permit.draftHash || hashDraft(draft.document) !== permit.draftHash) {
      throw new AuthorityError("draft_hash_mismatch", "Stored Draft integrity check failed", 409);
    }
    if (
      band.mode === "one_time" &&
      (band.draftHash !== permit.draftHash || band.draftId !== draft.id)
    ) {
      throw new AuthorityError("invalid_band", "The approved Band is not active", 409);
    }

    if (permit.dispatchedAt) {
      const committed = await this.#adapter.getExecution({
        draftHash: permit.draftHash,
        permitNonce: permit.nonce,
        document: draft.document,
      });
      if (committed) {
        return this.#completeExecution(
          permit,
          band,
          draft,
          typeof committed === "boolean" ? undefined : committed,
        );
      }
    }
    if (new Date(permit.expiresAt).getTime() <= this.#now().getTime()) {
      throw new AuthorityError("permit_expired", "Execution authority expired", 409);
    }

    if (band.status !== "active") {
      throw new AuthorityError("invalid_band", "The approved Band is not active", 409);
    }
    if (new Date(band.expiresAt).getTime() <= this.#now().getTime()) {
      if (band.mode === "one_time") {
        this.#store.updateBand({ ...band, status: "consumed" });
      }
      this.#store.updateDraft({ ...draft, status: "expired" });
      throw new AuthorityError("band_expired", "The approved Band expired", 409);
    }
    if (band.mode === "standing" && !standingBandAllows(band, draft, this.#now())) {
      this.#store.updateDraft({ ...draft, status: "blocked" });
      throw new AuthorityError(
        "standing_band_mismatch",
        "This needs you: it would change the deal you approved.",
        409,
      );
    }

    try {
      if (!permit.dispatchedAt) {
        permit = { ...permit, dispatchedAt: this.#now().toISOString() };
        this.#store.updatePermit(permit);
      }
      const observed = await this.#adapter.executeDraft({
        draftHash: draft.hash,
        permitNonce: permit.nonce,
        document: draft.document,
      });
      return this.#completeExecution(permit, band, draft, observed ?? undefined);
    } catch (error) {
      if (error instanceof ExecutionConflictError) {
        const completedAt = this.#now().toISOString();
        this.#store.updatePermit({ ...permit, consumedAt: completedAt });
        if (band.mode === "one_time") {
          this.#store.updateBand({ ...band, status: "consumed" });
        }
        this.#store.updateDraft({ ...draft, status: "conflict" });
        throw new AuthorityError(
          error.kind === "email" ? "email_thread_changed" : "conflict",
          error.kind === "email"
            ? "The email thread changed after approval. No reply was sent."
            : "Your calendar changed after you approved this. I didn’t act.",
          409,
        );
      }
      if (error instanceof ExecutionAlreadyAbsentError) {
        const completedAt = this.#now().toISOString();
        this.#store.updatePermit({ ...permit, consumedAt: completedAt });
        if (band.mode === "one_time") {
          this.#store.updateBand({ ...band, status: "consumed" });
        }
        this.#store.updateDraft({ ...draft, status: "conflict" });
        throw new AuthorityError(
          "calendar_event_already_absent",
          "The approved Calendar event was already absent before execution",
          409,
        );
      }
      if (error instanceof ExecutionRejectedError) {
        const completedAt = this.#now().toISOString();
        this.#store.updatePermit({ ...permit, consumedAt: completedAt });
        if (band.mode === "one_time") {
          this.#store.updateBand({ ...band, status: "consumed" });
        }
        this.#store.updateDraft({ ...draft, status: "conflict" });
        throw new AuthorityError(
          error.action === "create"
            ? "calendar_create_rejected"
            : "calendar_cancel_rejected",
          `The Calendar service rejected the approved ${error.action} operation`,
          409,
        );
      }
      if (error instanceof ExecutionEmailRejectedError) {
        const completedAt = this.#now().toISOString();
        this.#store.updatePermit({ ...permit, consumedAt: completedAt });
        if (band.mode === "one_time") {
          this.#store.updateBand({ ...band, status: "consumed" });
        }
        this.#store.updateDraft({ ...draft, status: "conflict" });
        throw new AuthorityError(
          "email_send_rejected",
          "The email service rejected the exact approved reply",
          409,
        );
      }
      if (error instanceof ExecutionAmbiguousError) {
        const completedAt = this.#now().toISOString();
        this.#store.updatePermit({ ...permit, consumedAt: completedAt });
        if (band.mode === "one_time") {
          this.#store.updateBand({ ...band, status: "consumed" });
        }
        this.#store.updateDraft({ ...draft, status: "conflict" });
        throw new AuthorityError(
          `${error.kind}_outcome_ambiguous`,
          error.kind === "email"
            ? "Bander could not confirm whether the approved email reply was sent."
            : error.kind === "family"
              ? "Bander could not confirm whether the approved family message was sent."
              : "Bander could not confirm the Calendar result and did not notify anyone.",
          409,
        );
      }
      throw error;
    }

  }

  #completeExecution(
    permit: Permit,
    band: Band,
    draft: StoredDraft,
    observed?: ObservedExecutionResult,
  ): HumanReceipt {
    const calendar = draft.document.effects.find(
      (effect) => effect.type === "calendar.reschedule_event",
    );
    const createdCalendar = draft.document.effects.find(
      (effect) => effect.type === "calendar.create_event",
    );
    const cancelledCalendar = draft.document.effects.find(
      (effect) => effect.type === "calendar.cancel_event",
    );
    const family = draft.document.effects.find(
      (effect) => effect.type === "family.telegram_notification",
    );
    const emailReply = draft.document.effects.find(
      (effect) => effect.type === "email.reply",
    );
    const directFamily = family?.document.kind === "direct_message";
    const actionCount = [calendar, createdCalendar, cancelledCalendar, emailReply, directFamily ? family : undefined].filter(Boolean).length;
    const expectedStart = calendar
      ? calendar.changes.startTime
      : createdCalendar
        ? createdCalendar.startTime
        : cancelledCalendar?.expected.startTime;
    const expectedEnd = calendar
      ? calendar.changes.endTime
      : createdCalendar
        ? createdCalendar.endTime
        : cancelledCalendar?.expected.endTime;
    const expectedTimeZone = calendar
      ? calendar.expected.timeZone
      : createdCalendar
        ? createdCalendar.timeZone
        : cancelledCalendar?.expected.timeZone;
    if (
      actionCount !== 1 ||
      ((createdCalendar || cancelledCalendar || emailReply || directFamily) && !observed) ||
      (observed?.calendar &&
        (Date.parse(observed.calendar.completed.startTime) !==
          Date.parse(expectedStart!) ||
          Date.parse(observed.calendar.completed.endTime) !==
            Date.parse(expectedEnd!) ||
          observed.calendar.completed.timeZone !== expectedTimeZone ||
          (createdCalendar && observed.calendar.action !== "created") ||
          (cancelledCalendar && observed.calendar.action !== "removed"))) ||
      ((calendar || createdCalendar || cancelledCalendar) && !observed?.calendar && Boolean(observed)) ||
      (emailReply && !observed?.emailReply) ||
      (!emailReply && observed?.emailReply) ||
      (family && !observed?.familyNotification) ||
      (!family && observed?.familyNotification)
    ) {
      throw new AuthorityError(
        "invalid_execution_observation",
        "The observed execution does not match the approved deal",
        409,
      );
    }
    const completedAt = this.#now().toISOString();
    const receipt = renderHumanReceipt(
      `receipt_${this.#id()}`,
      draft.id,
      draft.document,
      completedAt,
      observed,
    );
    this.#store.saveReceipt(receipt);
    this.#store.updatePermit({
      ...permit,
      consumedAt: completedAt,
      receiptId: receipt.id,
    });
    if (band.mode === "one_time") {
      this.#store.updateBand({ ...band, status: "consumed" });
    } else {
      this.#store.updateBand({
        ...band,
        actionTimestamps: [...band.actionTimestamps, completedAt],
      });
    }
    this.#store.updateDraft({ ...draft, status: "executed" });
    return receipt;
  }

  #recordProposal(agentId: string) {
    const now = this.#now().getTime();
    const cutoff = now - this.#proposalWindowMinutes * 60_000;
    const recent = (this.#proposalHistory.get(agentId) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    if (recent.length >= this.#proposalLimit) {
      throw new AuthorityError(
        "proposal_flood",
        `Your agent has already asked ${recent.length} times in ${this.#proposalWindowMinutes} minutes. Proposals are paused.`,
        429,
      );
    }
    recent.push(now);
    this.#proposalHistory.set(agentId, recent);
    return {
      count: recent.length,
      limit: this.#proposalLimit,
      windowMinutes: this.#proposalWindowMinutes,
    };
  }

  #requireDraft(draftId: string): StoredDraft {
    const draft = this.#store.getDraft(draftId);
    if (!draft) throw new AuthorityError("draft_not_found", "Draft not found", 404);
    return draft;
  }
}
