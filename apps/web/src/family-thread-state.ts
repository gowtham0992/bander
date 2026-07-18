export const R2_PRESENTATION_BEAT_MS = 400;

export type FamilyThreadStage =
  | "idle"
  | "asking"
  | "read"
  | "email_preparing"
  | "email_waiting"
  | "email_confirmed"
  | "email_declined"
  | "compound_preparing"
  | "compound_waiting"
  | "compound_calendar_crossed"
  | "compound_confirmed"
  | "compound_declined"
  | "conflict_offered"
  | "conflict_preparing"
  | "conflict_waiting"
  | "conflict_returned"
  | "uncertainty_offered"
  | "uncertainty_preparing"
  | "uncertainty_waiting"
  | "uncertainty_held";

export interface FamilyThreadState {
  stage: FamilyThreadStage;
}

export type FamilyThreadEvent =
  | { type: "ask" }
  | { type: "read_completed" }
  | { type: "ask_failed" }
  | { type: "prepare_email" }
  | { type: "email_card_ready" }
  | { type: "email_prepare_failed" }
  | { type: "email_approved" }
  | { type: "email_declined" }
  | { type: "prepare_compound" }
  | { type: "compound_card_ready" }
  | { type: "compound_prepare_failed" }
  | { type: "compound_backend_confirmed" }
  | { type: "compound_phone_presented" }
  | { type: "compound_declined" }
  | { type: "offer_conflict" }
  | { type: "prepare_conflict" }
  | { type: "conflict_card_ready" }
  | { type: "conflict_prepare_failed" }
  | { type: "conflict_returned" }
  | { type: "conflict_declined" }
  | { type: "offer_uncertainty" }
  | { type: "prepare_uncertainty" }
  | { type: "uncertainty_card_ready" }
  | { type: "uncertainty_prepare_failed" }
  | { type: "uncertainty_held" }
  | { type: "uncertainty_declined" }
  | { type: "reset" }
  | { type: "time_elapsed"; milliseconds: number };

export const initialFamilyThreadState: FamilyThreadState = { stage: "idle" };

export interface FamilyThreadWorldPresentation {
  calendar: "quiet" | "confirmed" | "unconfirmed";
  phone: "quiet" | "confirmed";
}

export function familyThreadWorldPresentation(stage: FamilyThreadStage): FamilyThreadWorldPresentation {
  if (stage === "compound_calendar_crossed") return { calendar: "confirmed", phone: "quiet" };
  if (stage === "compound_confirmed") return { calendar: "confirmed", phone: "confirmed" };
  if (stage === "uncertainty_held") return { calendar: "unconfirmed", phone: "quiet" };
  return { calendar: "quiet", phone: "quiet" };
}

export function reduceFamilyThread(
  state: FamilyThreadState,
  event: FamilyThreadEvent,
): FamilyThreadState {
  if (event.type === "time_elapsed") return state;
  if (event.type === "reset") return initialFamilyThreadState;
  if (event.type === "ask" && state.stage === "idle") return { stage: "asking" };
  if (event.type === "read_completed" && state.stage === "asking") return { stage: "read" };
  if (event.type === "ask_failed" && state.stage === "asking") return { stage: "idle" };

  if (event.type === "prepare_email" && (state.stage === "read" || state.stage === "email_declined")) return { stage: "email_preparing" };
  if (event.type === "email_card_ready" && state.stage === "email_preparing") return { stage: "email_waiting" };
  if (event.type === "email_prepare_failed" && state.stage === "email_preparing") return { stage: "read" };
  if (event.type === "email_approved" && state.stage === "email_waiting") return { stage: "email_confirmed" };
  if (event.type === "email_declined" && state.stage === "email_waiting") return { stage: "email_declined" };

  if (event.type === "prepare_compound" && (state.stage === "email_confirmed" || state.stage === "compound_declined")) return { stage: "compound_preparing" };
  if (event.type === "compound_card_ready" && state.stage === "compound_preparing") return { stage: "compound_waiting" };
  if (event.type === "compound_prepare_failed" && state.stage === "compound_preparing") return { stage: "email_confirmed" };
  if (event.type === "compound_backend_confirmed" && state.stage === "compound_waiting") return { stage: "compound_calendar_crossed" };
  if (event.type === "compound_phone_presented" && state.stage === "compound_calendar_crossed") return { stage: "compound_confirmed" };
  if (event.type === "compound_declined" && state.stage === "compound_waiting") return { stage: "compound_declined" };

  if (event.type === "offer_conflict" && state.stage === "compound_confirmed") return { stage: "conflict_offered" };
  if (event.type === "prepare_conflict" && state.stage === "conflict_offered") return { stage: "conflict_preparing" };
  if (event.type === "conflict_card_ready" && state.stage === "conflict_preparing") return { stage: "conflict_waiting" };
  if (event.type === "conflict_prepare_failed" && state.stage === "conflict_preparing") return { stage: "compound_confirmed" };
  if (event.type === "conflict_returned" && state.stage === "conflict_waiting") return { stage: "conflict_returned" };
  if (event.type === "conflict_declined" && state.stage === "conflict_waiting") return { stage: "compound_confirmed" };

  if (event.type === "offer_uncertainty" && state.stage === "conflict_returned") return { stage: "uncertainty_offered" };
  if (event.type === "prepare_uncertainty" && state.stage === "uncertainty_offered") return { stage: "uncertainty_preparing" };
  if (event.type === "uncertainty_card_ready" && state.stage === "uncertainty_preparing") return { stage: "uncertainty_waiting" };
  if (event.type === "uncertainty_prepare_failed" && state.stage === "uncertainty_preparing") return { stage: "conflict_returned" };
  if (event.type === "uncertainty_held" && state.stage === "uncertainty_waiting") return { stage: "uncertainty_held" };
  if (event.type === "uncertainty_declined" && state.stage === "uncertainty_waiting") return { stage: "conflict_returned" };
  return state;
}
