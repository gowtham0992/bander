export interface CalendarEvent {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  timeZone: string;
  organizerId: string;
  attendeeIds: string[];
  revision: number;
  etag: string;
}

export type ScheduleReadEvent =
  | {
      title: string;
      allDay: true;
      startLocalDate: string;
      endLocalDateExclusive: string;
    }
  | {
      title: string;
      allDay: false;
      start: { localDate: string; localTime: string };
      end: { localDate: string; localTime: string };
    };

export interface ScheduleReadResult {
  requestedRange: {
    startLocalDate: string;
    endLocalDateExclusive: string;
  };
  timeZone: string;
  events: ScheduleReadEvent[];
  empty: boolean;
  truncated: boolean;
  maxEvents: number;
}

export interface InboxReadMessage {
  sender: string;
  subject: string;
  receivedAt: string;
  excerpt: string;
}

export interface InboxReadResult {
  requestedRange: {
    startLocalDate: string;
    endLocalDateExclusive: string;
  };
  messages: InboxReadMessage[];
  empty: boolean;
  truncated: boolean;
  maxMessages: number;
}

export interface Person {
  id: string;
  displayName: string;
  messageAddress: string;
  revision: number;
}

export interface SentMessage {
  id: string;
  recipientId: string;
  body: string;
  idempotencyKey: string;
  sentAt: string;
}

export interface DemoCalendarItem {
  title: string;
  startTime: string;
  endTime: string;
  timeZone: string;
}

export interface DemoMessageItem {
  recipientDisplayName: string;
  body: string;
  sentAt: string;
}

export interface DemoFamilyUpdateItem {
  recipientDisplayName: string;
  body: string;
  sentAt: string;
}

export interface DemoInboxItem {
  sender: string;
  subject: string;
  receivedAt: string;
  excerpt: string;
}

export interface DemoSentEmailItem {
  recipient: string;
  subject: string;
  body: string;
  sentAt: string;
}

export interface DemoSandboxState {
  calendar: DemoCalendarItem[];
  messages: DemoMessageItem[];
  familyUpdates: DemoFamilyUpdateItem[];
  inbox: DemoInboxItem[];
  sentEmails: DemoSentEmailItem[];
}

export interface MockSeed {
  events: CalendarEvent[];
  people: Person[];
}

export interface CalendarRescheduleEffect {
  type: "calendar.reschedule_event";
  eventId: string;
  expected: {
    etag: string;
    title: string;
    startTime: string;
    endTime: string;
    timeZone: string;
    organizerId: string;
    attendeeIds: string[];
  };
  changes: {
    startTime: string;
    endTime: string;
  };
}

export interface CalendarCreateEffect {
  type: "calendar.create_event";
  calendarId: "primary";
  eventId: string;
  title: string;
  startTime: string;
  endTime: string;
  timeZone: string;
  eventType: "default";
}

export interface CalendarCancelEffect {
  type: "calendar.cancel_event";
  calendarId: "primary";
  eventId: string;
  expected: {
    etag: string;
    title: string;
    startTime: string;
    endTime: string;
    timeZone: string;
    eventType: "default";
    organizerMustBeOwner: true;
    attendeeIdsExactly: [];
    recurring: false;
  };
}

export interface MessageSendEffect {
  type: "messages.send";
  recipientId: string;
  expected: {
    revision: number;
    displayName: string;
  };
  body: string;
}

export type FamilyNotificationDocument =
  | {
      kind: "calendar_transition";
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
    }
  | {
      kind: "direct_message";
      body: string;
    };

export interface EmailReplyEffect {
  type: "email.reply";
  sourceMessageId: string;
  threadId: string;
  latestThreadMessageId: string;
  recipient: string;
  subject: string;
  inReplyTo: string;
  references: string[];
  body: string;
  rfcMessageId: string;
  reconciliationToken: string;
  rawMimeBase64Url: string;
  mimeDigest: string;
}

export interface FamilyTelegramNotificationEffect {
  type: "family.telegram_notification";
  binding: {
    installationId: string;
    contactId: string;
    pairingRevision: string;
    displayLabel: string;
  };
  document: FamilyNotificationDocument;
}

export type DraftEffect =
  | CalendarRescheduleEffect
  | CalendarCreateEffect
  | CalendarCancelEffect
  | MessageSendEffect
  | EmailReplyEffect
  | FamilyTelegramNotificationEffect;

export interface DraftDocument {
  version: 1;
  source: {
    provenance: "agent_claimed";
    claimedUserRequest: string;
  };
  effects: DraftEffect[];
  createdAt: string;
  expiresAt: string;
}

export interface StoredDraft {
  id: string;
  hash: string;
  document: DraftDocument;
  status:
    | "proposed"
    | "approved"
    | "executed"
    | "declined"
    | "expired"
    | "revoked"
    | "blocked"
    | "conflict";
}

export interface ApprovalCard {
  draftId: string;
  draftHash: string;
  title: "Here’s the deal";
  provenanceLabel: "Your assistant says you asked:";
  claimedUserRequest: string;
  allows: string[];
  effectPreviews: ApprovalEffectPreview[];
  notAllowed: string;
  boundary: string;
  connections: string[];
  expiresAt: string;
  proposalActivity?: {
    count: number;
    limit: number;
    windowMinutes: number;
  };
}

export type ApprovalEffectPreview =
  | {
      kind: "calendar.cancel_event";
      eventTitle: string;
      previousInterval: string;
    }
  | {
      kind: "calendar.create_event";
      eventTitle: string;
      resultingInterval: string;
    }
  | {
      kind: "calendar.reschedule_event";
      eventTitle: string;
      previousInterval: string;
      resultingInterval: string;
    }
  | {
      kind: "messages.send";
      recipientDisplayName: string;
      body: string;
    }
  | {
      kind: "family.telegram_notification";
      recipientDisplayName: string;
      body: string;
    }
  | {
      kind: "email.reply";
      recipient: string;
      subject: string;
      body: string;
    };

export interface OneTimeBand {
  id: string;
  mode: "one_time";
  draftId: string;
  draftHash: string;
  approvedAt: string;
  expiresAt: string;
  status: "active" | "consumed" | "revoked";
}

export interface StandingBandPredicate {
  version: 1;
  actionType: "calendar.reschedule_event";
  ownerId: string;
  resource: {
    organizerMustBeOwner: true;
    attendeeIdsExactly: string[];
  };
  duration: {
    mustRemainUnchanged: true;
  };
  time: {
    weekDays: ["Mon", "Tue", "Wed", "Thu", "Fri"];
    startLocal: "09:00";
    endLocal: "17:00";
    timeZone: string;
  };
  limits: {
    maxActions: 3;
    rollingHours: 24;
    maxNewRecipients: 0;
    maxSpendCents: 0;
  };
}

export interface StandingBandCandidate {
  id: string;
  predicateHash: string;
  predicate: StandingBandPredicate;
  createdAt: string;
  expiresAt: string;
  status: "proposed" | "approved" | "declined";
  approvedBandId?: string;
}

export interface StandingBand {
  id: string;
  mode: "standing";
  predicateHash: string;
  predicate: StandingBandPredicate;
  approvedAt: string;
  expiresAt: string;
  status: "active" | "revoked";
  actionTimestamps: string[];
}

export interface StandingExecutionRequest {
  bandId: string;
  requestId: string;
  requestDigest: string;
  draftId: string;
  status: "drafted" | "review_required" | "executing" | "executed" | "conflict";
  createdAt: string;
  permitId?: string;
  receiptId?: string;
  proposalActivity?: {
    count: number;
    limit: number;
    windowMinutes: number;
  };
}

export type Band = OneTimeBand | StandingBand;

export interface StandingBandCard {
  candidateId: string;
  predicateHash: string;
  title: "A small routine, handled";
  clauses: string[];
  expiresAt: string;
}

export interface Permit {
  id: string;
  nonce: string;
  bandId: string;
  draftId: string;
  draftHash: string;
  executor: "bander_executor";
  expiresAt: string;
  dispatchedAt?: string;
  consumedAt?: string;
  receiptId?: string;
}

export interface HumanReceipt {
  id: string;
  draftId: string;
  title: "Done";
  summary: string;
  detail: string;
  calendar?:
    | {
        title: string;
        previous: { startTime: string; endTime: string };
        completed: { startTime: string; endTime: string };
        timeZone: string;
        executionStatus?: "committed" | "observed_target";
      }
    | {
        created: true;
        title: string;
        completed: { startTime: string; endTime: string };
        timeZone: string;
        executionStatus: "committed" | "observed_target";
      }
    | {
        removed: true;
        title: string;
        previous: { startTime: string; endTime: string };
        timeZone: string;
        executionStatus: "committed" | "observed_target";
      };
  emailReply?: {
    recipient: string;
    subject: string;
    body: string;
    status: "committed" | "observed_target";
  };
  message?: {
    recipientDisplayName: string;
    body: string;
  };
  familyNotification?: {
    recipientDisplayName: string;
    status: "delivered" | "ambiguous" | "not_sent";
    body: string;
  };
  completedAt: string;
}

export interface ObservedExecutionResult {
  calendar?: {
    status: "committed" | "observed_target";
    action?: "created" | "removed";
    completed: {
      startTime: string;
      endTime: string;
      timeZone: string;
    };
  };
  familyNotification?: {
    status: "delivered" | "ambiguous" | "not_sent";
  };
  emailReply?: {
    status: "committed" | "observed_target";
  };
}

export interface AgentReceipt {
  draftId: string;
  status: StoredDraft["status"];
}
