import type {
  ApprovalCard,
  CalendarRescheduleEffect,
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

function formatInterval(start: string, end: string, timeZone: string): string {
  const startLabel = formatTime(start, timeZone);
  const endLabel = formatTime(end, timeZone);
  const startMeridiem = startLabel.match(/ (AM|PM)$/)?.[1];
  const endMeridiem = endLabel.match(/ (AM|PM)$/)?.[1];
  const compactStart =
    startMeridiem && startMeridiem === endMeridiem
      ? startLabel.replace(/ (AM|PM)$/, "")
      : startLabel;
  return `${compactStart}–${endLabel}`;
}

function calendarLine(effect: CalendarRescheduleEffect): string {
  const previous = formatInterval(
    effect.expected.startTime,
    effect.expected.endTime,
    effect.expected.timeZone,
  );
  const next = formatInterval(
    effect.changes.startTime,
    effect.changes.endTime,
    effect.expected.timeZone,
  );
  return `reschedule “${effect.expected.title}” from ${previous} to ${next}`;
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
    effect.type === "calendar.reschedule_event" ? calendarLine(effect) : messageLine(effect),
  );
  const connections = [
    ...new Set(
      document.effects.map((effect) =>
        effect.type === "calendar.reschedule_event" ? "Calendar" : "Messages",
      ),
    ),
  ];
  const effectPreviews = document.effects.map((effect) =>
    effect.type === "calendar.reschedule_event"
      ? {
          kind: effect.type,
          eventTitle: effect.expected.title,
          previousInterval: formatInterval(
            effect.expected.startTime,
            effect.expected.endTime,
            effect.expected.timeZone,
          ),
          resultingInterval: formatInterval(
            effect.changes.startTime,
            effect.changes.endTime,
            effect.expected.timeZone,
          ),
        }
      : {
          kind: effect.type,
          recipientDisplayName: effect.expected.displayName,
          body: effect.body,
        },
  );

  return {
    draftId,
    draftHash,
    title: "Here’s the deal",
    provenanceLabel: "Your agent says your request was:",
    claimedUserRequest: document.source.claimedUserRequest,
    allows,
    effectPreviews,
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
    (effect): effect is CalendarRescheduleEffect =>
      effect.type === "calendar.reschedule_event",
  );
  const message = document.effects.find(
    (effect): effect is MessageSendEffect => effect.type === "messages.send",
  );
  if (!calendar) throw new Error("Draft cannot be rendered as a receipt");

  return {
    id,
    draftId,
    title: "Done",
    summary: `Completed as agreed: “${calendar.expected.title}” moved from ${formatInterval(calendar.expected.startTime, calendar.expected.endTime, calendar.expected.timeZone)} to ${formatInterval(calendar.changes.startTime, calendar.changes.endTime, calendar.expected.timeZone)}.`,
    detail: message
      ? `${message.expected.displayName.split(" ")[0]} was notified.`
      : "No messages were sent.",
    calendar: {
      title: calendar.expected.title,
      previous: {
        startTime: calendar.expected.startTime,
        endTime: calendar.expected.endTime,
      },
      completed: {
        startTime: calendar.changes.startTime,
        endTime: calendar.changes.endTime,
      },
      timeZone: calendar.expected.timeZone,
    },
    ...(message
      ? {
          message: {
            recipientDisplayName: message.expected.displayName,
            body: message.body,
          },
        }
      : {}),
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
      "Only reschedule the complete appointment; never cancel or change duration",
      `The resulting appointment must start and finish Monday–Friday between ${predicate.time.startLocal} and ${predicate.time.endLocal} ${predicate.time.timeZone}`,
      "Never send a message or make a purchase",
      `At most ${predicate.limits.maxActions} actions per rolling day · expires ${new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: predicate.time.timeZone }).format(new Date(candidate.expiresAt))} · revoke anytime`,
    ],
    expiresAt: candidate.expiresAt,
  };
}
