import { useEffect, useReducer, useRef, useState } from "react";
import type {
  ApprovalCard,
  ApprovalEffectPreview,
  DemoSandboxState,
  HumanReceipt,
  StandingBandCard,
  ScheduleReadResult,
} from "@bander/contracts";
import { createDemoBackend } from "./backend/index.js";
import { WorldGlyph } from "./family-thread-glyphs.js";
import { R2_PRESENTATION_BEAT_MS, familyThreadWorldPresentation, initialFamilyThreadState, reduceFamilyThread } from "./family-thread-state.js";
import { initialProductSurfaceState, reduceProductSurface } from "./family-thread-surfaces.js";
import { ClosingPanel, ComparisonThread, EvidenceLightbox, ProofDrawer, SetupRail, WorldDetailSheet } from "./family-thread-surface-view.js";

const demoBackend = createDemoBackend();

type StandingRunResponse =
  | { status: "executed"; receipt: HumanReceipt }
  | { status: "review_required"; card: ApprovalCard };

type DealScenario =
  | "exact"
  | "conflict"
  | "compound"
  | "ambiguous"
  | "create"
  | "cancel"
  | "cancel-conflict"
  | "email"
  | "email-thread"
  | "email-ambiguous"
  | "direct-family";

export interface StandingRunInput {
  bandId: string;
  fixtureId: string;
  requestId: string;
  expected: "executed" | "review_required";
}

type Screen =
  | { kind: "welcome" }
  | { kind: "loading"; message: string }
  | { kind: "card"; card: ApprovalCard; scenario: DealScenario }
  | { kind: "receipt"; receipt: HumanReceipt }
  | { kind: "compound-receipt"; receipt: HumanReceipt; state: DemoSandboxState; card: ApprovalCard; replayed: boolean }
  | { kind: "schedule-read"; result: ScheduleReadResult }
  | { kind: "inbox-read"; messages: DemoSandboxState["inbox"] }
  | { kind: "ambiguous-outcome"; message: string; card: ApprovalCard; state: DemoSandboxState }
  | { kind: "cancel-conflict-outcome"; state: DemoSandboxState }
  | { kind: "email-thread-changed" }
  | { kind: "initialization-failed" }
  | { kind: "standing-card"; card: StandingBandCard }
  | { kind: "standing-receipt"; receipt: HumanReceipt; bandId: string }
  | { kind: "standing-revoked" }
  | { kind: "standing-recovery"; input: StandingRunInput; message: string }
  | { kind: "declined" }
  | { kind: "change"; card: ApprovalCard; scenario: DealScenario }
  | { kind: "approval-recovery"; card: ApprovalCard; message: string }
  | { kind: "error"; message: string };

interface Status {
  fixtureMode: boolean;
  modelCompiler: "available" | "not_configured";
  heroMode: boolean;
  browserOnly?: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function isAmbiguousApprovalError(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500;
}

export async function attemptApprovalWithRecovery<T>(
  attempt: () => Promise<T>,
  onRecoveryAttempt: () => void,
): Promise<{ status: "confirmed"; value: T } | { status: "ambiguous" }> {
  try {
    return { status: "confirmed", value: await attempt() };
  } catch (error) {
    if (!isAmbiguousApprovalError(error)) throw error;
    onRecoveryAttempt();
  }

  try {
    return { status: "confirmed", value: await attempt() };
  } catch (error) {
    if (!isAmbiguousApprovalError(error)) throw error;
    return { status: "ambiguous" };
  }
}

export function attemptStandingRunWithRecovery(
  input: StandingRunInput,
  request: (input: StandingRunInput) => Promise<StandingRunResponse>,
  onRecoveryAttempt: () => void,
) {
  return attemptApprovalWithRecovery(() => request(input), onRecoveryAttempt);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await demoBackend.request<T & {
    error?: { code: string; message: string };
  }>(path, init);
  if (response.status === 204) return undefined as T;
  const body = response.body;
  if (response.status < 200 || response.status >= 300) {
    throw new ApiError(
      body.error?.message ?? "Bander could not continue",
      response.status,
      body.error?.code,
    );
  }
  return body as T;
}

function Brand() {
  return (
    <a className="brand" href={import.meta.env.BASE_URL} aria-label="Bander home">
      <img src={`${import.meta.env.BASE_URL}bander_mark_transparent.svg`} alt="" />
      <span>Bander</span>
    </a>
  );
}

const browserSandboxNotice = "This is a deterministic sandbox using seeded data, running entirely in your browser. It cannot touch Google, Gmail, Telegram, OpenAI, OpenClaw, or your accounts. It uses the same Bander authority engine and Card rendering as the real product.";
const localSandboxNotice = "Deterministic sandbox — uses seeded data through a local Bander demo service. It does not connect to Google, Gmail, Telegram, OpenAI, OpenClaw, or your accounts.";
const uncertaintySandboxPreface = "The Calendar provider’s response will be deliberately lost after approval, so Bander must report only what it can prove.";
const realServicesEvidenceUrl = "https://github.com/gowtham0992/bander#real-services-and-evidence";

function RealServicesLink({ label = "See how this works with real services →" }: { label?: string }) {
  return <a className="real-services-link" href={realServicesEvidenceUrl} target="_blank" rel="noreferrer">{label}</a>;
}

function SandboxNotice({ browserOnly }: { browserOnly: boolean }) {
  return <p className="sandbox-notice">{browserOnly ? browserSandboxNotice : localSandboxNotice}</p>;
}

function R1SandboxNotice() {
  return (
    <p className="r1-sandbox-notice">
      Seeded browser data <span aria-hidden="true">·</span> Cannot touch real accounts or services <span aria-hidden="true">·</span> Same Bander authority engine and Card rendering
    </p>
  );
}

function ScheduleReadView({ result, onBack }: { result: ScheduleReadResult; onBack: () => void }) {
  const localTime = (value: string) => {
    const [hours = "0", minutes = "00"] = value.split(":");
    const hour = Number(hours);
    return `${hour % 12 || 12}:${minutes} ${hour < 12 ? "AM" : "PM"}`;
  };
  return (
    <main className="result-shell read-result" aria-live="polite">
      <span className="deal-kicker">Assistant answer · seeded schedule</span>
      <h1>Here’s tomorrow.</h1>
      {result.events.length === 0 ? <p>You don’t have anything scheduled tomorrow.</p> : (
        <ul>{result.events.map((event, index) => (
          <li key={`${event.title}-${index}`}><strong>“{event.title}”</strong>{event.allDay ? " · All day" : ` · ${localTime(event.start.localTime)}–${localTime(event.end.localTime)}`}</li>
        ))}</ul>
      )}
      <p className="zero-authority-note">No Bander Card appeared. Nothing was approved or changed.</p>
      <button className="secondary" onClick={onBack}>Back to the sandbox</button>
      <RealServicesLink />
    </main>
  );
}

function InboxReadView({ messages, onBack }: { messages: DemoSandboxState["inbox"]; onBack: () => void }) {
  return (
    <main className="result-shell read-result" aria-live="polite">
      <span className="deal-kicker">Assistant answer · seeded inbox</span>
      <h1>Here’s the matching email.</h1>
      {messages.map((message) => (
        <article className="seeded-email" key={`${message.receivedAt}-${message.subject}`}>
          <QuotedData source="Email sender">{message.sender}</QuotedData>
          <h2>{message.subject}</h2><p>{message.excerpt}</p>
        </article>
      ))}
      <p className="zero-authority-note">No Bander Card appeared. Nothing was approved or sent.</p>
      <button className="secondary" onClick={onBack}>Back to the sandbox</button>
      <RealServicesLink />
    </main>
  );
}

function FamilyPhone({ state }: { state: DemoSandboxState }) {
  return (
    <aside className="sandbox-phone" aria-label="Gil’s phone sandbox">
      <span>Gil’s phone — sandbox</span>
      {state.familyUpdates.length === 0 ? <p>No family update sent.</p> : state.familyUpdates.map((update) => (
        <article key={`${update.sentAt}-${update.body}`}><strong>Bander</strong><pre>{update.body}</pre></article>
      ))}
    </aside>
  );
}

function CompoundResult({ screen, onReplay, onBack }: { screen: Extract<Screen, { kind: "compound-receipt" }>; onReplay: () => void; onBack: () => void }) {
  const outcome = screen.receipt.emailReply
    ? `The exact approved reply was accepted for ${screen.receipt.emailReply.recipient}.`
    : screen.receipt.familyNotification && !screen.receipt.calendar
      ? `The exact approved message was accepted for ${screen.receipt.familyNotification.recipientDisplayName}.`
      : screen.receipt.calendar && "created" in screen.receipt.calendar
        ? `“${screen.receipt.calendar.title}” was added for the approved interval.`
        : screen.receipt.calendar && "removed" in screen.receipt.calendar
          ? `“${screen.receipt.calendar.title}” was removed from the seeded Calendar.`
          : screen.receipt.calendar
            ? `“${screen.receipt.calendar.title}” moved to the approved interval.`
            : "The exact approved action completed.";
  return (
    <main className="compound-result" aria-live="polite">
      <section className="result-shell"><div className="result-mark">✓</div><h1>Done exactly as approved.</h1><p>{outcome}</p>{screen.receipt.familyNotification && <p>Bander sent the exact approved update to Gil.</p>}<button className="secondary" onClick={onReplay}>{screen.replayed ? "Replay changed nothing" : "Replay the same approval"}</button><button className="quiet" onClick={onBack}>Back to the sandbox</button><RealServicesLink /></section>
      {screen.receipt.emailReply ? (
        <aside className="sandbox-phone" aria-label="Seeded Sent mail"><span>Sent mail — sandbox</span>{screen.state.sentEmails.map((email) => <article key={`${email.sentAt}-${email.subject}`}><strong>To {email.recipient}</strong><pre>{email.body}</pre></article>)}</aside>
      ) : <FamilyPhone state={screen.state} />}
    </main>
  );
}

function AmbiguousOutcome({ screen, onReplay, onBack }: { screen: Extract<Screen, { kind: "ambiguous-outcome" }>; onReplay: () => void; onBack: () => void }) {
  const emailOnly = screen.card.effectPreviews.some((effect) => effect.kind === "email.reply");
  const hasFamily = screen.card.effectPreviews.some((effect) => effect.kind === "family.telegram_notification");
  return (
    <main className="compound-result" aria-live="polite">
      <section className="result-shell uncertain-result"><span className="deal-kicker">Deliberately simulated lost response</span><h1>{emailOnly ? "Email result unknown." : "Calendar result unknown."}</h1><p className="preserve-lines">{screen.message}</p><p>The sandbox deliberately makes the external result unknowable.</p><button className="secondary" onClick={onReplay}>Replay safely</button><button className="quiet" onClick={onBack}>Back to the sandbox</button><RealServicesLink /></section>
      {emailOnly ? (
        <aside className="sandbox-phone" aria-label="Seeded Sent mail"><span>Sent mail — sandbox</span>{screen.state.sentEmails.length === 0 ? <p>No confirmed reply appears.</p> : screen.state.sentEmails.map((email) => <article key={`${email.sentAt}-${email.subject}`}><strong>To {email.recipient}</strong><pre>{email.body}</pre></article>)}</aside>
      ) : hasFamily ? <FamilyPhone state={screen.state} /> : null}
    </main>
  );
}

function heroInterval(
  startTime: string,
  endTime: string,
  timeZone: string,
): { day: string; time: string } {
  const start = new Date(startTime);
  const end = new Date(endTime);
  const day = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone,
  }).format(start);
  const time = formatReceiptInterval({ startTime, endTime }, timeZone);
  return { day, time };
}

export function HeroSandbox() {
  const [state, setState] = useState<DemoSandboxState | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let stopped = false;
    let timeout: number | undefined;
    const refresh = async () => {
      try {
        const next = await api<DemoSandboxState>("/api/hero/state", {
          cache: "no-store",
        });
        if (stopped) return;
        setState(next);
        setError(false);
      } catch {
        if (!stopped) setError(true);
      } finally {
        if (!stopped) timeout = window.setTimeout(refresh, 600);
      }
    };
    void refresh();
    return () => {
      stopped = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [retry]);

  return (
    <main className="hero-sandbox">
      <section className="hero-intro">
        <div>
          <span className="hero-kicker">Live household sandbox</span>
          <h1>What happened,<br />at a glance.</h1>
        </div>
        <div className="hero-live" aria-label="Live demo data">
          <span aria-hidden="true" /> Live
        </div>
      </section>

      {error && !state && (
        <section className="hero-load-error" role="alert">
          <h2>The household view is reconnecting.</h2>
          <p>Telegram and Bander can keep working while this view catches up.</p>
          <button className="secondary" onClick={() => setRetry((value) => value + 1)}>
            Try again
          </button>
        </section>
      )}

      {!state && !error && (
        <section className="hero-loading" aria-live="polite">
          <div className="loader" />
          <p>Opening your demo household…</p>
        </section>
      )}

      {state && (
        <div className="hero-ledger" aria-live="polite">
          <section className="hero-panel calendar-panel">
            <header>
              <span className="hero-panel-icon calendar-icon" aria-hidden="true">CAL</span>
              <div>
                <p>Demo Calendar</p>
                <h2>Schedule</h2>
              </div>
            </header>
            <div className="calendar-list">
              {state.calendar.map((event) => {
                const interval = heroInterval(
                  event.startTime,
                  event.endTime,
                  event.timeZone,
                );
                return (
                  <article className="calendar-event" key={`${event.title}-${event.startTime}`}>
                    <div className="event-time">
                      <strong>{interval.time.split("–")[0]}</strong>
                      <span>{interval.day}</span>
                    </div>
                    <div className="event-rule" aria-hidden="true" />
                    <div>
                      <h3>{event.title}</h3>
                      <p>{interval.time}</p>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="hero-panel messages-panel">
            <header>
              <span className="hero-panel-icon message-icon" aria-hidden="true">•••</span>
              <div>
                <p>Demo Messages</p>
                <h2>Sent</h2>
              </div>
            </header>
            {state.messages.length === 0 ? (
              <div className="messages-empty">
                <span aria-hidden="true">✓</span>
                <h3>No messages sent</h3>
                <p>Approved messages will appear here.</p>
              </div>
            ) : (
              <div className="message-list">
                {state.messages.map((message) => (
                  <article className="message-item" key={`${message.sentAt}-${message.body}`}>
                    <div className="message-avatar" aria-hidden="true">
                      {message.recipientDisplayName.charAt(0)}
                    </div>
                    <div>
                      <p>To {message.recipientDisplayName}</p>
                      <blockquote>{message.body}</blockquote>
                    </div>
                    <time dateTime={message.sentAt}>
                      {new Intl.DateTimeFormat("en-US", {
                        hour: "numeric",
                        minute: "2-digit",
                      }).format(new Date(message.sentAt))}
                    </time>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
      <p className="hero-footnote">A read-only view of Bander’s demo household</p>
    </main>
  );
}

type GuidedStage =
  | "ready"
  | "read"
  | "email-card"
  | "email-sent"
  | "calendar-card"
  | "complete";

function GuidedEpisode() {
  const [stage, setStage] = useState<GuidedStage>("ready");
  const [card, setCard] = useState<ApprovalCard | null>(null);
  const [state, setState] = useState<DemoSandboxState | null>(null);
  const [busy, setBusy] = useState(false);
  const [replayed, setReplayed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshState = async () => {
    const next = await api<DemoSandboxState>("/api/demo/state");
    setState(next);
    return next;
  };

  const begin = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/demo/reset", { method: "POST" });
      await api("/api/demo/inbox/guided");
      await refreshState();
      setStage("read");
    } catch {
      setError("This demo step reset itself. Tap Start again — nothing was sent or changed.");
    } finally { setBusy(false); }
  };

  const prepare = async (fixtureId: string, nextStage: "email-card" | "calendar-card") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const nextCard = await api<ApprovalCard>("/api/demo/proposals", {
        method: "POST",
        body: JSON.stringify({ fixtureId }),
      });
      setCard(nextCard);
      setStage(nextStage);
    } catch {
      setError("This demo step reset itself. Tap Start again — nothing was sent or changed.");
    } finally { setBusy(false); }
  };

  const approveGuided = async (nextStage: "email-sent" | "complete") => {
    if (!card || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api<HumanReceipt>(`/api/drafts/${card.draftId}/approve`, {
        method: "POST",
        body: JSON.stringify({ draftHash: card.draftHash }),
      });
      await refreshState();
      setStage(nextStage);
      setReplayed(false);
    } catch {
      setError("Bander couldn’t complete this seeded step. Nothing will be retried automatically.");
    } finally { setBusy(false); }
  };

  const replay = async () => {
    if (!card || busy) return;
    setBusy(true);
    try {
      await api<HumanReceipt>(`/api/drafts/${card.draftId}/approve`, {
        method: "POST",
        body: JSON.stringify({ draftHash: card.draftHash }),
      });
      await refreshState();
      setReplayed(true);
    } finally { setBusy(false); }
  };

  const latestInbox = state?.inbox.find((message) => message.subject === "Appointment options");
  const guidedCalendar = state?.calendar.find((event) => event.title === "Appointment with Dr. Rao");
  return (
    <section className="guided-episode" aria-labelledby="guided-title">
      <header className="guided-heading">
        <div><span className="eyebrow">A family coordination episode</span><h2 id="guided-title">See the rule hold across a whole task.</h2></div>
        <p>Advance each step yourself. Reads flow freely; every real change waits for its own exact deal.</p>
      </header>
      <div className="household-grid">
        <section className="conversation-pane" aria-label="Assistant conversation and Bander approval">
          <span className="surface-label">CONVERSATION + APPROVAL</span>
          <div className="conversation-flow">
            <p className="parent-bubble">What did Dr. Rao’s office say?</p>
            {stage === "ready" ? (
              <button className="primary" onClick={begin} disabled={busy}>{busy ? "Opening…" : "Ask without approval"}</button>
            ) : (
              <p className="assistant-bubble">Dr. Rao’s office says Thursday at 2 PM is available and asks whether that works for you.</p>
            )}
            {stage === "read" && <><p className="parent-bubble">Reply that Thursday at 2 works.</p><button className="primary" onClick={() => prepare("reply-to-dr-rao-about-thursday", "email-card")} disabled={busy}>Prepare the exact reply</button></>}
            {stage === "email-card" && card && <DealCard card={card} embedded busy={busy} onApprove={() => approveGuided("email-sent")} onDecline={() => setStage("read")} onChange={() => setStage("read")} />}
            {stage === "email-sent" && <><p className="bander-bubble"><strong>Email sent ✓</strong><br />The exact approved reply is in seeded Sent Mail.</p><p className="parent-bubble">Add Dr. Rao’s appointment Thursday at 2 PM and let Gil know.</p><button className="primary" onClick={() => prepare("add-dr-rao-appointment-and-notify-gil", "calendar-card")} disabled={busy}>Prepare the calendar + family deal</button></>}
            {stage === "calendar-card" && card && <DealCard card={card} embedded busy={busy} onApprove={() => approveGuided("complete")} onDecline={() => setStage("email-sent")} onChange={() => setStage("email-sent")} />}
            {stage === "complete" && <><p className="bander-bubble"><strong>Done exactly as approved ✓</strong><br />The seeded Calendar and Gil’s phone now show only the approved effects.</p><button className="secondary" onClick={replay} disabled={busy}>{replayed ? "Replay changed nothing" : "Replay the same approval"}</button></>}
            {error && <p className="guided-error" role="alert">{error}</p>}
          </div>
        </section>
        <section className="external-pane inbox-pane" aria-label="Seeded inbox and Sent Mail">
          <span className="surface-label">{stage === "ready" || stage === "read" || stage === "email-card" ? "SEEDED INBOX" : "SENT MAIL — SANDBOX"}</span>
          {stage === "ready" ? <p className="surface-empty">Ask about the fictional email to begin.</p> : stage === "read" || stage === "email-card" ? <article><strong>{latestInbox?.sender ?? "Dr. Rao’s office"}</strong><h3>{latestInbox?.subject ?? "Appointment options"}</h3><p>{latestInbox?.excerpt}</p></article> : <>{state?.sentEmails.filter((email) => email.subject === "Re: Appointment options").map((email) => <article key={email.sentAt}><strong>To {email.recipient}</strong><h3>{email.subject}</h3><p>{email.body}</p></article>)}</>}
        </section>
        <section className="external-pane calendar-pane-public" aria-label="Seeded Calendar">
          <span className="surface-label">CALENDAR — SANDBOX</span>
          {guidedCalendar ? <article><strong>THU · 2:00 PM</strong><h3>{guidedCalendar.title}</h3><p>2:00–3:00 PM MDT</p></article> : <p className="surface-empty">No Dr. Rao appointment yet.</p>}
        </section>
        <section className="external-pane phone-pane" aria-label="Gil’s seeded phone">
          <span className="surface-label">GIL’S PHONE — SANDBOX</span>
          {state?.familyUpdates.length ? state.familyUpdates.map((update) => <article key={update.sentAt}><strong>Bander</strong><pre>{update.body}</pre></article>) : <p className="surface-empty">No family update sent.</p>}
        </section>
      </div>
      {stage === "complete" && (
        <aside className="evidence-strip">
          <strong>The real Bander has done this with real services.</strong>
          <span>A real OpenClaw conversation, Google Calendar, Gmail, and a separate Telegram phone—while OpenClaw held none of those credentials.</span>
          <RealServicesLink label="See how this works for real →" />
        </aside>
      )}
    </section>
  );
}

function WorldObject({
  kind,
  title,
  detail,
  active = false,
  unconfirmed = false,
  message,
  onOpen,
  openLabel,
}: {
  kind: "calendar" | "inbox" | "phone";
  title: string;
  detail: string;
  active?: boolean;
  unconfirmed?: boolean;
  message?: string;
  onOpen: () => void;
  openLabel: string;
}) {
  return (
    <button className="world-object" type="button" onClick={onOpen} data-active={active || undefined} data-unconfirmed={unconfirmed || undefined} aria-label={openLabel}>
      <span className="world-glyph"><WorldGlyph kind={kind} /></span>
      <span className="world-copy"><strong>{title}</strong><small>{detail}</small></span>
      {message && <pre className="world-message">{message}</pre>}
      <span className="world-seeded">SANDBOX</span>
    </button>
  );
}

type FamilyThreadDeal = "email" | "compound" | "conflict" | "uncertainty";

function FamilyThread() {
  const [flow, dispatch] = useReducer(reduceFamilyThread, initialFamilyThreadState);
  const [surface, surfaceDispatch] = useReducer(reduceProductSurface, initialProductSurfaceState);
  const [card, setCard] = useState<ApprovalCard | null>(null);
  const [state, setState] = useState<DemoSandboxState | null>(null);
  const [ambiguousMessage, setAmbiguousMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const emailSuggestionRef = useRef<HTMLButtonElement>(null);
  const compoundSuggestionRef = useRef<HTMLButtonElement>(null);
  const conflictOfferRef = useRef<HTMLButtonElement>(null);
  const uncertaintyOfferRef = useRef<HTMLButtonElement>(null);
  const outcomeRef = useRef<HTMLElement>(null);
  const evidenceReturnFocusRef = useRef<HTMLElement | null>(null);
  const approvalInFlight = useRef(false);
  const presentationTimer = useRef<number | undefined>(undefined);

  const waitingDeal: FamilyThreadDeal | null = flow.stage === "email_waiting"
    ? "email"
    : flow.stage === "compound_waiting"
      ? "compound"
      : flow.stage === "conflict_waiting"
        ? "conflict"
        : flow.stage === "uncertainty_waiting"
          ? "uncertainty"
          : null;
  const cardActive = waitingDeal !== null;
  const emailConfirmed = !["idle", "asking", "read", "email_preparing", "email_waiting", "email_declined"].includes(flow.stage);
  const worldPresentation = familyThreadWorldPresentation(flow.stage);
  const compoundCalendarCrossed = worldPresentation.calendar === "confirmed";
  const compoundPhoneCrossed = worldPresentation.phone === "confirmed";
  const held = flow.stage === "uncertainty_held";
  const closing = flow.stage === "closing";
  const surfaceOpen = surface.proof !== "closed" || surface.setupStation !== null || surface.worldSheet !== null || surface.evidenceImage !== null;
  const familyUpdate = state?.familyUpdates[0];
  const drRaoEvent = state?.calendar.find((event) => event.title === "Appointment with Dr. Rao");
  const latestInbox = state?.inbox.find((message) => message.subject === "Appointment options");

  const lineState = held
    ? "held"
    : flow.stage === "conflict_returned"
      ? "returned"
      : ["email_preparing", "email_waiting", "compound_preparing", "compound_waiting", "conflict_preparing", "conflict_waiting", "uncertainty_preparing", "uncertainty_waiting"].includes(flow.stage)
        ? "waiting"
        : ["email_confirmed", "compound_calendar_crossed", "compound_confirmed"].includes(flow.stage)
          ? "crossed"
          : "idle";

  useEffect(() => () => {
    if (presentationTimer.current !== undefined) window.clearTimeout(presentationTimer.current);
  }, []);

  useEffect(() => {
    if (cardActive) {
      dialogRef.current?.querySelector<HTMLButtonElement>("button.primary")?.focus();
      return;
    }
    if (flow.stage === "email_declined") emailSuggestionRef.current?.focus();
    else if (flow.stage === "compound_declined") compoundSuggestionRef.current?.focus();
    else if (flow.stage === "email_confirmed" || flow.stage === "compound_confirmed" || flow.stage === "conflict_returned" || flow.stage === "uncertainty_held") {
      outcomeRef.current?.focus();
      if (window.matchMedia("(max-width: 640px)").matches) {
        outcomeRef.current?.scrollIntoView({ block: flow.stage === "compound_confirmed" ? "start" : "center", behavior: "auto" });
        if (flow.stage === "compound_confirmed") window.scrollBy({ top: 80, behavior: "auto" });
      }
    }
    else if (flow.stage === "closing") {
      const heading = document.getElementById("closing-title");
      heading?.focus();
      heading?.scrollIntoView({ block: "start", behavior: "auto" });
    }
  }, [cardActive, flow.stage]);

  const refreshState = async () => {
    const next = await api<DemoSandboxState>("/api/demo/state");
    setState(next);
    return next;
  };

  const ask = async () => {
    if (busy || flow.stage !== "idle") return;
    dispatch({ type: "ask" });
    setBusy(true);
    setError(null);
    try {
      await api("/api/demo/reset", { method: "POST" });
      await api("/api/demo/inbox/guided");
      await refreshState();
      dispatch({ type: "read_completed" });
    } catch {
      setError("The seeded conversation could not open. Nothing was sent or changed.");
      dispatch({ type: "ask_failed" });
    } finally { setBusy(false); }
  };

  const prepareDeal = async (deal: FamilyThreadDeal) => {
    if (busy) return;
    const canPrepare = (deal === "email" && (flow.stage === "read" || flow.stage === "email_declined"))
      || (deal === "compound" && (flow.stage === "email_confirmed" || flow.stage === "compound_declined"))
      || (deal === "conflict" && flow.stage === "compound_confirmed")
      || (deal === "uncertainty" && flow.stage === "conflict_returned");
    if (!canPrepare) return;
    if (deal === "email") dispatch({ type: "prepare_email" });
    if (deal === "compound") dispatch({ type: "prepare_compound" });
    if (deal === "conflict") {
      dispatch({ type: "offer_conflict" });
      dispatch({ type: "prepare_conflict" });
    }
    if (deal === "uncertainty") {
      dispatch({ type: "offer_uncertainty" });
      dispatch({ type: "prepare_uncertainty" });
    }
    setBusy(true);
    setError(null);
    try {
      if (deal === "conflict" || deal === "uncertainty") {
        await api("/api/demo/reset", { method: "POST" });
        await refreshState();
      }
      const fixtureId = deal === "email"
        ? "reply-to-dr-rao-about-thursday"
        : deal === "compound"
          ? "add-dr-rao-appointment-and-notify-gil"
          : deal === "conflict"
            ? "cancel-dentist-and-notify-gil"
            : "move-demo-appointment-and-notify-gil";
      const [nextCard] = await Promise.all([
        api<ApprovalCard>("/api/demo/proposals", { method: "POST", body: JSON.stringify({ fixtureId }) }),
        new Promise((resolve) => window.setTimeout(resolve, 190)),
      ]);
      setCard(nextCard);
      if (deal === "email") dispatch({ type: "email_card_ready" });
      if (deal === "compound") dispatch({ type: "compound_card_ready" });
      if (deal === "conflict") dispatch({ type: "conflict_card_ready" });
      if (deal === "uncertainty") dispatch({ type: "uncertainty_card_ready" });
    } catch {
      setError("Bander couldn’t prepare the seeded deal. Nothing was sent or changed.");
      if (deal === "email") dispatch({ type: "email_prepare_failed" });
      if (deal === "compound") dispatch({ type: "compound_prepare_failed" });
      if (deal === "conflict") dispatch({ type: "conflict_prepare_failed" });
      if (deal === "uncertainty") dispatch({ type: "uncertainty_prepare_failed" });
    } finally { setBusy(false); }
  };

  const approve = async () => {
    if (!card || !waitingDeal || busy || approvalInFlight.current) return;
    approvalInFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      if (waitingDeal === "conflict") {
        try {
          await api(`/api/demo/drafts/${card.draftId}/approve-after-cancel-calendar-change`, { method: "POST", body: JSON.stringify({ draftHash: card.draftHash }) });
          throw new Error("The changed-world sandbox did not refuse the stale deal");
        } catch (failure) {
          if (!(failure instanceof ApiError) || failure.code !== "conflict") throw failure;
        }
        await refreshState();
        dispatch({ type: "conflict_returned" });
        return;
      }
      if (waitingDeal === "uncertainty") {
        const result = await api<{ status: string; message: string }>(`/api/demo/drafts/${card.draftId}/approve-ambiguous`, { method: "POST", body: JSON.stringify({ draftHash: card.draftHash }) });
        if (result.status !== "calendar_outcome_ambiguous") throw new Error("The uncertainty sandbox returned an unexpected result");
        setAmbiguousMessage(result.message);
        await refreshState();
        dispatch({ type: "uncertainty_held" });
        return;
      }
      await api<HumanReceipt>(`/api/drafts/${card.draftId}/approve`, { method: "POST", body: JSON.stringify({ draftHash: card.draftHash }) });
      await refreshState();
      if (waitingDeal === "email") dispatch({ type: "email_approved" });
      else {
        dispatch({ type: "compound_backend_confirmed" });
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        presentationTimer.current = window.setTimeout(() => {
          dispatch({ type: "compound_phone_presented" });
          presentationTimer.current = undefined;
        }, reducedMotion ? 0 : R2_PRESENTATION_BEAT_MS);
      }
    } catch {
      setError("Bander couldn’t confirm the seeded result. It will not retry automatically.");
    } finally {
      approvalInFlight.current = false;
      setBusy(false);
    }
  };

  const decline = async () => {
    if (!card || !waitingDeal || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/drafts/${card.draftId}/decline`, { method: "POST" });
      if (waitingDeal === "email") dispatch({ type: "email_declined" });
      if (waitingDeal === "compound") dispatch({ type: "compound_declined" });
      if (waitingDeal === "conflict") dispatch({ type: "conflict_declined" });
      if (waitingDeal === "uncertainty") dispatch({ type: "uncertainty_declined" });
      await refreshState();
    } catch {
      setError("Bander couldn’t close the seeded deal. Nothing was sent or changed.");
    } finally { setBusy(false); }
  };

  const resetEpisode = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api("/api/demo/reset", { method: "POST" });
      setState(null);
      setCard(null);
      setAmbiguousMessage("");
      setError(null);
      dispatch({ type: "reset" });
    } finally { setBusy(false); }
  };

  const trapDialogFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !dialogRef.current) return;
    const controls = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), [href], [tabindex]:not([tabindex='-1'])")];
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };

  const showEmailSuggestion = flow.stage === "read" || flow.stage === "email_preparing" || flow.stage === "email_waiting" || flow.stage === "email_declined";
  const showEmailOutcome = ["email_confirmed", "compound_preparing", "compound_waiting", "compound_declined"].includes(flow.stage);
  const showCompoundRequest = ["compound_preparing", "compound_waiting", "compound_calendar_crossed", "compound_confirmed"].includes(flow.stage);
  const showCompoundOutcome = flow.stage === "compound_confirmed";
  const showConflictRequest = ["conflict_offered", "conflict_preparing", "conflict_waiting", "conflict_returned"].includes(flow.stage);
  const showUncertaintyRequest = ["uncertainty_offered", "uncertainty_preparing", "uncertainty_waiting", "uncertainty_held"].includes(flow.stage);

  const markers: Array<{ label: string; state: "waiting" | "crossed" | "returned" | "held"; className?: string }> = [];
  if (flow.stage === "email_preparing" || flow.stage === "email_waiting" || flow.stage === "email_confirmed") markers.push({ label: "EMAIL", state: flow.stage === "email_confirmed" ? "crossed" : "waiting" });
  if (["compound_preparing", "compound_waiting", "compound_calendar_crossed", "compound_confirmed"].includes(flow.stage)) {
    markers.push({ label: "CALENDAR", state: compoundCalendarCrossed ? "crossed" : "waiting", className: "marker-calendar" });
    markers.push({ label: "GIL", state: compoundPhoneCrossed ? "crossed" : "waiting", className: "marker-gil" });
  }
  if (flow.stage === "conflict_preparing" || flow.stage === "conflict_waiting" || flow.stage === "conflict_returned") markers.push({ label: "CALENDAR", state: flow.stage === "conflict_returned" ? "returned" : "waiting" });
  if (flow.stage === "uncertainty_preparing" || flow.stage === "uncertainty_waiting" || flow.stage === "uncertainty_held") markers.push({ label: "CALENDAR", state: held ? "held" : "waiting" });

  return (
    <main className={`family-thread-shell stage-${flow.stage}${cardActive ? " card-active" : ""}`}>
      <h1 className="visually-hidden">Bander family conversation sandbox</h1>
      <p className="family-whisper">The assistant you can hand to your parents.</p>
      {!closing && <div className="family-stage" inert={cardActive} aria-hidden={cardActive || surfaceOpen || undefined}>
        <div className="family-stage-surface-guard" inert={surfaceOpen || undefined}>
        <section className="family-conversation" aria-labelledby="family-thread-title">
          <header className="thread-heading"><span>FAMILY THREAD</span><h2 id="family-thread-title">Mum, your assistant, and Bander</h2></header>
          <div className="thread-log" role="log" aria-live="polite" aria-relevant="additions text">
            <article className="thread-message parent-message"><span className="speaker-label">Mum</span><p>What did Dr. Rao’s office say?</p></article>
            {flow.stage === "idle" || flow.stage === "asking" ? (
              <button className="thread-advance ask-advance" aria-label="Tap to ask — you drive everything here." onClick={ask} disabled={busy}><span aria-hidden="true">↗</span>{busy ? "Asking…" : "Tap to ask — you drive everything here."}</button>
            ) : (
              <><article className="thread-message assistant-message message-arrival"><span className="speaker-label">Your assistant</span><p>Dr. Rao’s office says Thursday at 2 PM is available and asks whether that works for you.</p></article><p className="read-rule"><span aria-hidden="true">○</span>Reading never crosses the line.</p></>
            )}

            {showEmailSuggestion && <button ref={emailSuggestionRef} className="thread-message parent-message suggested-message" onClick={() => prepareDeal("email")} disabled={busy || flow.stage === "email_waiting"}><span className="speaker-label">Tap Mum’s next message</span><span>{flow.stage === "email_preparing" ? "Preparing the exact deal…" : "Reply that Thursday at 2 works."}</span></button>}
            {flow.stage === "email_declined" && <article className="thread-message bander-message message-arrival"><span className="speaker-label">Bander</span><p><strong>Not now.</strong> Your calendar and messages were left exactly as they were.</p></article>}

            {showEmailOutcome && <article ref={flow.stage === "email_confirmed" ? outcomeRef as React.RefObject<HTMLElement> : undefined} tabIndex={flow.stage === "email_confirmed" ? -1 : undefined} className="thread-message bander-message authoritative-outcome message-arrival"><span className="speaker-label"><img src={`${import.meta.env.BASE_URL}bander_mark_transparent.svg`} alt="" />Bander</span><p><strong>Email sent ✓</strong><br /><span>The exact approved reply is in seeded Sent Mail. No one else was included.</span></p></article>}
            {(flow.stage === "email_confirmed" || flow.stage === "compound_declined") && <button ref={compoundSuggestionRef} className="thread-message parent-message suggested-message compound-suggestion" onClick={() => prepareDeal("compound")} disabled={busy}><span className="speaker-label">Tap Mum’s next message</span><span>Add it to my calendar and let Gil know.</span></button>}
            {flow.stage === "compound_declined" && <article className="thread-message bander-message message-arrival"><span className="speaker-label">Bander</span><p><strong>Not now.</strong> Nothing was added to the Calendar and no family update was sent.</p></article>}
            {showCompoundRequest && <article className="thread-message parent-message message-arrival"><span className="speaker-label">Mum</span><p>Add it to my calendar and let Gil know.</p></article>}
            {flow.stage === "compound_calendar_crossed" && <p className="crossing-beat" aria-live="polite"><span>Calendar confirmed</span><strong>Holding the exact family update for the same approved deal…</strong></p>}
            {showCompoundOutcome && <article ref={outcomeRef as React.RefObject<HTMLElement>} tabIndex={-1} className="thread-message bander-message authoritative-outcome thread-terminal message-arrival"><span className="speaker-label"><img src={`${import.meta.env.BASE_URL}bander_mark_transparent.svg`} alt="" />Bander</span><p><strong>Done exactly as approved ✓</strong><span>“Appointment with Dr. Rao” was added to the seeded Calendar.</span><span>Bander sent the exact approved update to Gil.</span></p></article>}
            {flow.stage === "compound_confirmed" && <button ref={conflictOfferRef} className="thread-advance episode-choice" onClick={() => prepareDeal("conflict")} disabled={busy}><span aria-hidden="true">↩</span>See what happens when the calendar changed first?</button>}

            {showConflictRequest && <article className="thread-message parent-message message-arrival"><span className="speaker-label">Mum</span><p>Show me what happens when the calendar changed first.</p></article>}
            {flow.stage === "conflict_returned" && <article ref={outcomeRef as React.RefObject<HTMLElement>} tabIndex={-1} className="thread-message bander-message thread-terminal returned-outcome message-arrival"><span className="speaker-label"><img src={`${import.meta.env.BASE_URL}bander_mark_transparent.svg`} alt="" />Bander</span><p><strong>I stopped—the calendar changed since this deal was prepared.</strong><span>Bander did not remove the event or send a family update.</span><span>Review the changed event before asking your assistant again.</span></p></article>}
            {flow.stage === "conflict_returned" && <button ref={uncertaintyOfferRef} className="thread-advance episode-choice" onClick={() => prepareDeal("uncertainty")} disabled={busy}><span aria-hidden="true">◇</span>See what Bander does when it can’t confirm?</button>}

            {showUncertaintyRequest && <article className="thread-message parent-message message-arrival"><span className="speaker-label">Mum</span><p>Show me what happens when the result can’t be confirmed.</p></article>}
            {held && <article ref={outcomeRef as React.RefObject<HTMLElement>} tabIndex={-1} className="thread-message bander-message thread-terminal held-outcome message-arrival"><span className="speaker-label"><img src={`${import.meta.env.BASE_URL}bander_mark_transparent.svg`} alt="" />Bander</span><p><strong>Calendar result unconfirmed.</strong><span className="preserve-lines">{ambiguousMessage}</span></p></article>}
            {held && <button className="thread-advance episode-choice completion-choice" onClick={() => dispatch({ type: "continue_to_closing" })} disabled={busy}>Continue exploring Bander</button>}
            {error && <p className="thread-error" role="alert">{error}</p>}
          </div>
        </section>

        <div className="line-zone">
          {markers.map((marker) => <span key={`${marker.label}-${marker.state}`} className={`deal-marker ${marker.className ?? ""}`} data-marker-state={marker.state} aria-label={`${marker.label} ${marker.state} at the Bander Line`}>{marker.label}</span>)}
          <div className="bander-line" data-line-state={lineState} role="img" aria-label={`Bander Line: ${lineState}`}>
            {lineState === "idle" ? <span className="line-seal" aria-hidden="true"><img src={`${import.meta.env.BASE_URL}bander_mark_transparent.svg`} alt="" /></span> : <span className="line-state-label">{lineState === "waiting" ? "WAITING FOR YOU" : lineState === "crossed" ? "APPROVED" : lineState === "returned" ? "RETURNED" : "UNCONFIRMED"}</span>}
          </div>
        </div>

        <aside className="world-dock" aria-label="Seeded outside world">
          <p className="world-heading">Beyond the Line</p>
          <WorldObject kind="calendar" title="Calendar" detail={compoundCalendarCrossed && drRaoEvent ? "Dr. Rao · Thu 2 PM" : held ? "Result unconfirmed" : "No Bander change"} active={compoundCalendarCrossed} unconfirmed={held} onOpen={() => surfaceDispatch({ type: "open_world", world: "calendar" })} openLabel="Open seeded Calendar details" />
          <WorldObject kind="inbox" title="Inbox" detail={emailConfirmed ? "Sent ✓" : latestInbox ? "1 message" : "Seeded mail"} active={emailConfirmed} onOpen={() => surfaceDispatch({ type: "open_world", world: "inbox" })} openLabel="Open seeded Sent Mail details" />
          <WorldObject kind="phone" title="Gil’s phone" detail={compoundPhoneCrossed ? "Update sent" : held ? "No update sent" : "Quiet"} active={compoundPhoneCrossed} {...(compoundPhoneCrossed && familyUpdate ? { message: familyUpdate.body } : {})} onOpen={() => surfaceDispatch({ type: "open_world", world: "phone" })} openLabel="Open seeded Gil update details" />
        </aside>

        {compoundPhoneCrossed && familyUpdate && <article className="mobile-phone-light" aria-label="Exact approved sandbox update sent to Gil"><span>Gil’s phone · sandbox</span><pre>{familyUpdate.body}</pre></article>}
        {flow.stage === "email_confirmed" && <article className="approved-deal-proof" aria-label="Approved Bander email deal"><img src={`${import.meta.env.BASE_URL}bander_mark_transparent.svg`} alt="" /><span><strong>Approved word-for-word</strong><small>Reply sent to Dr. Rao’s office</small></span></article>}
        {compoundPhoneCrossed && <article className="approved-deal-proof compound-proof" aria-label="One approved Bander deal with two confirmed effects"><img src={`${import.meta.env.BASE_URL}bander_mark_transparent.svg`} alt="" /><span><strong>One approved deal</strong><small>Calendar first · exact family update second</small></span></article>}
        </div>
      </div>}

      {closing && <ClosingPanel onOpenEvidence={(image) => {
        evidenceReturnFocusRef.current = document.activeElement as HTMLElement | null;
        surfaceDispatch({ type: "open_evidence", image });
      }} onReset={resetEpisode} surfaceOpen={surfaceOpen} />}

      {cardActive && card && <div className="deal-modal-backdrop"><div ref={dialogRef} className="deal-modal" role="dialog" aria-modal="true" aria-label={`Exact Bander ${waitingDeal} deal`} onKeyDown={trapDialogFocus}><DealCard card={card} embedded busy={busy} onApprove={approve} onDecline={decline} onChange={decline} showChange={false} /></div></div>}

      <section className="thread-continuation" aria-label="Explore Bander" inert={surfaceOpen || undefined}>
        <button className="proof-drawer-trigger" onClick={() => surfaceDispatch({ type: "open_proof" })}><span aria-hidden="true">27</span>All 27 verified outcomes <b aria-hidden="true">→</b></button>
        <ComparisonThread stage={surface.comparison} onOpen={() => surfaceDispatch({ type: "open_comparison" })} onNext={() => surfaceDispatch({ type: "next_comparison_beat" })} onFull={() => surfaceDispatch({ type: "open_full_comparison" })} />
        <SetupRail active={surface.setupStation} onOpen={(stationId) => surfaceDispatch({ type: "open_setup", stationId })} onClose={() => surfaceDispatch({ type: "close_setup" })} />
      </section>

      {surface.proof !== "closed" && <ProofDrawer mode={surface.proof === "comparison" ? "comparison" : "outcomes"} onClose={() => surfaceDispatch({ type: "close_proof" })} />}
      {surface.worldSheet && <WorldDetailSheet world={surface.worldSheet} calendarDetail={compoundCalendarCrossed && drRaoEvent ? `Appointment with Dr. Rao · Thu · ${formatReceiptInterval(drRaoEvent, drRaoEvent.timeZone)} MDT` : held ? "The provider result is unconfirmed" : "No Bander Calendar change"} inboxDetail={emailConfirmed ? "The exact approved reply is in seeded Sent Mail" : latestInbox ? "One seeded message from Dr. Rao’s office" : "No seeded message loaded"} phoneDetail={compoundPhoneCrossed ? "Exact approved update sent" : "No family update sent"} {...(compoundPhoneCrossed && familyUpdate ? { phoneMessage: familyUpdate.body } : {})} onClose={() => surfaceDispatch({ type: "close_world" })} />}
      {surface.evidenceImage && <EvidenceLightbox image={surface.evidenceImage} returnFocus={evidenceReturnFocusRef.current} onClose={() => surfaceDispatch({ type: "close_evidence" })} />}
    </main>
  );
}

const verifiedExamples = [
  { id: "schedule", label: "What’s on tomorrow?" },
  { id: "inbox", label: "What did the latest email say?" },
  { id: "exact", label: "Move an event" },
  { id: "conflict", label: "When the calendar changed first" },
  { id: "compound", label: "Move an event and tell Gil" },
  { id: "ambiguous", label: "When Bander isn’t sure" },
  { id: "create", label: "Add an event" },
  { id: "cancel", label: "Remove an event" },
  { id: "cancel-conflict", label: "Remove an event after it changed" },
  { id: "email", label: "Reply to an email" },
  { id: "email-thread", label: "When a new email arrived first" },
  { id: "email-ambiguous", label: "When an email result is uncertain" },
  { id: "direct-family", label: "Tell Gil something" },
  { id: "standing", label: "A routine with an off switch" },
] as const;

function HowBanderWorks() {
  const steps = [
    { image: "real-read-two-identities.png", title: "1 · Just ask", copy: "Your parent asks about their calendar or mail. Questions need no approval and create no Bander deal." },
    { image: "real-compound-family.png", title: "2 · One exact card", copy: "When something real should change, Bander shows exactly what will happen — the calendar change, the email reply, or the sentence Gil will receive." },
    { image: "real-changed-world.png", title: "3 · The truth, either way", copy: "One tap authorizes only that deal. Bander either completes it, refuses safely, or says it couldn’t confirm. Bander reports only what it can prove." },
  ];
  return (
    <section className="how-bander" aria-labelledby="how-bander-title">
      <div className="section-heading"><span className="eyebrow">How Bander works</span><h2 id="how-bander-title">Three moments. One calm rule.</h2></div>
      <div className="how-grid">{steps.map((step) => <article key={step.title}><img src={`${import.meta.env.BASE_URL}${step.image}`} alt="Real Bander Telegram evidence using fictional test data" /><h3>{step.title}</h3><p>{step.copy}</p></article>)}</div>
    </section>
  );
}

function OpenClawComparison() {
  const rows = [
    ["Who holds the Google and Gmail credentials?", "The configured tool or connector holds them within the agent’s execution environment.", "Bander’s separate process holds them; OpenClaw receives none of those credentials."],
    ["What does “yes” approve?", "The exact tool call and parameters held for approval.", "A stored deal plus the outside state it was based on; Bander checks that state again before execution."],
    ["Who reports the outcome?", "The tool result returns through the assistant’s conversation.", "Bander separately reports the observed result through its own Telegram identity."],
    ["What if the result cannot be confirmed?", "Behavior depends on the connector’s recovery and reporting policy.", "Bander records an unconfirmed outcome and never repeats a dispatched action automatically."],
    ["Who can receive a family message?", "The destinations granted to the agent’s configured messaging tools.", "One separately consented contact; its destination is bound outside the agent and the exact text requires approval."],
  ];
  return (
    <section className="comparison" aria-labelledby="comparison-title">
      <span className="eyebrow">A fair comparison</span><h2 id="comparison-title">Doesn’t OpenClaw already have approvals?</h2>
      <p>It does — and they’re good. Native approvals gate an exact tool call, and for an operator running their own agent, that is often enough.</p>
      <p>Bander exists for a different situation: giving a capable agent to someone who isn’t an operator.</p>
      <div className="comparison-table" role="table" aria-label="Native OpenClaw approvals compared with Bander">
        <div className="comparison-head" role="row"><strong role="columnheader">The question</strong><strong role="columnheader">Native OpenClaw approval</strong><strong role="columnheader">With Bander</strong></div>
        {rows.map(([question, native, bander]) => <div className="comparison-row" role="row" key={question}><strong role="rowheader">{question}</strong><span role="cell" data-label="Native OpenClaw approval">{native}</span><span role="cell" data-label="With Bander">{bander}</span></div>)}
      </div>
      <p className="comparison-proof">Everything in the Bander column is demonstrated on this page and backed by real Google, Gmail, and Telegram evidence in the <a href="https://github.com/gowtham0992/bander/blob/main/BUILD_WITH_CODEX.md" target="_blank" rel="noreferrer">ledger</a>.</p>
    </section>
  );
}

function TryBander() {
  const setupSteps = [
    ["Clone Bander", "Puts the public project on the setup computer.", "A computer with Node.js and Git.", "Expect a repository-local setup guide and verifier, not an installer.", "#1-prepare-the-setup-computer"],
    ["Create two Telegram bots", "Keeps the assistant and Bander visually and operationally distinct.", "Telegram and BotFather.", "Expect to configure two bots and verify privacy settings empirically.", "#2-create-two-visually-distinct-telegram-bots"],
    ["Connect a dedicated Google account", "Lets Bander hold narrowly scoped Calendar and Gmail credentials.", "A dedicated Google test account.", "Expect separate Desktop OAuth credentials and tokens for Calendar and Gmail.", "#4-configure-separate-narrow-google-desktop-oauth-clients"],
    ["Pair the parent’s private group", "Binds approvals to one parent and one protected Telegram group.", "The parent’s phone and protected group.", "Expect a one-time link and an empirical privacy check.", "#5-pair-the-parent-and-protected-group"],
    ["Invite one family member", "Connects one independently consenting person for exact approved updates.", "The family member’s own phone.", "Expect them to remain outside the protected group and consent privately.", "#6-optionally-connect-one-family-member"],
  ];
  return (
    <section className="try-bander" aria-labelledby="try-bander-title">
      <span className="eyebrow">Choose your path</span><h2 id="try-bander-title">Interested in trying Bander?</h2>
      <div className="try-routes"><a href={import.meta.env.BASE_URL}>Try the hosted browser sandbox</a><a href="https://github.com/gowtham0992/bander#zero-account-judge-path" target="_blank" rel="noreferrer">Clone and run the local sandbox</a><a href="https://github.com/gowtham0992/bander/blob/main/SETUP.md" target="_blank" rel="noreferrer">Set up the real parent-and-family product</a></div>
      <div className="setup-steps">{setupSteps.map(([title, accomplishes, service, expectation, anchor], index) => <details key={title}><summary><span aria-hidden="true">{index + 1}</span>{title}</summary><div><p><strong>What this does:</strong> {accomplishes}</p><p><strong>What it uses:</strong> {service}</p><p><strong>What to expect:</strong> {expectation}</p><a href={`https://github.com/gowtham0992/bander/blob/main/SETUP.md${anchor}`} target="_blank" rel="noreferrer">Full guide →</a></div></details>)}</div>
    </section>
  );
}

function Welcome({
  onStart,
  onSchedule,
  onCompile,
  status,
}: {
  onStart: (scenario: DealScenario) => void;
  onSchedule: () => void;
  onCompile: (request: string) => void;
  status: Status | null;
}) {
  const [compilerRequest, setCompilerRequest] = useState("");
  return (
    <main className="welcome">
      <div className="eyebrow">Bander · a confidence layer for personal AI</div>
      <h1>Ask freely.<br />Approve changes.</h1>
      <p className="lede">
        Your assistant can read your calendar and mail and talk like a person. Bander holds the keys—calendar changes, email replies, and family messages happen only as exact deals you approve, and Bander reports only what it can prove.
      </p>
      <HowBanderWorks />
      <div className="guided-invitation"><span className="eyebrow">Try the whole journey</span><h2>Now drive it yourself — one real-life episode, step by step.</h2><p>The doctor’s office emails; you reply, update the calendar, and Gil finds out. Nothing advances until you click.</p></div>
      <GuidedEpisode />
      <p className="episode-router">Bander can also stop when the world changed—or admit when a result cannot be confirmed. Explore those cases below.</p>
      <section className="more-behaviors" aria-labelledby="examples-title">
        <span className="eyebrow">ASK · CHANGE · UNCERTAIN</span><h2 id="examples-title">See more verified examples</h2>
      <section className="lane-grid" aria-label="Main sandbox journeys">
        <button className="lane-card read-lane" aria-label="Just ask" onClick={onSchedule}>
          <span>JUST ASK</span><strong>“What’s on tomorrow? What did Ruth say?”</strong><small>Harmless reading flows without an approval toll.</small>
        </button>
        <button className="lane-card compound-lane" aria-label="Approve a change" onClick={() => onStart("compound")}>
          <span>APPROVE A CHANGE</span><strong>“Answer the email, update the calendar, tell Gil.”</strong><small>Exact effects. One decision at a time.</small>
        </button>
        <button className="lane-card uncertain-lane" aria-label="When Bander isn’t sure" onClick={() => onStart("ambiguous")}>
          <span>WHEN BANDER ISN’T SURE</span><strong>See a truthful uncertain outcome.</strong><small>No reassuring guess. No blind retry.</small>
        </button>
      </section>
        <div className="behavior-grid">
          {verifiedExamples.map((example) => <a className="scenario-link" key={example.id} href={`?scenario=${example.id}`}>{example.label}</a>)}
        </div>
      </section>
      {status?.modelCompiler === "available" && (
        <form
          className="compiler-entry"
          onSubmit={(event) => {
            event.preventDefault();
            const request = compilerRequest.trim();
            if (request) onCompile(request);
          }}
        >
          <label htmlFor="compiler-request">Or use your own wording</label>
          <div>
            <input
              id="compiler-request"
              value={compilerRequest}
              onChange={(event) => setCompilerRequest(event.target.value)}
              placeholder="Move dinner with Sarah and let her know I’m running late"
              maxLength={1000}
            />
            <button className="secondary" type="submit">Prepare with GPT-5.6</button>
          </div>
        </form>
      )}
      <section className="identity-rule" aria-labelledby="identity-title">
        <div><span className="eyebrow">The trust boundary</span><h2 id="identity-title">Two names, one rule.</h2><p>Your assistant talks with you and never holds the downstream keys. Bander holds the keys and speaks when something real is about to change—to show the exact deal, or to report only what it can prove afterward.</p></div>
        <div className="trust-diagram" role="img" aria-label="You talk to your assistant. The assistant can ask Bander. Only Bander holds the keys to connected services.">
          <div><strong>You</strong><span>ask naturally</span></div><span aria-hidden="true">→</span><div><strong>Your assistant</strong><span>talks, never holds keys</span></div><span aria-hidden="true">→</span><div className="bander-node"><strong>Bander</strong><span>shows the exact deal</span></div><span aria-hidden="true">→</span><div><strong>Your services</strong><span>change only after approval</span></div>
        </div>
      </section>
      <OpenClawComparison />
      <TryBander />
      <footer className="public-footer">
        <strong>Set it up for someone you love.</strong>
        <p>The code, complete setup guide, architecture, evidence ledger, honest limitations, and MIT license are public.</p>
        <nav className="project-links" aria-label="Project resources">
          <a className="repository-link" href="https://github.com/gowtham0992/bander" target="_blank" rel="noreferrer">Repository</a>
          <a href="https://github.com/gowtham0992/bander/blob/main/SETUP.md" target="_blank" rel="noreferrer">Setup guide</a>
          <a href="https://github.com/gowtham0992/bander/blob/main/docs/architecture.md" target="_blank" rel="noreferrer">Architecture</a>
          <a href="https://github.com/gowtham0992/bander/blob/main/BUILD_WITH_CODEX.md" target="_blank" rel="noreferrer">Evidence</a>
          <a href="https://github.com/gowtham0992/bander/blob/main/README.md#security-boundary-and-limitations" target="_blank" rel="noreferrer">Limitations</a>
        </nav>
      </footer>
    </main>
  );
}

export function AgentClaim({ card }: { card: ApprovalCard }) {
  return (
    <div className="agent-claim">
      <span>{card.provenanceLabel}</span>
      <blockquote data-provenance="agent-claimed">
        <q className="quoted-data">{card.claimedUserRequest}</q>
      </blockquote>
    </div>
  );
}

export function QuotedData({
  source,
  children,
}: {
  source: string;
  children: string;
}) {
  return (
    <span className="data-quote" data-provenance={source}>
      <span className="data-source">{source}</span>
      <q className="quoted-data">{children}</q>
    </span>
  );
}

export function EffectAllowance({ preview }: { preview: ApprovalEffectPreview }) {
  if (preview.kind === "calendar.reschedule_event") {
    return (
      <span className="effect-copy">
        Reschedule Calendar event{" "}
        <QuotedData source="Calendar">{preview.eventTitle}</QuotedData>{" "}
        from {preview.previousInterval} to {preview.resultingInterval}
      </span>
    );
  }
  if (preview.kind === "family.telegram_notification") {
    return (
      <span className="effect-copy message-effect">
        <span>Send the exact family update to <QuotedData source="Family member">{preview.recipientDisplayName}</QuotedData></span>
        <QuotedData source="Exact update from Bander">{preview.body}</QuotedData>
      </span>
    );
  }
  if (preview.kind === "calendar.create_event") {
    return (
      <span className="effect-copy">
        Add Calendar event <QuotedData source="Calendar">{preview.eventTitle}</QuotedData>{" "}
        for {preview.resultingInterval}
      </span>
    );
  }
  if (preview.kind === "calendar.cancel_event") {
    return (
      <span className="effect-copy">
        Remove Calendar event <QuotedData source="Calendar">{preview.eventTitle}</QuotedData>{" "}
        at {preview.previousInterval}
      </span>
    );
  }
  if (preview.kind === "email.reply") {
    return (
      <span className="effect-copy message-effect">
        <span>Reply by email to <QuotedData source="Email recipient">{preview.recipient}</QuotedData></span>
        <span>Re: <QuotedData source="Email subject">{preview.subject}</QuotedData></span>
        <QuotedData source="Exact approved reply">{preview.body}</QuotedData>
      </span>
    );
  }
  return (
    <span className="effect-copy message-effect">
      <span>
        Send one message to{" "}
        <QuotedData source="Messages recipient">
          {preview.recipientDisplayName}
        </QuotedData>
      </span>
      <QuotedData source="Agent-proposed message body">{preview.body}</QuotedData>
    </span>
  );
}

function formatReceiptInterval(
  interval: { startTime: string; endTime: string },
  timeZone: string,
): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
  const start = formatter.format(new Date(interval.startTime));
  const end = formatter.format(new Date(interval.endTime));
  const startMeridiem = start.match(/ (AM|PM)$/)?.[1];
  const endMeridiem = end.match(/ (AM|PM)$/)?.[1];
  return `${startMeridiem === endMeridiem ? start.replace(/ (AM|PM)$/, "") : start}–${end}`;
}

function DealCard({
  card,
  onApprove,
  onDecline,
  onChange,
  busy,
  embedded = false,
  showChange = true,
}: {
  card: ApprovalCard;
  onApprove: () => void;
  onDecline: () => void;
  onChange: () => void;
  busy: boolean;
  embedded?: boolean;
  showChange?: boolean;
}) {
  const expiry = new Date(card.expiresAt);
  const creates = card.effectPreviews.some((preview) => preview.kind === "calendar.create_event");
  const cancels = card.effectPreviews.some((preview) => preview.kind === "calendar.cancel_event");
  const hasFamilyUpdate = card.effectPreviews.some((preview) => preview.kind === "family.telegram_notification");
  const repliesByEmail = card.effectPreviews.some((preview) => preview.kind === "email.reply");
  const directFamily = hasFamilyUpdate && !card.effectPreviews.some((preview) => preview.kind.startsWith("calendar."));
  const Shell = embedded ? "section" : "main";
  const Heading = embedded ? "h3" : "h1";
  return (
    <Shell className={`deal-shell${embedded ? " embedded-deal" : ""}`}>
      <div className="deal-heading">
        <span className="deal-kicker">Prepared for you</span>
        <Heading>Bander hasn’t done anything yet — please check:</Heading>
      </div>
      <article className="deal-card">
        <AgentClaim card={card} />

        <section className="allowance">
          <h2>If you say yes, Bander will check the latest information. If it still matches, Bander will:</h2>
          <ul>
            {card.effectPreviews.map((preview, index) => (
              <li key={`${preview.kind}-${index}`}>
                <span className="check" aria-hidden="true">✓</span>
                <EffectAllowance preview={preview} />
              </li>
            ))}
          </ul>
        </section>

        <div className="boundary-copy">
          {creates ? (
            <p>Only this goes on your calendar. No one is invited, nothing repeats, and nothing is booked anywhere.</p>
          ) : cancels ? (
            <><p>Bander will not automatically restore this event after you approve.</p><p><strong>Not included:</strong></p><p>This removes only the calendar event.</p>{hasFamilyUpdate ? <p>Only the exact family update shown above will be sent. Bander will not contact the clinic, business, or event organizer.</p> : <p>It does not contact anyone or cancel the appointment itself.</p>}</>
          ) : repliesByEmail ? (
            <p><strong>Not included:</strong> No one else, no attachment, no forwarding, and no reply-all.</p>
          ) : directFamily ? (
            <p><strong>Not included:</strong> No one else, no link, attachment, command, or extra action.</p>
          ) : (
            <p><strong>Not included:</strong> Any other calendar events or actions.</p>
          )}
          <p>Bander won’t do anything else in this seeded sandbox.</p>
        </div>

        <footer className="deal-meta">
          <div className="connections">
            {card.connections.map((connection) => (
               <span key={connection}>{connection === "Family Telegram" ? "Family update" : connection}</span>
            ))}
          </div>
          <time dateTime={card.expiresAt}>
            Expires at {expiry.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </time>
          {card.proposalActivity && (
            <span>
              {card.proposalActivity.count} of {card.proposalActivity.limit} requests in {card.proposalActivity.windowMinutes} minutes
            </span>
          )}
        </footer>

        <div className="actions">
          <button className="primary" onClick={onApprove} disabled={busy}>
             {busy ? "Completing…" : cancels ? "Remove this event" : "Do exactly this"}
          </button>
          {showChange && <button className="secondary" onClick={onChange} disabled={busy}>Change it</button>}
          <button className="quiet" onClick={onDecline} disabled={busy}>Not now</button>
        </div>
      </article>
    </Shell>
  );
}

function Receipt({
  receipt,
  onReset,
  onTryOutside,
  onRevoke,
}: {
  receipt: HumanReceipt;
  onReset: () => void;
  onTryOutside?: () => void;
  onRevoke?: () => void;
}) {
  if (!receipt.calendar) throw new Error("Sandbox Calendar receipt is missing");
  const created = "created" in receipt.calendar;
  const removed = "removed" in receipt.calendar;
  return (
    <main className="result-shell" aria-live="polite">
      <div className="result-mark" aria-hidden="true">✓</div>
      <span className="deal-kicker">Completed as agreed</span>
      <h1>{receipt.title}</h1>
      <p className="result-summary">
        <span>{created ? "Added Calendar event " : removed ? "Removed Calendar event " : "Rescheduled Calendar event "}</span>
        <QuotedData source="Calendar">{receipt.calendar.title}</QuotedData>
        <span>
          {"created" in receipt.calendar
            ? ` for ${formatReceiptInterval(receipt.calendar.completed, receipt.calendar.timeZone)}.`
            : "removed" in receipt.calendar
              ? ` at ${formatReceiptInterval(receipt.calendar.previous, receipt.calendar.timeZone)}.`
            : ` from ${formatReceiptInterval(receipt.calendar.previous, receipt.calendar.timeZone)} to ${formatReceiptInterval(receipt.calendar.completed, receipt.calendar.timeZone)}.`}
        </span>
      </p>
      <p className="result-detail">
        {receipt.message ? (
          <>
            <span>Sent the approved message to </span>
            <QuotedData source="Messages recipient">
              {receipt.message.recipientDisplayName}
            </QuotedData>
            <span className="receipt-message">
              <QuotedData source="Approved message body">{receipt.message.body}</QuotedData>
            </span>
          </>
        ) : (
          "No messages were sent."
        )}
      </p>
      <div className="result-actions">
        {onTryOutside && (
          <button className="primary" onClick={onTryOutside}>
            Try a request outside these limits
          </button>
        )}
        <button className="secondary" onClick={onReset}>Back to Bander</button>
        {onRevoke && (
          <button className="quiet" onClick={onRevoke}>Turn off automatic handling</button>
        )}
      </div>
    </main>
  );
}

function StandingCardView({
  card,
  onApprove,
  onDecline,
  busy,
}: {
  card: StandingBandCard;
  onApprove: () => void;
  onDecline: () => void;
  busy: boolean;
}) {
  return (
    <main className="deal-shell">
      <div className="deal-heading">
        <span className="deal-kicker">Automatic routine · sandbox</span>
        <h1>{card.title}</h1>
      </div>
      <article className="deal-card standing-card">
        <section className="standing-intro">
          <p>
            Let your agent reschedule your solo focus blocks without asking each time—inside these exact limits.
          </p>
        </section>
        <section className="allowance">
          <h2>This routine allows:</h2>
          <ul>
            {card.clauses.map((clause) => (
              <li key={clause}>
                <span className="check" aria-hidden="true">✓</span>
                <span>{clause}</span>
              </li>
            ))}
          </ul>
        </section>
        <div className="boundary-copy">
          Anything outside these clauses comes back to you as a one-time deal.
        </div>
        <div className="actions standing-actions">
          <button className="primary" onClick={onApprove} disabled={busy}>
            {busy ? "Turning it on…" : "Turn on automatic handling"}
          </button>
          <button className="quiet" onClick={onDecline} disabled={busy}>Not now</button>
        </div>
      </article>
    </main>
  );
}

export function StandingRecoveryView({
  busy,
  message,
  onCheck,
  onBack,
}: {
  busy: boolean;
  message: string;
  onCheck: () => void;
  onBack: () => void;
}) {
  return (
    <main className="result-shell" role="alert" aria-live="polite">
      <span className="deal-kicker">Result not confirmed</span>
      <h1>Let’s check what happened.</h1>
      <p className="result-summary">{message}</p>
      <div className="result-actions">
        <button className="primary" onClick={onCheck} disabled={busy}>
          {busy ? "Checking…" : "Check what happened"}
        </button>
        <button className="secondary" onClick={onBack}>Back to Bander</button>
      </div>
    </main>
  );
}

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "welcome" });
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const deepLinkStarted = useRef(false);
  const approvalInFlight = useRef(false);

  useEffect(() => {
    api<Status>("/api/status").then(setStatus).catch(() => setStatus(null));
    if (deepLinkStarted.current) return;
    deepLinkStarted.current = true;
    const scenario = new URLSearchParams(window.location.search).get("scenario");
    if (["exact", "conflict", "compound", "ambiguous", "create", "cancel", "cancel-conflict", "email", "email-thread", "email-ambiguous", "direct-family"].includes(scenario ?? "")) void start(scenario as DealScenario, true);
    if (scenario === "schedule") void readTomorrow();
    if (scenario === "inbox") void readInbox();
    if (scenario === "standing") void startStanding();
  }, []);

  async function start(scenario: DealScenario, initializingFromDeepLink = false) {
    setScreen({ kind: "loading", message: "Preparing the exact deal…" });
    try {
      await api("/api/demo/reset", { method: "POST" });
      const fixtureId = scenario === "create"
        ? "add-lunch-with-ruth-and-notify-gil"
        : scenario === "cancel" || scenario === "cancel-conflict"
          ? "cancel-dentist-and-notify-gil"
          : scenario === "email" || scenario === "email-thread" || scenario === "email-ambiguous"
            ? "reply-to-ruth-about-lunch"
            : scenario === "direct-family"
              ? "tell-gil-dinner-is-at-six"
          : scenario === "compound" || scenario === "ambiguous"
            ? "move-demo-appointment-and-notify-gil"
            : "move-dinner-and-notify-sarah";
      const card = await api<ApprovalCard>("/api/demo/proposals", {
        method: "POST",
        body: JSON.stringify({ fixtureId }),
      });
      setScreen({ kind: "card", card, scenario });
    } catch (error) {
      if (initializingFromDeepLink) setScreen({ kind: "initialization-failed" });
      else setScreen({ kind: "error", message: (error as Error).message });
    }
  }

  async function readTomorrow() {
    setScreen({ kind: "loading", message: "Reading the seeded schedule…" });
    try {
      const result = await api<ScheduleReadResult>("/api/demo/schedule/tomorrow");
      setScreen({ kind: "schedule-read", result });
    } catch (error) { setScreen({ kind: "error", message: (error as Error).message }); }
  }

  async function readInbox() {
    setScreen({ kind: "loading", message: "Reading the seeded inbox…" });
    try {
      const result = await api<{ messages: DemoSandboxState["inbox"] }>("/api/demo/inbox/important");
      setScreen({ kind: "inbox-read", messages: result.messages });
    } catch (error) { setScreen({ kind: "error", message: (error as Error).message }); }
  }

  async function startStanding() {
    setScreen({ kind: "loading", message: "Preparing a small, exact routine…" });
    try {
      await api("/api/demo/reset", { method: "POST" });
      const card = await api<StandingBandCard>("/api/demo/standing-band-candidates", {
        method: "POST",
      });
      setScreen({ kind: "standing-card", card });
    } catch (error) {
      setScreen({ kind: "error", message: (error as Error).message });
    }
  }

  async function compileRequest(request: string) {
    setScreen({ kind: "loading", message: "GPT-5.6 is preparing a bounded candidate…" });
    try {
      await api("/api/demo/reset", { method: "POST" });
      const card = await api<ApprovalCard>("/api/compiler/proposals", {
        method: "POST",
        body: JSON.stringify({ request }),
      });
      setScreen({ kind: "card", card, scenario: "exact" });
    } catch (error) {
      setScreen({ kind: "error", message: (error as Error).message });
    }
  }

  async function approveStanding(card: StandingBandCard) {
    setBusy(true);
    try {
      const authorization = await api<{ bandId: string }>(
        `/api/standing-band-candidates/${card.candidateId}/approve`,
        {
          method: "POST",
          body: JSON.stringify({ predicateHash: card.predicateHash }),
        },
      );
      await completeStandingRun({
        bandId: authorization.bandId,
        fixtureId: "move-my-focus-block",
        requestId: crypto.randomUUID(),
        expected: "executed",
      });
    } catch (error) {
      setScreen({ kind: "error", message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function tryOutsideStanding(bandId: string) {
    setScreen({ kind: "loading", message: "Checking this request against your approved limits…" });
    try {
      await completeStandingRun({
        bandId,
        fixtureId: "move-dinner-under-standing-band",
        requestId: crypto.randomUUID(),
        expected: "review_required",
      });
    } catch (error) {
      setScreen({ kind: "error", message: (error as Error).message });
    }
  }

  async function completeStandingRun(input: StandingRunInput) {
    const result = await attemptStandingRunWithRecovery(
      input,
      (standingInput) =>
        api<StandingRunResponse>(
          `/api/standing-bands/${standingInput.bandId}/run`,
          {
            method: "POST",
            body: JSON.stringify({
              fixtureId: standingInput.fixtureId,
              requestId: standingInput.requestId,
            }),
          },
        ),
      () => setScreen({ kind: "loading", message: "Checking what happened…" }),
    );
    if (result.status === "ambiguous") {
      setScreen({
        kind: "standing-recovery",
        input,
        message:
          "Bander couldn’t confirm the result yet. Check this same request again to recover the outcome or review Card without repeating the action.",
      });
      return;
    }
    if (input.expected === "executed" && result.value.status === "executed") {
      setScreen({
        kind: "standing-receipt",
        receipt: result.value.receipt,
        bandId: input.bandId,
      });
      return;
    }
    if (
      input.expected === "review_required" &&
      result.value.status === "review_required"
    ) {
      setScreen({ kind: "card", card: result.value.card, scenario: "exact" });
      return;
    }
    throw new Error("The standing request returned an unexpected result");
  }

  async function recoverStanding(input: StandingRunInput) {
    setBusy(true);
    try {
      await completeStandingRun(input);
    } catch (error) {
      setScreen({ kind: "error", message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function revokeStanding(bandId: string) {
    setBusy(true);
    try {
      await api(`/api/bands/${bandId}/revoke`, { method: "POST" });
      setScreen({ kind: "standing-revoked" });
    } catch (error) {
      setScreen({ kind: "error", message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function approve(card: ApprovalCard, scenario: DealScenario) {
    if (approvalInFlight.current) return;
    approvalInFlight.current = true;
    setBusy(true);
    try {
      const path = scenario === "ambiguous"
          ? `/api/demo/drafts/${card.draftId}/approve-ambiguous`
          : scenario === "email-ambiguous"
          ? `/api/demo/drafts/${card.draftId}/approve-email-ambiguous`
          : scenario === "email-thread"
          ? `/api/demo/drafts/${card.draftId}/approve-after-email-thread-change`
          : scenario === "cancel-conflict"
          ? `/api/demo/drafts/${card.draftId}/approve-after-cancel-calendar-change`
          : scenario === "conflict"
          ? `/api/demo/drafts/${card.draftId}/approve-after-calendar-change`
          : `/api/drafts/${card.draftId}/approve`;
      const request = () =>
        api<HumanReceipt>(path, {
          method: "POST",
          body: JSON.stringify({ draftHash: card.draftHash }),
        });
      if (scenario === "ambiguous") {
        const outcome = await api<{ message: string }>(path, { method: "POST", body: JSON.stringify({ draftHash: card.draftHash }) });
        const state = await api<DemoSandboxState>("/api/demo/state");
        setScreen({ kind: "ambiguous-outcome", message: outcome.message, card, state });
        return;
      }
      if (scenario === "email-ambiguous") {
        const outcome = await api<{ message: string }>(path, { method: "POST", body: JSON.stringify({ draftHash: card.draftHash }) });
        const state = await api<DemoSandboxState>("/api/demo/state");
        setScreen({ kind: "ambiguous-outcome", message: outcome.message, card, state });
        return;
      }
      if (["exact", "compound", "create", "cancel", "email", "direct-family"].includes(scenario)) {
        const result = await attemptApprovalWithRecovery(request, () =>
          setScreen({ kind: "loading", message: "Checking what happened…" }),
        );
        if (result.status === "ambiguous") {
          setScreen({
            kind: "approval-recovery",
            card,
            message:
              "Bander couldn’t confirm the result yet. Check the exact deal again to reconcile what happened without repeating the action.",
          });
          return;
        }
        if (["compound", "create", "cancel", "email", "direct-family"].includes(scenario)) {
          const state = await api<DemoSandboxState>("/api/hero/state").catch(() => api<DemoSandboxState>("/api/demo/state"));
          setScreen({ kind: "compound-receipt", receipt: result.value, state, card, replayed: false });
        } else setScreen({ kind: "receipt", receipt: result.value });
        return;
      }
      setScreen({ kind: "receipt", receipt: await request() });
    } catch (error) {
      if (scenario === "cancel-conflict" && error instanceof ApiError && error.code === "conflict") {
        const state = await api<DemoSandboxState>("/api/demo/state");
        setScreen({ kind: "cancel-conflict-outcome", state });
        return;
      }
      if (scenario === "email-thread" && error instanceof ApiError && error.code === "email_thread_changed") {
        setScreen({ kind: "email-thread-changed" });
        return;
      }
      setScreen({ kind: "error", message: (error as Error).message });
    } finally {
      approvalInFlight.current = false;
      setBusy(false);
    }
  }

  async function replayCompound(screen: Extract<Screen, { kind: "compound-receipt" }>) {
    const receipt = await api<HumanReceipt>(`/api/drafts/${screen.card.draftId}/approve`, { method: "POST", body: JSON.stringify({ draftHash: screen.card.draftHash }) });
    const state = await api<DemoSandboxState>("/api/demo/state");
    setScreen({ ...screen, receipt, state, replayed: true });
  }

  async function decline(card: ApprovalCard) {
    setBusy(true);
    try {
      await api(`/api/drafts/${card.draftId}/decline`, { method: "POST" });
      setScreen({ kind: "declined" });
    } catch (error) {
      setScreen({ kind: "error", message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (status?.heroMode) {
    return (
      <div className="app-frame hero-frame">
        <header><Brand /><span className="tagline">Help without surprises.</span></header>
        <HeroSandbox />
      </div>
    );
  }

  return (
    <div className="app-frame">
      <header className={screen.kind === "welcome" ? "r1-header" : undefined}>
        <Brand />
        {screen.kind !== "welcome" && <span className="tagline">Help without surprises.</span>}
      </header>
      {screen.kind === "welcome"
        ? <R1SandboxNotice />
        : <SandboxNotice browserOnly={status?.browserOnly === true || demoBackend.kind === "browser"} />}
      {screen.kind === "welcome" && <FamilyThread />}
      {screen.kind === "loading" && (
        <main className="state-screen" aria-live="polite">
          <div className="loader" />
          <p>{screen.message}</p>
        </main>
      )}
      {screen.kind === "card" && (
        <>
          {screen.scenario === "ambiguous" && (
            <aside className="uncertainty-preface">
              <strong>Sandbox scenario</strong>
              <span>{uncertaintySandboxPreface}</span>
            </aside>
          )}
          <DealCard
            card={screen.card}
            onApprove={() => approve(screen.card, screen.scenario)}
            onDecline={() => decline(screen.card)}
            onChange={() => setScreen({ kind: "change", card: screen.card, scenario: screen.scenario })}
            busy={busy}
          />
        </>
      )}
      {screen.kind === "receipt" && (
        <Receipt receipt={screen.receipt} onReset={() => setScreen({ kind: "welcome" })} />
      )}
      {screen.kind === "schedule-read" && <ScheduleReadView result={screen.result} onBack={() => setScreen({ kind: "welcome" })} />}
      {screen.kind === "inbox-read" && <InboxReadView messages={screen.messages} onBack={() => setScreen({ kind: "welcome" })} />}
      {screen.kind === "compound-receipt" && <CompoundResult screen={screen} onReplay={() => replayCompound(screen)} onBack={() => setScreen({ kind: "welcome" })} />}
      {screen.kind === "ambiguous-outcome" && <AmbiguousOutcome screen={screen} onReplay={() => approve(screen.card, screen.card.effectPreviews.some((effect) => effect.kind === "email.reply") ? "email-ambiguous" : "ambiguous")} onBack={() => setScreen({ kind: "welcome" })} />}
      {screen.kind === "email-thread-changed" && (
        <main className="result-shell uncertain-result" aria-live="polite">
          <span className="deal-kicker">Email changed</span>
          <h1>I stopped.</h1>
          <p className="result-summary">I stopped—the email conversation changed since this reply was prepared. No reply was sent. Read the latest message before trying again.</p>
          <button className="secondary" onClick={() => setScreen({ kind: "welcome" })}>Back to the sandbox</button>
        </main>
      )}
      {screen.kind === "initialization-failed" && (
        <main className="result-shell error-state" role="alert">
          <span className="deal-kicker">Demo step reset</span>
          <h1>Nothing happened.</h1>
          <p className="result-summary">This demo step reset itself. Tap Start again — nothing was sent or changed.</p>
          <button className="secondary" onClick={() => setScreen({ kind: "welcome" })}>Start again</button>
        </main>
      )}
      {screen.kind === "cancel-conflict-outcome" && (
        <main className="compound-result" aria-live="polite">
          <section className="result-shell uncertain-result"><span className="deal-kicker">Calendar changed</span><h1>I stopped.</h1><p>The calendar changed since the deal was prepared. Bander did not remove the event or send a family update.</p><p>Review the changed event before asking your assistant again.</p><button className="secondary" onClick={() => setScreen({ kind: "welcome" })}>Back to the sandbox</button></section>
          <FamilyPhone state={screen.state} />
        </main>
      )}
      {screen.kind === "standing-card" && (
        <StandingCardView
          card={screen.card}
          onApprove={() => approveStanding(screen.card)}
          onDecline={() => setScreen({ kind: "welcome" })}
          busy={busy}
        />
      )}
      {screen.kind === "standing-receipt" && (
        <Receipt
          receipt={screen.receipt}
          onTryOutside={() => tryOutsideStanding(screen.bandId)}
          onRevoke={() => revokeStanding(screen.bandId)}
          onReset={() => setScreen({ kind: "welcome" })}
        />
      )}
      {screen.kind === "standing-revoked" && (
        <main className="result-shell" aria-live="polite">
          <span className="deal-kicker">Automatic handling off</span>
          <h1>You’re back in control.</h1>
          <p className="result-summary">
            Future requests will come back to you as a one-time deal before Bander acts.
          </p>
          <button className="secondary" onClick={() => setScreen({ kind: "welcome" })}>
            Back to Bander
          </button>
        </main>
      )}
      {screen.kind === "standing-recovery" && (
        <StandingRecoveryView
          busy={busy}
          message={screen.message}
          onCheck={() => recoverStanding(screen.input)}
          onBack={() => setScreen({ kind: "welcome" })}
        />
      )}
      {screen.kind === "change" && (
        <main className="result-shell">
          <span className="deal-kicker">Nothing changed</span>
          <h1>Ask for a different deal.</h1>
          <p className="result-summary">
            In Telegram, tell your assistant what you want changed and Bander will prepare a new deal.
          </p>
          <button className="secondary" onClick={() => setScreen({ kind: "card", card: screen.card, scenario: screen.scenario })}>
            Review this deal again
          </button>
        </main>
      )}
      {screen.kind === "declined" && (
        <main className="result-shell">
          <span className="deal-kicker">No action taken</span>
          <h1>Not now.</h1>
          <p className="result-summary">Your calendar and messages were left exactly as they were.</p>
          <button className="secondary" onClick={() => setScreen({ kind: "welcome" })}>Back to Bander</button>
        </main>
      )}
      {screen.kind === "approval-recovery" && (
        <main className="result-shell" role="alert" aria-live="polite">
          <span className="deal-kicker">Result not confirmed</span>
          <h1>Let’s check what happened.</h1>
          <p className="result-summary">{screen.message}</p>
          <div className="result-actions">
            <button
              className="primary"
              onClick={() => approve(screen.card, "exact")}
              disabled={busy}
            >
              {busy ? "Checking…" : "Check what happened"}
            </button>
            <button className="secondary" onClick={() => setScreen({ kind: "welcome" })}>
              Back to Bander
            </button>
          </div>
        </main>
      )}
      {screen.kind === "error" && (
        <main className="result-shell error-state" role="alert">
          <span className="deal-kicker">Bander didn’t act</span>
          <h1>Something changed.</h1>
          <p className="result-summary">{screen.message}</p>
          <button className="secondary" onClick={() => setScreen({ kind: "welcome" })}>Start again</button>
        </main>
      )}
    </div>
  );
}
