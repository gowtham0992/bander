import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { ComparisonStage, SetupStationId, WorldSheet } from "./family-thread-surfaces.js";
import { SETUP_STATIONS, VERIFIED_OUTCOMES } from "./family-thread-surfaces.js";

const comparisonRows = [
  ["Who holds the Google and Gmail credentials?", "The configured tool or connector holds them within the agent’s execution environment.", "Bander’s separate process holds them; OpenClaw receives none of those credentials."],
  ["What does “yes” approve?", "The exact tool call and parameters held for approval.", "A stored deal plus the outside state it was based on; Bander checks that state again before execution."],
  ["Who reports the outcome?", "The tool result returns through the assistant’s conversation.", "Bander separately reports the observed result through its own Telegram identity."],
  ["What if the result cannot be confirmed?", "Behavior depends on the connector’s recovery and reporting policy.", "Bander records an unconfirmed outcome and never repeats a dispatched action automatically."],
  ["Who can receive a family message?", "The destinations granted to the agent’s configured messaging tools.", "One separately consented contact; its destination is bound outside the agent and the exact text requires approval."],
] as const;

function SurfaceGlyph({ kind }: { kind: string }) {
  return <span className={`surface-glyph glyph-${kind}`} aria-hidden="true"><i /><i /><i /></span>;
}

function SurfaceDialog({
  className,
  title,
  onClose,
  children,
}: {
  className: string;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnTo.current = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button, a[href]")?.focus();
    return () => returnTo.current?.focus();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !ref.current) return;
    const controls = [...ref.current.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])")];
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };

  return createPortal(
    <div className="surface-backdrop">
      <div ref={ref} className={className} role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKeyDown}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function ProofDrawer({ mode, onClose }: { mode: "outcomes" | "comparison"; onClose: () => void }) {
  const groups = ["Calendar", "Email", "Family", "Refusals & uncertainty", "Recovery & routine"] as const;
  return (
    <SurfaceDialog className="proof-drawer" title={mode === "comparison" ? "Full OpenClaw and Bander comparison" : "All 27 verified outcomes"} onClose={onClose}>
      <header className="drawer-heading">
        <div><span>{mode === "comparison" ? "A fair comparison" : "Seeded proof library"}</span><h2>{mode === "comparison" ? "Where Bander’s boundary begins" : "All 27 verified outcomes"}</h2></div>
        <button className="drawer-close" onClick={onClose} aria-label="Close drawer">×</button>
      </header>
      {mode === "comparison" ? (
        <div className="drawer-comparison">
          <p>OpenClaw approvals are useful. For an operator who controls their own agent and tools, they are often enough. Bander is for handing that power to a non-operator parent while the keys and human outcome stay on a separate boundary.</p>
          <div className="comparison-ledger" role="table" aria-label="Native OpenClaw approvals compared with Bander">
            {comparisonRows.map(([question, native, bander]) => (
              <div className="comparison-ledger-row" role="row" key={question}>
                <strong role="rowheader">{question}</strong>
                <span role="cell"><small>Native OpenClaw approval</small>{native}</span>
                <span role="cell"><small>With Bander</small>{bander}</span>
              </div>
            ))}
          </div>
          <p className="boundary-note">A compromised host or operating system remains outside Bander’s current boundary.</p>
        </div>
      ) : (
        <div className="proof-groups">
          {groups.map((group) => (
            <section key={group} aria-labelledby={`proof-${group.replaceAll(" ", "-").replace("&", "and")}`}>
              <h3 id={`proof-${group.replaceAll(" ", "-").replace("&", "and")}`}>{group}</h3>
              <div className="proof-list">
                {VERIFIED_OUTCOMES.filter((outcome) => outcome.group === group).map((outcome) => (
                  <a key={outcome.id} href={`?scenario=${outcome.routeId}`} data-proof-route={outcome.routeId}>
                    <SurfaceGlyph kind={outcome.glyph} /><span>{outcome.sentence}</span><b aria-hidden="true">→</b>
                  </a>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </SurfaceDialog>
  );
}

const beats = {
  beat_1: { number: "01", title: "Approvals gate the hand.", copy: "OpenClaw can pause an exact tool call for approval. For an operator running their own agent, that is often enough." },
  beat_2: { number: "02", title: "Bander moves the keys across the line.", copy: "Google, Gmail, and Bander’s Telegram identity sit beyond the reasoning agent. OpenClaw can ask; it cannot reach those credentials directly." },
  beat_3: { number: "03", title: "And binds every yes to the world she actually saw.", copy: "The Card commits to the exact deal and current outside state. Bander checks again, then reports the observed result through its own identity." },
  complete: { number: "✓", title: "One boundary, for a different person.", copy: "This is not a claim that native approvals are weak. It is a product boundary designed for the parent who should never need to operate the agent." },
} as const;

export function ComparisonThread({
  stage,
  onOpen,
  onNext,
  onFull,
}: {
  stage: ComparisonStage;
  onOpen: () => void;
  onNext: () => void;
  onFull: () => void;
}) {
  const beat = stage === "closed" ? null : beats[stage];
  return (
    <section className="comparison-thread" aria-labelledby="comparison-thread-title">
      <div className="surface-thread-rule" aria-hidden="true"><span /></div>
      <header><span>THE FAIR QUESTION</span><h2 id="comparison-thread-title">The boundary, without the sales pitch.</h2></header>
      {stage === "closed" ? (
        <button className="comparison-question" onClick={onOpen}>Doesn’t OpenClaw already do approvals?</button>
      ) : (
        <article className="comparison-beat" data-comparison-stage={stage}>
          <span className="beat-number">{beat!.number}</span><div><h3>{beat!.title}</h3><p>{beat!.copy}</p></div>
          {stage !== "complete" ? <button onClick={onNext}>{stage === "beat_3" ? "Finish the thought" : "Next"}<span aria-hidden="true">→</span></button> : <button onClick={onFull}>Full comparison <span aria-hidden="true">→</span></button>}
        </article>
      )}
    </section>
  );
}

function SetupGlyph({ kind }: { kind: string }) {
  return <span className={`setup-glyph setup-${kind}`} aria-hidden="true"><i /><i /></span>;
}

export function SetupRail({
  active,
  onOpen,
  onClose,
}: {
  active: SetupStationId | null;
  onOpen: (station: SetupStationId) => void;
  onClose: () => void;
}) {
  const station = SETUP_STATIONS.find((candidate) => candidate.id === active);
  return (
    <section className="setup-rail" aria-labelledby="setup-rail-title">
      <header><span>FOR THE PERSON SETTING IT UP</span><h2 id="setup-rail-title">Five quiet steps, once.</h2><p>About 45 minutes once. Fully reversible. Runs beside an isolated OpenClaw profile.</p></header>
      <div className="setup-track">
        {SETUP_STATIONS.map((item, index) => (
          <button key={item.id} onClick={() => onOpen(item.id)} aria-label={`${index + 1}. ${item.title}. ${item.summary}`}>
            <span className="station-number">0{index + 1}</span><SetupGlyph kind={item.glyph} /><strong>{item.title}</strong><small>{item.summary}</small>
          </button>
        ))}
      </div>
      <nav className="evaluator-paths" aria-label="Evaluator paths"><a href={import.meta.env.BASE_URL}>Hosted sandbox</a><a href="https://github.com/gowtham0992/bander#zero-account-judge-path" target="_blank" rel="noreferrer">Local sandbox</a><a href="https://github.com/gowtham0992/bander/blob/main/SETUP.md" target="_blank" rel="noreferrer">Real setup</a></nav>
      {station && (
        <SurfaceDialog className="setup-dialog" title={station.title} onClose={onClose}>
          <button className="drawer-close" onClick={onClose} aria-label="Close setup detail">×</button>
          <SetupGlyph kind={station.glyph} /><span className="station-number">SETUP STATION</span><h2>{station.title}</h2><p>{station.detail}</p>
          <a className="setup-guide-link" href={`https://github.com/gowtham0992/bander/blob/main/SETUP.md${station.anchor}`} target="_blank" rel="noreferrer">Full guide →</a>
        </SurfaceDialog>
      )}
    </section>
  );
}

export function WorldDetailSheet({
  world,
  calendarDetail,
  inboxDetail,
  phoneDetail,
  phoneMessage,
  onClose,
}: {
  world: Exclude<WorldSheet, null>;
  calendarDetail: string;
  inboxDetail: string;
  phoneDetail: string;
  phoneMessage?: string;
  onClose: () => void;
}) {
  const content = world === "calendar"
    ? { title: "Seeded Calendar", detail: calendarDetail, note: "This object shows only the authoritative seeded Calendar state." }
    : world === "inbox"
      ? { title: "Seeded Sent Mail", detail: inboxDetail, note: "This object shows only the authoritative seeded mail state." }
      : { title: "Gil update · sandbox", detail: phoneDetail, note: "Bander confirms only that the sandbox sent the update. It does not claim device delivery or that anyone read it." };
  return (
    <SurfaceDialog className="world-sheet" title={content.title} onClose={onClose}>
      <button className="drawer-close" onClick={onClose} aria-label="Close seeded detail">×</button>
      <span className="world-seeded">SANDBOX</span><h2>{content.title}</h2><strong>{content.detail}</strong>{world === "phone" && phoneMessage && <pre>{phoneMessage}</pre>}<p>{content.note}</p>
    </SurfaceDialog>
  );
}
