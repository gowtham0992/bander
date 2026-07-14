import { useEffect, useState } from "react";
import type {
  ApprovalCard,
  ApprovalEffectPreview,
  HumanReceipt,
  StandingBandCard,
} from "@bander/contracts";

type StandingRunResponse =
  | { status: "executed"; receipt: HumanReceipt }
  | { status: "review_required"; card: ApprovalCard };

type Screen =
  | { kind: "welcome" }
  | { kind: "loading"; message: string }
  | { kind: "card"; card: ApprovalCard; scenario: "exact" | "conflict" }
  | { kind: "receipt"; receipt: HumanReceipt }
  | { kind: "standing-card"; card: StandingBandCard }
  | { kind: "standing-receipt"; receipt: HumanReceipt; bandId: string }
  | { kind: "standing-revoked" }
  | { kind: "declined" }
  | { kind: "change"; card: ApprovalCard }
  | { kind: "error"; message: string };

interface Status {
  fixtureMode: boolean;
  modelCompiler: "available" | "not_configured";
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
  if (!response.ok) throw new Error(body.error?.message ?? "Bander could not continue");
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

function Welcome({
  onStart,
  onStanding,
  onCompile,
  status,
}: {
  onStart: (scenario: "exact" | "conflict") => void;
  onStanding: () => void;
  onCompile: (request: string) => void;
  status: Status | null;
}) {
  const [compilerRequest, setCompilerRequest] = useState("");
  return (
    <main className="welcome">
      <div className="eyebrow">A confidence layer for personal agents</div>
      <h1>Help without<br />surprises.</h1>
      <p className="lede">
        Your agent can prepare useful work. Bander shows you the exact deal and
        carries out only what you approve.
      </p>
      <section className="request-preview" aria-label="Example agent request">
        <div className="request-avatar">A</div>
        <div>
          <span>Your request</span>
          <p>“Move dinner with Sarah to 7:30 and tell her I’ll be 20 minutes late.”</p>
        </div>
      </section>
      <button className="primary welcome-action" onClick={() => onStart("exact")}>
        See the deal
        <span aria-hidden="true">→</span>
      </button>
      <button className="scenario-link" onClick={() => onStart("conflict")}>
        Or see what happens when the calendar changes after approval
      </button>
      <button className="scenario-link" onClick={onStanding}>
        See a small routine handled automatically
      </button>
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
        <QuotedData source="Calendar event title">{preview.eventTitle}</QuotedData>{" "}
        from {preview.previousInterval} to {preview.resultingInterval}
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
          <h2>With this Band, Bander may only:</h2>
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
          <p><strong>Not allowed:</strong> {card.notAllowed}</p>
          <p>{card.boundary}</p>
        </div>

        <footer className="deal-meta">
          <div className="connections">
            {card.connections.map((connection) => (
              <span key={connection}>{connection}</span>
            ))}
          </div>
          <time dateTime={card.expiresAt}>
            Expires at {expiry.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </time>
          {card.proposalActivity && (
            <span>
              Request {card.proposalActivity.count} of {card.proposalActivity.limit}
            </span>
          )}
        </footer>

        <div className="actions">
          <button className="primary" onClick={onApprove} disabled={busy}>
            {busy ? "Completing…" : "Ready"}
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
        <QuotedData source="Calendar event title">{receipt.calendar.title}</QuotedData>
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
      <div className="receipt-stamp">
        <span>Receipt</span>
        <code>{receipt.id.replace("receipt_", "").slice(0, 12)}</code>
      </div>
      <div className="result-actions">
        {onTryOutside && (
          <button className="primary" onClick={onTryOutside}>
            Try a request outside this Band
          </button>
        )}
        <button className="secondary" onClick={onReset}>Back to Bander</button>
        {onRevoke && (
          <button className="quiet" onClick={onRevoke}>Turn off this Band</button>
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
        <span className="deal-kicker">Standing Band</span>
        <h1>{card.title}</h1>
      </div>
      <article className="deal-card standing-card">
        <section className="standing-intro">
          <p>
            Let your agent reschedule your solo focus blocks without asking each time—inside these exact limits.
          </p>
        </section>
        <section className="allowance">
          <h2>This Band allows:</h2>
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
            {busy ? "Turning it on…" : "Turn on this Band"}
          </button>
          <button className="quiet" onClick={onDecline} disabled={busy}>Not now</button>
        </div>
      </article>
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
    if (scenario === "exact" || scenario === "conflict") void start(scenario);
    if (scenario === "standing") void startStanding();
  }, []);

  async function start(scenario: "exact" | "conflict") {
    setScreen({ kind: "loading", message: "Preparing the exact deal…" });
    try {
      await api("/api/demo/reset", { method: "POST" });
      const card = await api<ApprovalCard>("/api/demo/proposals", {
        method: "POST",
        body: JSON.stringify({ fixtureId: "move-dinner-and-notify-sarah" }),
      });
      setScreen({ kind: "card", card, scenario });
    } catch (error) {
      setScreen({ kind: "error", message: (error as Error).message });
    }
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
      const result = await api<StandingRunResponse>(
        `/api/standing-bands/${authorization.bandId}/run`,
        {
          method: "POST",
          body: JSON.stringify({ fixtureId: "move-my-focus-block" }),
        },
      );
      if (result.status !== "executed") {
        throw new Error("The eligible routine unexpectedly required review");
      }
      setScreen({
        kind: "standing-receipt",
        receipt: result.receipt,
        bandId: authorization.bandId,
      });
    } catch (error) {
      setScreen({ kind: "error", message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function tryOutsideStanding(bandId: string) {
    setScreen({ kind: "loading", message: "Checking this request against your Band…" });
    try {
      const result = await api<StandingRunResponse>(`/api/standing-bands/${bandId}/run`, {
        method: "POST",
        body: JSON.stringify({ fixtureId: "move-dinner-under-standing-band" }),
      });
      if (result.status !== "review_required") {
        throw new Error("The outside request unexpectedly ran automatically");
      }
      setScreen({ kind: "card", card: result.card, scenario: "exact" });
    } catch (error) {
      setScreen({ kind: "error", message: (error as Error).message });
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

  async function approve(card: ApprovalCard, scenario: "exact" | "conflict") {
    setBusy(true);
    try {
      const path =
        scenario === "conflict"
          ? `/api/demo/drafts/${card.draftId}/approve-after-calendar-change`
          : `/api/drafts/${card.draftId}/approve`;
      const receipt = await api<HumanReceipt>(path, {
        method: "POST",
        body: JSON.stringify({ draftHash: card.draftHash }),
      });
      setScreen({ kind: "receipt", receipt });
    } catch (error) {
      setScreen({ kind: "error", message: (error as Error).message });
    } finally {
      setBusy(false);
    }
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

  return (
    <div className="app-frame">
      <header><Brand /><span className="tagline">Help without surprises.</span></header>
      {screen.kind === "welcome" && (
        <Welcome
          onStart={start}
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
        <DealCard
          card={screen.card}
          onApprove={() => approve(screen.card, screen.scenario)}
          onDecline={() => decline(screen.card)}
          onChange={() => setScreen({ kind: "change", card: screen.card })}
          busy={busy}
        />
      )}
      {screen.kind === "receipt" && (
        <Receipt receipt={screen.receipt} onReset={() => setScreen({ kind: "welcome" })} />
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
          <span className="deal-kicker">Standing Band off</span>
          <h1>You’re back in control.</h1>
          <p className="result-summary">
            Future requests will come back to you as a one-time deal before Bander acts.
          </p>
          <button className="secondary" onClick={() => setScreen({ kind: "welcome" })}>
            Back to Bander
          </button>
        </main>
      )}
      {screen.kind === "change" && (
        <main className="result-shell">
          <span className="deal-kicker">Nothing changed</span>
          <h1>Ask for a different deal.</h1>
          <p className="result-summary">
            Bander won’t edit the approved effects in place. Your agent can prepare a new Draft for you.
          </p>
          <button className="secondary" onClick={() => setScreen({ kind: "card", card: screen.card, scenario: "exact" })}>
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
