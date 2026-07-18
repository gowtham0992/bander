export type VerifiedOutcomeGroup = "Calendar" | "Email" | "Family" | "Refusals & uncertainty" | "Recovery & routine";

export interface VerifiedOutcome {
  id: string;
  routeId: string;
  group: VerifiedOutcomeGroup;
  sentence: string;
  glyph: "ask" | "calendar" | "mail" | "family" | "return" | "hold" | "replay" | "routine";
}

export const VERIFIED_OUTCOMES: readonly VerifiedOutcome[] = [
  { id: "schedule-read", routeId: "schedule", group: "Calendar", sentence: "Ask what is coming up without creating a deal or changing the seeded Calendar.", glyph: "ask" },
  { id: "move-event", routeId: "exact", group: "Calendar", sentence: "Move one exact event only after the complete before-and-after interval is approved.", glyph: "calendar" },
  { id: "move-changed", routeId: "conflict", group: "Calendar", sentence: "Stop a Calendar move when the seeded event changed after the deal was prepared.", glyph: "return" },
  { id: "create-event", routeId: "create", group: "Calendar", sentence: "Add one timed event with its full interval shown before anything changes.", glyph: "calendar" },
  { id: "create-replay", routeId: "create", group: "Calendar", sentence: "Replay an approved Calendar creation without adding a second copy.", glyph: "replay" },
  { id: "create-decline", routeId: "create", group: "Calendar", sentence: "Decline a Calendar creation and leave the seeded Calendar untouched.", glyph: "return" },
  { id: "cancel-event", routeId: "cancel", group: "Calendar", sentence: "Remove one eligible Calendar event only after its title and interval are approved.", glyph: "calendar" },
  { id: "cancel-replay", routeId: "cancel", group: "Calendar", sentence: "Replay an approved Calendar removal without issuing another removal.", glyph: "replay" },
  { id: "cancel-decline", routeId: "cancel", group: "Calendar", sentence: "Decline a Calendar removal and keep the seeded event in place.", glyph: "return" },
  { id: "cancel-changed", routeId: "cancel-conflict", group: "Calendar", sentence: "Refuse a Calendar removal when the event changed before approval.", glyph: "return" },
  { id: "inbox-read", routeId: "inbox", group: "Email", sentence: "Read a bounded seeded inbox summary without preparing or sending a reply.", glyph: "ask" },
  { id: "email-reply", routeId: "email", group: "Email", sentence: "Send one exact email reply only after its recipient, subject, and body are approved.", glyph: "mail" },
  { id: "email-replay", routeId: "email", group: "Email", sentence: "Replay an approved email reply without sending a second message.", glyph: "replay" },
  { id: "email-decline", routeId: "email", group: "Email", sentence: "Decline an email reply and leave seeded Sent Mail unchanged.", glyph: "return" },
  { id: "email-thread-change", routeId: "email-thread", group: "Email", sentence: "Stop an email reply when a newer message changed the conversation first.", glyph: "return" },
  { id: "email-uncertain", routeId: "email-ambiguous", group: "Email", sentence: "Hold an email result as unconfirmed instead of sending the reply again.", glyph: "hold" },
  { id: "family-direct", routeId: "direct-family", group: "Family", sentence: "Send one exact approved update to the separately connected family member.", glyph: "family" },
  { id: "family-direct-replay", routeId: "direct-family", group: "Family", sentence: "Replay an approved family update without sending it a second time.", glyph: "replay" },
  { id: "family-direct-decline", routeId: "direct-family", group: "Family", sentence: "Decline a family update so no seeded message is sent.", glyph: "return" },
  { id: "compound-family", routeId: "compound", group: "Family", sentence: "Approve one deal that changes the Calendar first and then sends its exact family update.", glyph: "family" },
  { id: "compound-replay", routeId: "compound", group: "Recovery & routine", sentence: "Replay the two-effect deal without another Calendar change or family update.", glyph: "replay" },
  { id: "calendar-uncertain", routeId: "ambiguous", group: "Refusals & uncertainty", sentence: "Hold an unknowable Calendar result without claiming success or no change.", glyph: "hold" },
  { id: "create-exact-copy", routeId: "create", group: "Recovery & routine", sentence: "Keep the approved create-event family text identical to the seeded sent update.", glyph: "family" },
  { id: "cancel-exact-copy", routeId: "cancel", group: "Recovery & routine", sentence: "Keep the approved removal family text identical to the seeded sent update.", glyph: "family" },
  { id: "standing-eligible", routeId: "standing", group: "Recovery & routine", sentence: "Handle one eligible seeded routine inside its exact approved limits.", glyph: "routine" },
  { id: "standing-review", routeId: "standing", group: "Recovery & routine", sentence: "Return a request outside the routine limits to one-time review.", glyph: "return" },
  { id: "standing-revoked", routeId: "standing", group: "Recovery & routine", sentence: "Turn off the seeded routine and require approval for future requests.", glyph: "routine" },
] as const;

export type SetupStationId = "sandbox" | "telegram" | "google" | "parent" | "family";

export interface SetupStation {
  id: SetupStationId;
  title: string;
  summary: string;
  detail: string;
  anchor: string;
  glyph: "window" | "bots" | "key" | "group" | "family";
}

export const SETUP_STATIONS: readonly SetupStation[] = [
  { id: "sandbox", title: "Try the hosted sandbox", summary: "See the complete seeded experience with no accounts or keys.", detail: "The hosted sandbox runs in the browser with deterministic data. It cannot touch Google, Telegram, Gmail, or OpenAI. Use it first to understand the parent experience.", anchor: "#fast-judge-sandbox-no-accounts-or-keys", glyph: "window" },
  { id: "telegram", title: "Create two Telegram bots", summary: "Give the assistant and Bander distinct identities in one protected thread.", detail: "Create one bot for OpenClaw and one for Bander, then apply the documented BotFather privacy settings. The separation makes it clear who is talking and who holds approval authority.", anchor: "#2-create-two-visually-distinct-telegram-bots", glyph: "bots" },
  { id: "google", title: "Connect a dedicated Google account", summary: "Keep narrow Calendar and Gmail credentials in Bander’s process.", detail: "Use separate Desktop OAuth clients and tokens for Calendar and Gmail. The supported path uses a dedicated Google account in External/Testing mode with configured test users.", anchor: "#4-configure-separate-narrow-google-desktop-oauth-clients", glyph: "key" },
  { id: "parent", title: "Pair the parent’s Telegram group", summary: "Bind approvals to one parent and one protected conversation.", detail: "Bander creates a short-lived pairing link for the parent. The parent claims it privately, then chooses the protected group where OpenClaw and Bander are already present.", anchor: "#5-pair-the-parent-and-protected-group", glyph: "group" },
  { id: "family", title: "Invite one family member", summary: "Connect one separately consenting person for exact approved updates.", detail: "Send the private family link to the invited person on their own phone. They consent in Bander’s private chat and remain outside the protected parent group.", anchor: "#6-optionally-connect-one-family-member", glyph: "family" },
] as const;

export type ComparisonStage = "closed" | "beat_1" | "beat_2" | "beat_3" | "complete";
export type ProofStage = "closed" | "open" | "comparison";
export type WorldSheet = "calendar" | "inbox" | "phone" | null;

export interface ProductSurfaceState {
  proof: ProofStage;
  comparison: ComparisonStage;
  setupStation: SetupStationId | null;
  worldSheet: WorldSheet;
}

export type ProductSurfaceEvent =
  | { type: "open_proof" }
  | { type: "open_full_comparison" }
  | { type: "close_proof" }
  | { type: "open_comparison" }
  | { type: "next_comparison_beat" }
  | { type: "close_comparison" }
  | { type: "open_setup"; stationId: SetupStationId }
  | { type: "close_setup" }
  | { type: "open_world"; world: Exclude<WorldSheet, null> }
  | { type: "close_world" }
  | { type: "time_elapsed"; milliseconds: number };

export const initialProductSurfaceState: ProductSurfaceState = {
  proof: "closed",
  comparison: "closed",
  setupStation: null,
  worldSheet: null,
};

export function reduceProductSurface(state: ProductSurfaceState, event: ProductSurfaceEvent): ProductSurfaceState {
  if (event.type === "time_elapsed") return state;
  if (event.type === "open_proof") return { ...state, proof: "open" };
  if (event.type === "open_full_comparison") return { ...state, proof: "comparison" };
  if (event.type === "close_proof") return { ...state, proof: "closed" };
  if (event.type === "open_comparison") return { ...state, comparison: "beat_1" };
  if (event.type === "next_comparison_beat") {
    const next: Record<ComparisonStage, ComparisonStage> = { closed: "closed", beat_1: "beat_2", beat_2: "beat_3", beat_3: "complete", complete: "complete" };
    return { ...state, comparison: next[state.comparison] };
  }
  if (event.type === "close_comparison") return { ...state, comparison: "closed" };
  if (event.type === "open_setup") return { ...state, setupStation: event.stationId };
  if (event.type === "close_setup") return { ...state, setupStation: null };
  if (event.type === "open_world") return { ...state, worldSheet: event.world };
  if (event.type === "close_world") return { ...state, worldSheet: null };
  return state;
}
