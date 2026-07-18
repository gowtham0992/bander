export type FamilyThreadStage =
  | "idle"
  | "asking"
  | "read"
  | "preparing"
  | "card"
  | "sent"
  | "declined";

export interface FamilyThreadState {
  stage: FamilyThreadStage;
}

export type FamilyThreadEvent =
  | { type: "ask" }
  | { type: "read_completed" }
  | { type: "prepare" }
  | { type: "card_ready" }
  | { type: "ask_failed" }
  | { type: "prepare_failed" }
  | { type: "approved" }
  | { type: "declined" }
  | { type: "time_elapsed"; milliseconds: number };

export const initialFamilyThreadState: FamilyThreadState = { stage: "idle" };

export function reduceFamilyThread(
  state: FamilyThreadState,
  event: FamilyThreadEvent,
): FamilyThreadState {
  if (event.type === "time_elapsed") return state;
  if (event.type === "ask" && state.stage === "idle") return { stage: "asking" };
  if (event.type === "read_completed" && state.stage === "asking") return { stage: "read" };
  if (event.type === "ask_failed" && state.stage === "asking") return { stage: "idle" };
  if (event.type === "prepare" && (state.stage === "read" || state.stage === "declined")) return { stage: "preparing" };
  if (event.type === "card_ready" && state.stage === "preparing") return { stage: "card" };
  if (event.type === "prepare_failed" && state.stage === "preparing") return { stage: "read" };
  if (event.type === "approved" && state.stage === "card") return { stage: "sent" };
  if (event.type === "declined" && state.stage === "card") return { stage: "declined" };
  return state;
}
