import type {
  ApprovalCard,
  CalendarUpdateEffect,
  DraftDocument,
  HumanReceipt,
  MessageSendEffect,
  StandingBandCard,
  StandingBandCandidate,
} from "@bander/contracts";

function formatTime(value: string, timeZone = "America/Denver"): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(value));
}

function calendarLine(effect: CalendarUpdateEffect): string {
  return `move ${effect.expected.title} to ${formatTime(effect.changes.startTime)}`;
}

function messageLine(effect: MessageSendEffect): string {
  return `send one message to ${effect.expected.displayName}: “${effect.body}”`;
}

export function renderApprovalCard(
  draftId: string,
  draftHash: string,
  document: DraftDocument,
): ApprovalCard {
  const allows = document.effects.map((effect) =>
    effect.type === "calendar.update_event" ? calendarLine(effect) : messageLine(effect),
  );
  const connections = [
    ...new Set(
      document.effects.map((effect) =>
        effect.type === "calendar.update_event" ? "Calendar" : "Messages",
      ),
    ),
  ];

  return {
    draftId,
    draftHash,
    title: "Here’s the deal",
    provenanceLabel: "Your agent says your request was:",
    claimedUserRequest: document.source.claimedUserRequest,
    allows,
    notAllowed: "Other Bander-managed effects outside this Draft.",
    boundary:
      "Bander does not control tools, credentials, or accounts that bypass Bander.",
    connections,
    expiresAt: document.expiresAt,
  };
}

export function renderHumanReceipt(
  id: string,
  draftId: string,
  document: DraftDocument,
  completedAt: string,
): HumanReceipt {
  const calendar = document.effects.find(
    (effect): effect is CalendarUpdateEffect => effect.type === "calendar.update_event",
  );
  const message = document.effects.find(
    (effect): effect is MessageSendEffect => effect.type === "messages.send",
  );
  if (!calendar) throw new Error("Draft cannot be rendered as a receipt");

  return {
    id,
    draftId,
    title: "Done",
    summary: `Completed as agreed: ${calendar.expected.title} moved to ${formatTime(calendar.changes.startTime)}.`,
    detail: message
      ? `${message.expected.displayName.split(" ")[0]} was notified.`
      : "No messages were sent.",
    completedAt,
  };
}

export function renderStandingBandCard(
  candidate: StandingBandCandidate,
): StandingBandCard {
  const { predicate } = candidate;
  return {
    candidateId: candidate.id,
    predicateHash: candidate.predicateHash,
    title: "A small routine, handled",
    clauses: [
      "Only appointments where you are the organizer and only attendee",
      "Only the start time may change; never cancel or change duration",
      `Only Monday–Friday, ${predicate.time.startLocal}–${predicate.time.endLocal} ${predicate.time.timeZone}`,
      "Never send a message or make a purchase",
      `At most ${predicate.limits.maxActions} actions per rolling day · expires ${new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: predicate.time.timeZone }).format(new Date(candidate.expiresAt))} · revoke anytime`,
    ],
    expiresAt: candidate.expiresAt,
  };
}
