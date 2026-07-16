import { useEffect, useState } from "react";
import type {
  ApprovalCard,
  ApprovalEffectPreview,
  DemoSandboxState,
  HumanReceipt,
  StandingBandCard,
  ScheduleReadResult,
} from "@bander/contracts";

type StandingRunResponse =
  | { status: "executed"; receipt: HumanReceipt }
  | { status: "review_required"; card: ApprovalCard };

export interface StandingRunInput {
  bandId: string;
  fixtureId: string;
  requestId: string;
  expected: "executed" | "review_required";
}

type Screen =
  | { kind: "welcome" }
  | { kind: "loading"; message: string }
  | { kind: "card"; card: ApprovalCard; scenario: "exact" | "conflict" | "compound" | "ambiguous" }
  | { kind: "receipt"; receipt: HumanReceipt }
  | { kind: "compound-receipt"; receipt: HumanReceipt; state: DemoSandboxState; card: ApprovalCard; replayed: boolean }
  | { kind: "schedule-read"; result: ScheduleReadResult }
  | { kind: "ambiguous-outcome"; message: string; card: ApprovalCard }
  | { kind: "standing-card"; card: StandingBandCard }
  | { kind: "standing-receipt"; receipt: HumanReceipt; bandId: string }
  | { kind: "standing-revoked" }
  | { kind: "standing-recovery"; input: StandingRunInput; message: string }
  | { kind: "declined" }
  | { kind: "change"; card: ApprovalCard; scenario: "exact" | "conflict" | "compound" | "ambiguous" }
  | { kind: "approval-recovery"; card: ApprovalCard; message: string }
  | { kind: "error"; message: string };

interface Status {
  fixtureMode: boolean;
  modelCompiler: "available" | "not_configured";
  heroMode: boolean;
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
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
  });
  if (response.status === 204) return undefined as T;
  const body = (await response.json()) as T & {
    error?: { code: string; message: string };
  };
  if (!response.ok) {
    throw new ApiError(
      body.error?.message ?? "Bander could not continue",
      response.status,
      body.error?.code,
    );
  }
  return body;
}

function Brand() {
  return (
    <a className="brand" href="/" aria-label="Bander home">
      <img src="/bander_mark_transparent.svg" alt="" />
      <span>Bander</span>
    </a>
  );
}

const sandboxNotice = "Deterministic sandbox — uses seeded data and does not connect to Google, Telegram, or OpenAI. It exercises the same Bander Card, approval, outcome, and replay rules as the real product.";
const uncertaintySandboxPreface = "The Calendar provider’s response will be deliberately lost after approval, so Bander must report only what it can prove.";

function SandboxNotice() {
  return <p className="sandbox-notice">{sandboxNotice}</p>;
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
  return (
    <main className="compound-result" aria-live="polite">
      <section className="result-shell"><div className="result-mark">✓</div><h1>Done exactly as approved.</h1><p>“{screen.receipt.calendar.title}” moved to the approved interval.</p><p>Gil’s phone received the exact text shown on the Card.</p><button className="secondary" onClick={onReplay}>{screen.replayed ? "Replay changed nothing" : "Replay the same approval"}</button><button className="quiet" onClick={onBack}>Back to the sandbox</button></section>
      <FamilyPhone state={screen.state} />
    </main>
  );
}

function AmbiguousOutcome({ message, onReplay, onBack }: { message: string; onReplay: () => void; onBack: () => void }) {
  return (
    <main className="compound-result" aria-live="polite">
      <section className="result-shell uncertain-result"><span className="deal-kicker">Deliberately simulated lost response</span><h1>Calendar result unknown.</h1><p className="preserve-lines">{message}</p><p>The sandbox deliberately makes the external result unknowable.</p><button className="secondary" onClick={onReplay}>Replay safely</button><button className="quiet" onClick={onBack}>Back to the sandbox</button></section>
      <aside className="sandbox-phone"><span>Gil’s phone — sandbox</span><p>No family update received.</p></aside>
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

function Welcome({
  onStart,
  onSchedule,
  onStanding,
  onCompile,
  status,
}: {
  onStart: (scenario: "exact" | "conflict" | "compound" | "ambiguous") => void;
  onSchedule: () => void;
  onStanding: () => void;
  onCompile: (request: string) => void;
  status: Status | null;
}) {
  const [compilerRequest, setCompilerRequest] = useState("");
  return (
    <main className="welcome">
      <div className="eyebrow">Three everyday Bander lanes</div>
      <h1>Ask freely.<br />Approve changes.</h1>
      <p className="lede">
        Your agent can prepare useful work. Bander shows you the exact deal and
        carries out only what you approve.
      </p>
      <section className="lane-grid" aria-label="Main sandbox journeys">
        <button className="lane-card read-lane" onClick={onSchedule}>
          <span>ASK</span><strong>What’s on tomorrow?</strong><small>No approval toll for a harmless read.</small>
        </button>
        <button className="lane-card compound-lane" onClick={() => onStart("compound")}>
          <span>CHANGE</span><strong>Move an appointment and let family know</strong><small>One exact Card. One decision.</small>
        </button>
        <button className="lane-card uncertain-lane" onClick={() => onStart("ambiguous")}>
          <span>UNCERTAIN</span><strong>See an unknowable result</strong><small>Bander says only what it can prove.</small>
        </button>
      </section>
      <section className="more-behaviors">
        <h2>More verified behaviors</h2>
        <button className="scenario-link" onClick={() => onStart("conflict")}>Changed-world refusal</button>
        <button className="scenario-link" onClick={() => onStart("exact")}>Approval recovery and replay</button>
        <button className="scenario-link" onClick={onStanding}>Standing routine sandbox</button>
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
      <p className="fixture-note">
        {status?.modelCompiler === "available"
          ? "GPT-5.6 is available · deterministic demo selected"
          : "Versioned local demo · no API key needed"}
      </p>
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
}: {
  card: ApprovalCard;
  onApprove: () => void;
  onDecline: () => void;
  onChange: () => void;
  busy: boolean;
}) {
  const expiry = new Date(card.expiresAt);
  return (
    <main className="deal-shell">
      <div className="deal-heading">
        <span className="deal-kicker">Prepared for you</span>
        <h1>{card.title}</h1>
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
          <p><strong>Not included:</strong> Any other calendar events or actions.</p>
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
             {busy ? "Completing…" : "Do exactly this"}
          </button>
          <button className="secondary" onClick={onChange} disabled={busy}>Change it</button>
          <button className="quiet" onClick={onDecline} disabled={busy}>Not now</button>
        </div>
      </article>
    </main>
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
  return (
    <main className="result-shell" aria-live="polite">
      <div className="result-mark" aria-hidden="true">✓</div>
      <span className="deal-kicker">Completed as agreed</span>
      <h1>{receipt.title}</h1>
      <p className="result-summary">
        <span>Rescheduled Calendar event </span>
        <QuotedData source="Calendar">{receipt.calendar.title}</QuotedData>
        <span>
          {" "}from {formatReceiptInterval(receipt.calendar.previous, receipt.calendar.timeZone)}
          {" "}to {formatReceiptInterval(receipt.calendar.completed, receipt.calendar.timeZone)}.
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

  useEffect(() => {
    api<Status>("/api/status").then(setStatus).catch(() => setStatus(null));
    const scenario = new URLSearchParams(window.location.search).get("scenario");
    if (scenario === "exact" || scenario === "conflict" || scenario === "compound" || scenario === "ambiguous") void start(scenario);
    if (scenario === "standing") void startStanding();
  }, []);

  async function start(scenario: "exact" | "conflict" | "compound" | "ambiguous") {
    setScreen({ kind: "loading", message: "Preparing the exact deal…" });
    try {
      await api("/api/demo/reset", { method: "POST" });
      const card = await api<ApprovalCard>("/api/demo/proposals", {
        method: "POST",
        body: JSON.stringify({ fixtureId: scenario === "compound" || scenario === "ambiguous" ? "move-demo-appointment-and-notify-gil" : "move-dinner-and-notify-sarah" }),
      });
      setScreen({ kind: "card", card, scenario });
    } catch (error) {
      setScreen({ kind: "error", message: (error as Error).message });
    }
  }

  async function readTomorrow() {
    setScreen({ kind: "loading", message: "Reading the seeded schedule…" });
    try {
      const result = await api<ScheduleReadResult>("/api/demo/schedule/tomorrow");
      setScreen({ kind: "schedule-read", result });
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

  async function approve(card: ApprovalCard, scenario: "exact" | "conflict" | "compound" | "ambiguous") {
    setBusy(true);
    try {
      const path = scenario === "ambiguous"
          ? `/api/demo/drafts/${card.draftId}/approve-ambiguous`
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
        setScreen({ kind: "ambiguous-outcome", message: outcome.message, card });
        return;
      }
      if (scenario === "exact" || scenario === "compound") {
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
        if (scenario === "compound") {
          const state = await api<DemoSandboxState>("/api/hero/state").catch(() => api<DemoSandboxState>("/api/demo/state"));
          setScreen({ kind: "compound-receipt", receipt: result.value, state, card, replayed: false });
        } else setScreen({ kind: "receipt", receipt: result.value });
        return;
      }
      setScreen({ kind: "receipt", receipt: await request() });
    } catch (error) {
      setScreen({ kind: "error", message: (error as Error).message });
    } finally {
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
      <SandboxNotice />
      {screen.kind === "welcome" && (
        <Welcome
          onStart={start}
          onSchedule={readTomorrow}
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
      {screen.kind === "compound-receipt" && <CompoundResult screen={screen} onReplay={() => replayCompound(screen)} onBack={() => setScreen({ kind: "welcome" })} />}
      {screen.kind === "ambiguous-outcome" && <AmbiguousOutcome message={screen.message} onReplay={() => approve(screen.card, "ambiguous")} onBack={() => setScreen({ kind: "welcome" })} />}
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
