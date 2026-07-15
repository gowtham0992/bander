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

export interface DemoSandboxState {
  calendar: DemoCalendarItem[];
  messages: DemoMessageItem[];
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

export interface MessageSendEffect {
  type: "messages.send";
  recipientId: string;
  expected: {
    revision: number;
    displayName: string;
  };
  body: string;
}

export type DraftEffect = CalendarRescheduleEffect | MessageSendEffect;

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
  provenanceLabel: "Your agent says your request was:";
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
      kind: "calendar.reschedule_event";
      eventTitle: string;
      previousInterval: string;
      resultingInterval: string;
    }
  | {
      kind: "messages.send";
      recipientDisplayName: string;
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
  calendar: {
    title: string;
    previous: { startTime: string; endTime: string };
    completed: { startTime: string; endTime: string };
    timeZone: string;
  };
  message?: {
    recipientDisplayName: string;
    body: string;
  };
  completedAt: string;
}

export interface AgentReceipt {
  draftId: string;
  status: StoredDraft["status"];
}
