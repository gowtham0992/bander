import { useEffect, useRef, useState } from "react";
import type {
  ApprovalCard,
  ApprovalEffectPreview,
  DemoSandboxState,
  HumanReceipt,
  StandingBandCard,
  ScheduleReadResult,
} from "@bander/contracts";
import { createDemoBackend } from "./backend/index.js";

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

function SandboxNotice({ browserOnly }: { browserOnly: boolean }) {
  return <p className="sandbox-notice">{browserOnly ? browserSandboxNotice : localSandboxNotice}</p>;
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
    </main>
  );
}

function FamilyPhone({ state }: { state: DemoSandboxState }) {
  return (
    <aside className="sandbox-phone" aria-label="Gil’s phone sandbox">
      <span>Gil’s phone — sandbox</span>
      {state.familyUpdates.length === 0 ? <p>No family update received.</p> : state.familyUpdates.map((update) => (
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
      <section className="result-shell"><div className="result-mark">✓</div><h1>Done exactly as approved.</h1><p>{outcome}</p>{screen.receipt.familyNotification && <p>Gil’s phone received the exact text shown on the Card.</p>}<button className="secondary" onClick={onReplay}>{screen.replayed ? "Replay changed nothing" : "Replay the same approval"}</button><button className="quiet" onClick={onBack}>Back to the sandbox</button></section>
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
      <section className="result-shell uncertain-result"><span className="deal-kicker">Deliberately simulated lost response</span><h1>{emailOnly ? "Email result unknown." : "Calendar result unknown."}</h1><p className="preserve-lines">{screen.message}</p><p>The sandbox deliberately makes the external result unknowable.</p><button className="secondary" onClick={onReplay}>Replay safely</button><button className="quiet" onClick={onBack}>Back to the sandbox</button></section>
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
          {state?.familyUpdates.length ? state.familyUpdates.map((update) => <article key={update.sentAt}><strong>Bander</strong><pre>{update.body}</pre></article>) : <p className="surface-empty">No family update received.</p>}
        </section>
      </div>
      {stage === "complete" && (
        <aside className="evidence-strip">
          <strong>The real Bander has done this with real services.</strong>
          <span>A real OpenClaw conversation, Google Calendar, Gmail, and a separate Telegram phone—while OpenClaw held none of those credentials.</span>
        </aside>
      )}
    </section>
  );
}

function Welcome({
  onStart,
  onSchedule,
  onInbox,
  onStanding,
  onCompile,
  status,
}: {
  onStart: (scenario: DealScenario) => void;
  onSchedule: () => void;
  onInbox: () => void;
  onStanding: () => void;
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
      <section className="lane-grid" aria-label="Main sandbox journeys">
        <button className="lane-card read-lane" onClick={onSchedule}>
          <span>JUST ASK</span><strong>“What’s on tomorrow? What did Ruth say?”</strong><small>Harmless reading flows without an approval toll.</small>
        </button>
        <button className="lane-card compound-lane" onClick={() => onStart("compound")}>
          <span>APPROVE A CHANGE</span><strong>“Answer the email, update the calendar, tell Gil.”</strong><small>Exact effects. One decision at a time.</small>
        </button>
        <button className="lane-card uncertain-lane" onClick={() => onStart("ambiguous")}>
          <span>WHEN BANDER ISN’T SURE</span><strong>See a truthful uncertain outcome.</strong><small>No reassuring guess. No blind retry.</small>
        </button>
      </section>
      <GuidedEpisode />
      <section className="more-behaviors">
        <h2>More things Bander gets right</h2>
        <div className="behavior-grid">
          <button className="scenario-link" onClick={() => onStart("create")}>Add or remove something from the Calendar</button>
          <button className="scenario-link" onClick={() => onStart("cancel-conflict")}>When the Calendar changed first</button>
          <button className="scenario-link" onClick={() => onStart("email-thread")}>When a new email arrived before approval</button>
          <button className="scenario-link" onClick={() => onStart("email-ambiguous")}>When an external service’s result is unknowable</button>
          <button className="scenario-link" onClick={onStanding}>A bounded routine with an off switch</button>
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
      <footer className="public-footer">
        <strong>Set it up for someone you love.</strong>
        <p>The code, complete setup guide, architecture, evidence ledger, honest limitations, and MIT license are public.</p>
        <nav className="project-links" aria-label="Project resources">
          <a href="https://github.com/gowtham0992/bander" target="_blank" rel="noreferrer">Repository</a>
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
}: {
  card: ApprovalCard;
  onApprove: () => void;
  onDecline: () => void;
  onChange: () => void;
  busy: boolean;
  embedded?: boolean;
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
        <Heading>{card.title}</Heading>
      </div>
      <article className="deal-card">
        <AgentClaim card={card} />

        <section className="allowance">
          <h2>Through Bander, this will:</h2>
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
            <><p><strong>Not included:</strong></p><p>No one will be invited. No recurring event or reservation will be created.</p></>
          ) : cancels ? (
            <><p>Bander will not automatically restore this event after you approve.</p><p><strong>Not included:</strong></p><p>This removes only the calendar event.</p>{hasFamilyUpdate ? <p>Only the exact family update shown above will be sent. Bander will not contact the clinic, business, or event organizer.</p> : <p>It does not contact anyone or cancel the appointment itself.</p>}</>
          ) : repliesByEmail ? (
            <p><strong>Not included:</strong> No one else, no attachment, no forwarding, and no reply-all.</p>
          ) : directFamily ? (
            <p><strong>Not included:</strong> No one else, no link, attachment, command, or extra action.</p>
          ) : (
            <p><strong>Not included:</strong> Any other calendar events or actions.</p>
          )}
          <p>Nothing else will change in this seeded sandbox.</p>
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
          <button className="secondary" onClick={onChange} disabled={busy}>Change it</button>
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
      <header><Brand /><span className="tagline">Help without surprises.</span></header>
      <SandboxNotice browserOnly={status?.browserOnly === true || demoBackend.kind === "browser"} />
      {screen.kind === "welcome" && (
        <Welcome
          onStart={start}
          onSchedule={readTomorrow}
          onInbox={readInbox}
          onStanding={startStanding}
          onCompile={compileRequest}
          status={status}
        />
      )}
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
