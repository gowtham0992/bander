import type {
  ApprovalCard,
  CalendarCancelEffect,
  CalendarCreateEffect,
  CalendarRescheduleEffect,
  DraftDocument,
  EmailReplyEffect,
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
  includeTimeZone = true,
): string {
  const date = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone,
  }).format(new Date(start));
  const zone = timeZone === "America/Denver" ? "Mountain time" : timeZone;
  return `${date}, ${formatInterval(start, end, timeZone)}${includeTimeZone ? ` (${zone})` : ""}`;
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
  if (document.kind === "direct_message") {
    return [document.body, "", "Approved word-for-word before Bander sent it."].join("\n");
  }
  const interval =
    document.kind === "calendar_transition"
      ? formatCalendarIntervalWithContext(
          document.newStartTime,
          document.newEndTime,
          document.timeZone,
        )
      : formatCalendarIntervalWithContext(
          document.startTime,
          document.endTime,
          document.timeZone,
        );
  const stateLine =
    document.kind === "calendar_cancellation"
      ? `“${document.eventTitle}”, ${interval}, is no longer on the calendar.`
      : `“${document.eventTitle}” ${document.kind === "calendar_creation" ? "was added for" : "moved to"} ${interval}.`;
  return [
    stateLine,
    "",
    "Approved word-for-word before Bander sent it.",
  ].join("\n");
}

export function createDirectFamilyDocument(body: string): FamilyNotificationDocument {
  const safe = body
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (
    !safe ||
    safe.length > 500 ||
    /(?:https?:\/\/|www\.|\b(?:t\.me|telegram\.me)\/)/i.test(safe) ||
    /^\s*\//.test(safe) ||
    /^(?:bander|openclaw)\b\s*[:—-]?/i.test(safe) ||
    /(?:approved by bander|do exactly this|nothing has happened yet|already done|done\s*[✓✔])/i.test(safe)
  ) {
    throw new Error("Invalid direct family message");
  }
  return { kind: "direct_message", body: safe };
}

export function sanitizeFamilyNotificationTitle(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function createFamilyNotificationDocument(
  input:
    | {
        kind?: "calendar_transition";
        eventTitle: string;
        newStartTime: string;
        newEndTime: string;
        timeZone: string;
      }
    | {
        kind: "calendar_creation";
        eventTitle: string;
        startTime: string;
        endTime: string;
        timeZone: string;
      }
    | {
        kind: "calendar_cancellation";
        eventTitle: string;
        startTime: string;
        endTime: string;
        timeZone: string;
      },
): FamilyNotificationDocument {
  const document: FamilyNotificationDocument =
    input.kind === "calendar_creation"
      ? {
          kind: "calendar_creation",
          eventTitle: sanitizeFamilyNotificationTitle(input.eventTitle),
          startTime: new Date(input.startTime).toISOString(),
          endTime: new Date(input.endTime).toISOString(),
          timeZone: input.timeZone,
        }
      : input.kind === "calendar_cancellation"
        ? {
            kind: "calendar_cancellation",
            eventTitle: sanitizeFamilyNotificationTitle(input.eventTitle),
            startTime: new Date(input.startTime).toISOString(),
            endTime: new Date(input.endTime).toISOString(),
            timeZone: input.timeZone,
          }
      : {
          kind: "calendar_transition",
          eventTitle: sanitizeFamilyNotificationTitle(input.eventTitle),
          newStartTime: new Date(input.newStartTime).toISOString(),
          newEndTime: new Date(input.newEndTime).toISOString(),
          timeZone: input.timeZone,
        };
  const start = document.kind === "calendar_transition" ? document.newStartTime : document.startTime;
  const end = document.kind === "calendar_transition" ? document.newEndTime : document.endTime;
  if (
    !document.eventTitle ||
    !Number.isFinite(Date.parse(start)) ||
    !Number.isFinite(Date.parse(end)) ||
    Date.parse(end) <= Date.parse(start)
  ) {
    throw new Error("Invalid family notification document");
  }
  new Intl.DateTimeFormat("en-US", { timeZone: document.timeZone }).format(
    new Date(start),
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
    if (effect.type === "calendar.cancel_event") {
      return `remove “${effect.expected.title}” from Calendar at ${formatCalendarIntervalWithContext(effect.expected.startTime, effect.expected.endTime, effect.expected.timeZone)}`;
    }
    if (effect.type === "calendar.create_event") {
      return `add “${effect.title}” to Calendar for ${formatCalendarIntervalWithContext(effect.startTime, effect.endTime, effect.timeZone)}`;
    }
    if (effect.type === "messages.send") return messageLine(effect);
    if (effect.type === "email.reply") {
      return `reply by email to ${effect.recipient} about “${effect.subject}”: “${effect.body}”`;
    }
    return familyNotificationLine(effect);
  });
  const connections = [
    ...new Set(
      document.effects.map((effect) =>
        effect.type === "calendar.reschedule_event"
          ? "Calendar"
          : effect.type === "calendar.cancel_event"
            ? "Calendar"
          : effect.type === "calendar.create_event"
            ? "Calendar"
          : effect.type === "messages.send"
            ? "Messages"
            : effect.type === "email.reply"
              ? "Gmail"
            : "Family Telegram",
      ),
    ),
  ];
  const effectPreviews = document.effects.map((effect) =>
    effect.type === "calendar.reschedule_event"
      ? (() => {
          return {
            kind: effect.type,
            eventTitle: effect.expected.title,
            previousInterval: formatCalendarIntervalWithContext(
              effect.expected.startTime,
              effect.expected.endTime,
              effect.expected.timeZone,
            ),
            resultingInterval: formatCalendarIntervalWithContext(
              effect.changes.startTime,
              effect.changes.endTime,
              effect.expected.timeZone,
              false,
            ),
          };
        })()
      : effect.type === "calendar.cancel_event"
        ? {
            kind: effect.type,
            eventTitle: effect.expected.title,
            previousInterval: formatCalendarIntervalWithContext(
              effect.expected.startTime,
              effect.expected.endTime,
              effect.expected.timeZone,
            ),
          }
      : effect.type === "calendar.create_event"
        ? {
            kind: effect.type,
            eventTitle: effect.title,
            resultingInterval: formatCalendarIntervalWithContext(
              effect.startTime,
              effect.endTime,
              effect.timeZone,
            ),
          }
      : effect.type === "messages.send"
        ? {
          kind: effect.type,
          recipientDisplayName: effect.expected.displayName,
          body: effect.body,
        }
        : effect.type === "email.reply"
          ? {
              kind: effect.type,
              recipient: effect.recipient,
              subject: effect.subject,
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
    provenanceLabel: "Your assistant says you asked:",
    claimedUserRequest: document.source.claimedUserRequest,
    allows,
    effectPreviews,
    notAllowed: "Anything not shown in this deal.",
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
  const createdCalendar = document.effects.find(
    (effect): effect is CalendarCreateEffect =>
      effect.type === "calendar.create_event",
  );
  const cancelledCalendar = document.effects.find(
    (effect): effect is CalendarCancelEffect =>
      effect.type === "calendar.cancel_event",
  );
  const message = document.effects.find(
    (effect): effect is MessageSendEffect => effect.type === "messages.send",
  );
  const familyNotification = document.effects.find(
    (effect): effect is FamilyTelegramNotificationEffect =>
      effect.type === "family.telegram_notification",
  );
  const emailReply = document.effects.find(
    (effect): effect is EmailReplyEffect => effect.type === "email.reply",
  );
  if (emailReply) {
    if (!observed?.emailReply || document.effects.length !== 1) {
      throw new Error("Email reply cannot be rendered without an observed result");
    }
    return {
      id,
      draftId,
      title: "Done",
      summary:
        observed.emailReply.status === "observed_target"
          ? `Your Sent folder now shows the approved reply to ${emailReply.recipient}.`
          : `Sent the approved reply to ${emailReply.recipient}.`,
      detail: `Subject: ${emailReply.subject}. No one else was included.`,
      emailReply: {
        recipient: emailReply.recipient,
        subject: emailReply.subject,
        body: emailReply.body,
        status: observed.emailReply.status,
      },
      completedAt,
    };
  }
  if (familyNotification?.document.kind === "direct_message") {
    if (!observed?.familyNotification || document.effects.length !== 1) {
      throw new Error("Family message cannot be rendered without an observed result");
    }
    const status = observed.familyNotification.status;
    return {
      id,
      draftId,
      title: "Done",
      summary:
        status === "delivered"
          ? `Sent the approved message to ${familyNotification.binding.displayLabel}.`
          : status === "ambiguous"
          ? `Bander could not confirm whether Telegram accepted the approved message for ${familyNotification.binding.displayLabel} and will not send it again automatically.`
            : `${familyNotification.binding.displayLabel} was no longer connected, so no message was sent.`,
      detail: status === "delivered" ? "Telegram accepted the message; that does not prove it was read." : "Nothing will be retried automatically.",
      familyNotification: {
        recipientDisplayName: familyNotification.binding.displayLabel,
        status,
        body: renderFamilyNotificationDocument(familyNotification.document),
      },
      completedAt,
    };
  }
  if ([calendar, createdCalendar, cancelledCalendar].filter(Boolean).length !== 1) {
    throw new Error("Draft cannot be rendered as a receipt");
  }
  const calendarObservation = observed?.calendar;
  const completed = calendarObservation?.completed ?? (calendar ? {
    startTime: calendar.changes.startTime,
    endTime: calendar.changes.endTime,
    timeZone: calendar.expected.timeZone,
  } : createdCalendar ? {
    startTime: createdCalendar!.startTime,
    endTime: createdCalendar!.endTime,
    timeZone: createdCalendar!.timeZone,
  } : {
    startTime: cancelledCalendar!.expected.startTime,
    endTime: cancelledCalendar!.expected.endTime,
    timeZone: cancelledCalendar!.expected.timeZone,
  });
  const title = calendar?.expected.title ?? createdCalendar?.title ?? cancelledCalendar!.expected.title;
  const timeZone = calendar?.expected.timeZone ?? createdCalendar?.timeZone ?? cancelledCalendar!.expected.timeZone;

  return {
    id,
    draftId,
    title: "Done",
    summary: calendar
      ? `Completed as agreed: “${calendar.expected.title}” moved from ${formatInterval(calendar.expected.startTime, calendar.expected.endTime, calendar.expected.timeZone)} to ${formatInterval(completed.startTime, completed.endTime, completed.timeZone)}.`
      : cancelledCalendar
        ? calendarObservation?.status === "observed_target"
          ? `Your calendar no longer shows the approved event: “${title}” at ${formatInterval(completed.startTime, completed.endTime, completed.timeZone)}.`
          : `Removed as agreed: “${title}” at ${formatInterval(completed.startTime, completed.endTime, completed.timeZone)}.`
      : calendarObservation?.status === "observed_target"
        ? `Your calendar now shows the approved event: “${title}” at ${formatInterval(completed.startTime, completed.endTime, completed.timeZone)}.`
        : `Added as agreed: “${title}” at ${formatInterval(completed.startTime, completed.endTime, completed.timeZone)}.`,
    detail: familyNotification
      ? observed?.familyNotification?.status === "delivered"
        ? `The approved update was sent to ${familyNotification.binding.displayLabel}.`
        : observed?.familyNotification?.status === "ambiguous"
          ? `The Calendar action completed, but Bander could not confirm whether Telegram accepted the update for ${familyNotification.binding.displayLabel} and will not send it again automatically.`
          : `The Calendar action completed, but ${familyNotification.binding.displayLabel} was no longer connected and no family update was sent.`
      : message
        ? `${message.expected.displayName.split(" ")[0]} was notified.`
        : "No messages were sent.",
    calendar: calendar
      ? {
          title,
          previous: {
            startTime: calendar.expected.startTime,
            endTime: calendar.expected.endTime,
          },
          completed: {
            startTime: completed.startTime,
            endTime: completed.endTime,
          },
          timeZone,
          ...(calendarObservation?.status
            ? { executionStatus: calendarObservation.status }
            : {}),
        }
      : cancelledCalendar
        ? {
            removed: true,
            title,
            previous: {
              startTime: cancelledCalendar.expected.startTime,
              endTime: cancelledCalendar.expected.endTime,
            },
            timeZone,
            executionStatus: calendarObservation?.status ?? "committed",
          }
      : {
          created: true,
          title,
          completed: {
            startTime: completed.startTime,
            endTime: completed.endTime,
          },
          timeZone,
          executionStatus: calendarObservation?.status ?? "committed",
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
