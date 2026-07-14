import type {
  Band,
  HumanReceipt,
  Permit,
  StandingBandCandidate,
  StoredDraft,
} from "@bander/contracts";

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class AuthorityStore {
  readonly #drafts = new Map<string, StoredDraft>();
  readonly #bands = new Map<string, Band>();
  readonly #permits = new Map<string, Permit>();
  readonly #receipts = new Map<string, HumanReceipt>();
  readonly #standingCandidates = new Map<string, StandingBandCandidate>();

  saveDraft(draft: StoredDraft): void {
    if (this.#drafts.has(draft.id)) throw new Error("Draft already exists");
    this.#drafts.set(draft.id, copy(draft));
  }

  getDraft(id: string): StoredDraft | undefined {
    const value = this.#drafts.get(id);
    return value ? copy(value) : undefined;
  }

  updateDraft(draft: StoredDraft): void {
    if (!this.#drafts.has(draft.id)) throw new Error("Draft does not exist");
    this.#drafts.set(draft.id, copy(draft));
  }

  saveBand(band: Band): void {
    this.#bands.set(band.id, copy(band));
  }

  getBand(id: string): Band | undefined {
    const value = this.#bands.get(id);
    return value ? copy(value) : undefined;
  }

  updateBand(band: Band): void {
    if (!this.#bands.has(band.id)) throw new Error("Band does not exist");
    this.#bands.set(band.id, copy(band));
  }

  savePermit(permit: Permit): void {
    this.#permits.set(permit.id, copy(permit));
  }

  getPermit(id: string): Permit | undefined {
    const value = this.#permits.get(id);
    return value ? copy(value) : undefined;
  }

  updatePermit(permit: Permit): void {
    if (!this.#permits.has(permit.id)) throw new Error("Permit does not exist");
    this.#permits.set(permit.id, copy(permit));
  }

  saveReceipt(receipt: HumanReceipt): void {
    if (this.#receipts.has(receipt.id)) throw new Error("Receipt already exists");
    this.#receipts.set(receipt.id, copy(receipt));
  }

  getReceipt(id: string): HumanReceipt | undefined {
    const value = this.#receipts.get(id);
    return value ? copy(value) : undefined;
  }

  saveStandingCandidate(candidate: StandingBandCandidate): void {
    if (this.#standingCandidates.has(candidate.id)) {
      throw new Error("Standing Band candidate already exists");
    }
    this.#standingCandidates.set(candidate.id, copy(candidate));
  }

  getStandingCandidate(id: string): StandingBandCandidate | undefined {
    const value = this.#standingCandidates.get(id);
    return value ? copy(value) : undefined;
  }

  updateStandingCandidate(candidate: StandingBandCandidate): void {
    if (!this.#standingCandidates.has(candidate.id)) {
      throw new Error("Standing Band candidate does not exist");
    }
    this.#standingCandidates.set(candidate.id, copy(candidate));
  }

  reset(): void {
    this.#drafts.clear();
    this.#bands.clear();
    this.#permits.clear();
    this.#receipts.clear();
    this.#standingCandidates.clear();
  }
}
