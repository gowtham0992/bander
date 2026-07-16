import type {
  ApprovalCard,
  CalendarRescheduleEffect,
  DraftDocument,
  FamilyNotificationDocument,
  FamilyTelegramNotificationEffect,
  HumanReceipt,
  MessageSendEffect,
  ObservedExecutionResult,
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

export function formatCalendarIntervalWithContext(
  start: string,
  end: string,
  timeZone: string,
): string {
  const date = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone,
  }).format(new Date(start));
  const zone =
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "short",
    })
      .formatToParts(new Date(start))
      .find((part) => part.type === "timeZoneName")?.value ?? timeZone;
  return `${date}, ${formatInterval(start, end, timeZone)} ${zone}`;
}

function localDate(start: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).formatToParts(new Date(start));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
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

export function renderFamilyNotificationDocument(
  document: FamilyNotificationDocument,
): string {
  return [
    "Bander update",
    `“${document.eventTitle}” is now ${formatCalendarIntervalWithContext(
      document.newStartTime,
      document.newEndTime,
      document.timeZone,
    )}.`,
    "This update was sent by Bander at the owner’s request.",
  ].join("\n");
}

export function sanitizeFamilyNotificationTitle(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function createFamilyNotificationDocument(input: {
  eventTitle: string;
  newStartTime: string;
  newEndTime: string;
  timeZone: string;
}): FamilyNotificationDocument {
  const document: FamilyNotificationDocument = {
    kind: "calendar_transition",
    eventTitle: sanitizeFamilyNotificationTitle(input.eventTitle),
    newStartTime: new Date(input.newStartTime).toISOString(),
    newEndTime: new Date(input.newEndTime).toISOString(),
    timeZone: input.timeZone,
  };
  if (
    !document.eventTitle ||
    !Number.isFinite(Date.parse(document.newStartTime)) ||
    !Number.isFinite(Date.parse(document.newEndTime)) ||
    Date.parse(document.newEndTime) <= Date.parse(document.newStartTime)
  ) {
    throw new Error("Invalid family notification document");
  }
  new Intl.DateTimeFormat("en-US", { timeZone: document.timeZone }).format(
    new Date(document.newStartTime),
  );
  return document;
}

function familyNotificationLine(effect: FamilyTelegramNotificationEffect): string {
  return `send one Bander update to ${effect.binding.displayLabel}: “${renderFamilyNotificationDocument(effect.document)}”`;
}

export function renderApprovalCard(
  draftId: string,
  draftHash: string,
  document: DraftDocument,
): ApprovalCard {
  const allows = document.effects.map((effect) => {
    if (effect.type === "calendar.reschedule_event") return calendarLine(effect);
    if (effect.type === "messages.send") return messageLine(effect);
    return familyNotificationLine(effect);
  });
  const connections = [
    ...new Set(
      document.effects.map((effect) =>
        effect.type === "calendar.reschedule_event"
          ? "Calendar"
          : effect.type === "messages.send"
            ? "Messages"
            : "Family Telegram",
      ),
    ),
  ];
  const effectPreviews = document.effects.map((effect) =>
    effect.type === "calendar.reschedule_event"
      ? (() => {
          const crossesLocalDate =
            localDate(effect.expected.startTime, effect.expected.timeZone) !==
            localDate(effect.changes.startTime, effect.expected.timeZone);
          const preview = crossesLocalDate
            ? formatCalendarIntervalWithContext
            : formatInterval;
          return {
            kind: effect.type,
            eventTitle: effect.expected.title,
            previousInterval: preview(
              effect.expected.startTime,
              effect.expected.endTime,
              effect.expected.timeZone,
            ),
            resultingInterval: preview(
              effect.changes.startTime,
              effect.changes.endTime,
              effect.expected.timeZone,
            ),
          };
        })()
      : effect.type === "messages.send"
        ? {
          kind: effect.type,
          recipientDisplayName: effect.expected.displayName,
          body: effect.body,
        }
        : {
            kind: effect.type,
            recipientDisplayName: effect.binding.displayLabel,
            body: renderFamilyNotificationDocument(effect.document),
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
  observed?: ObservedExecutionResult,
): HumanReceipt {
  const calendar = document.effects.find(
    (effect): effect is CalendarRescheduleEffect =>
      effect.type === "calendar.reschedule_event",
  );
  const message = document.effects.find(
    (effect): effect is MessageSendEffect => effect.type === "messages.send",
  );
  const familyNotification = document.effects.find(
    (effect): effect is FamilyTelegramNotificationEffect =>
      effect.type === "family.telegram_notification",
  );
  if (!calendar) throw new Error("Draft cannot be rendered as a receipt");
  const completed = observed?.calendar.completed ?? {
    startTime: calendar.changes.startTime,
    endTime: calendar.changes.endTime,
    timeZone: calendar.expected.timeZone,
  };

  return {
    id,
    draftId,
    title: "Done",
    summary: `Completed as agreed: “${calendar.expected.title}” moved from ${formatInterval(calendar.expected.startTime, calendar.expected.endTime, calendar.expected.timeZone)} to ${formatInterval(completed.startTime, completed.endTime, completed.timeZone)}.`,
    detail: familyNotification
      ? observed?.familyNotification?.status === "delivered"
        ? `The approved update was sent to ${familyNotification.binding.displayLabel}.`
        : observed?.familyNotification?.status === "ambiguous"
          ? `The Calendar moved, but Bander could not confirm whether ${familyNotification.binding.displayLabel} received the update and will not send it again automatically.`
          : `The Calendar moved, but ${familyNotification.binding.displayLabel} was no longer connected and no family update was sent.`
      : message
        ? `${message.expected.displayName.split(" ")[0]} was notified.`
        : "No messages were sent.",
    calendar: {
      title: calendar.expected.title,
      previous: {
        startTime: calendar.expected.startTime,
        endTime: calendar.expected.endTime,
      },
      completed: {
        startTime: completed.startTime,
        endTime: completed.endTime,
      },
      timeZone: calendar.expected.timeZone,
      ...(observed?.calendar.status
        ? { executionStatus: observed.calendar.status }
        : {}),
    },
    ...(message
      ? {
          message: {
            recipientDisplayName: message.expected.displayName,
            body: message.body,
          },
        }
      : {}),
    ...(familyNotification
      ? {
          familyNotification: {
            recipientDisplayName: familyNotification.binding.displayLabel,
            status: observed?.familyNotification?.status ?? "not_sent",
            body: renderFamilyNotificationDocument(familyNotification.document),
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
  const supportedWeekdays = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  const supportedPredicate =
    predicate.resource.organizerMustBeOwner === true &&
    predicate.resource.attendeeIdsExactly.length === 1 &&
    predicate.resource.attendeeIdsExactly[0] === predicate.ownerId &&
    predicate.duration.mustRemainUnchanged === true &&
    predicate.time.weekDays.join(",") === supportedWeekdays.join(",") &&
    predicate.limits.rollingHours === 24 &&
    predicate.limits.maxNewRecipients === 0 &&
    predicate.limits.maxSpendCents === 0;
  if (!supportedPredicate) {
    throw new Error("Unsupported standing predicate cannot be rendered");
  }
  const displayClock = (value: string) => {
    const [hoursText, minutes = "00"] = value.split(":");
    const hours = Number(hoursText);
    const suffix = hours >= 12 ? "PM" : "AM";
    const clockHour = hours % 12 || 12;
    return `${clockHour}${minutes === "00" ? "" : `:${minutes}`} ${suffix}`;
  };
  const start = displayClock(predicate.time.startLocal);
  const end = displayClock(predicate.time.endLocal);
  return {
    candidateId: candidate.id,
    predicateHash: candidate.predicateHash,
    title: "A small routine, handled",
    clauses: [
      "Move events you organize and attend alone",
      "Keep them the same length",
      `Keep them within weekdays, ${start}–${end}`,
      `Make at most ${predicate.limits.maxActions} automatic moves per day`,
      "Never message anyone or spend money",
    ],
    expiresAt: candidate.expiresAt,
  };
}
