# Bander

**Bander holds the keys. Your agent can only ask.**

Bander is a confidence layer for personal AI agents. Before an agent changes a person's life, Bander shows the exact deal, lets the person approve it, and carries out only that deal.

This repository is being built during OpenAI Build Week. The deterministic local judge flow needs no personal account or OpenAI API key.

## Run locally

Requirements: Node.js 22.12 or newer.

```bash
npm install
npm run demo
```

Open `http://127.0.0.1:4310`. The app includes the one-time approval, changed-world refusal, and narrow standing-Band flows. Calendar moves preserve duration and show the complete before/after interval. Every execution shape uses an idempotent operation record so an ambiguous lost response can be reconciled truthfully.

For the clean consumer presentation with real Telegram bots and a real isolated
OpenClaw gateway, use:

```bash
npm run hero
```

Hero mode keeps its state and generated OpenClaw configuration under
`.bander/hero/`, separate from every verification run. On first launch it writes
an expiring private pairing link to `.bander/hero/pairing-link.txt`. After
pairing, open `http://127.0.0.1:4310` for a read-only **Demo Calendar** and
**Demo Messages** view backed by the exact credential-protected sandbox Bander
mutates. Press `c` in the Hero terminal only when deliberately demonstrating a
Calendar change that happens after Bander prepared a review Card.

Hero Telegram contains no verifier instructions or probes. OpenClaw stays
silent after Bander-owned proposed, automatic, conflict, and declined outcomes,
while unsupported wording still receives a useful OpenClaw reply. Verification
mode retains its explicit evidence choreography and isolated state.

Run the deterministic verification commands with no personal account or model key:

```bash
npm run check
npm run attack
npm run verify:demo
npm run verify:recovery
npm run verify:standing-recovery
npm run verify:openclaw
npm run verify:telegram-privacy
npm run verify:telegram-conflict
npm run verify:telegram-standing
```

`npm run verify:recovery` opens a real local HTTP listener and proves the ambiguous-response path: the Calendar commits, the first approval response is lost, the same-hash approval is retried, and Bander returns one Receipt without minting new authority or repeating the mutation.

Standing execution requests require a client-generated request ID. Bander binds it to the standing Band and a canonical digest of the requested content, so browser retries recover the original Draft, Permit, Card, or Receipt instead of creating another attempt. `npm run verify:standing-recovery` exercises both downstream and broker-response loss through real local HTTP listeners.

For an interactive MCP probe, keep the demo running and use a second terminal:

```bash
npm run openclaw -- config validate
npm run openclaw -- mcp doctor bander --probe
npm run openclaw -- mcp probe bander --json
```

OpenClaw runs through the compatible Node runtime pinned inside this project and uses isolated state under `.bander/`. Its versioned config is [openclaw/reference.openclaw.json](./openclaw/reference.openclaw.json).

`npm run verify:openclaw` runs a real local OpenClaw agent turn against a deterministic OpenAI-compatible mock provider. The model receives exactly `bander__list_capabilities`, `bander__propose_action`, and `bander__get_receipt`; it passes the human request through MCP, creates a proposed Draft/Card, and performs no execution.

## Telegram journeys

Set separate `OPENCLAW_TELEGRAM_BOT_TOKEN` and `BANDER_TELEGRAM_BOT_TOKEN` values only in ignored local `.env`. On an unpaired installation, Bander writes an expiring private pairing link to `.bander/telegram-service/pairing-link.txt`. The owner opens that link in a private Bander-bot chat, then uses Telegram's private group picker. Neither the pairing token nor the selected destination enters the shared group or OpenClaw.

The Bander-owned service persists the one-owner installation and every approval surface under `.bander/telegram-service/`. It posts a plain-text, provenance-labelled human review message with **Do exactly this** and **Not now** controls. Both controls are bound to the owner, group, Bander-authored message and proposed action. Approval uses the existing idempotent execution boundary; decline uses the deterministic terminal decline lifecycle and can never be revived. OpenClaw receives only the minimal action ID and lifecycle status.

Authority execution and human Telegram delivery have different retry guarantees. Downstream execution is exactly once through the existing idempotent operation record. Human outcomes are at least once: Bander marks a Receipt or changed-world refusal delivered only after Telegram confirms `sendMessage`. A retry after an ambiguous crash may duplicate the same truthful notification; this is safer than silently completing an action without human confirmation.

`npm run verify:telegram-privacy` runs this real service with real Telegram and OpenClaw. It probes the previously validated non-owner identity synthetically against the exact live Bander surface, then asks the owner to prove idempotent approval and a separate explicit decline. The exported trajectory must contain neither human review/outcome/decline copy nor genuine callback values. The older `scripts/telegram-privacy-spike.ts` remains historical evidence; it is not the active verifier or production implementation.

Telegram copy is deliberately separate from the engine’s internal vocabulary. It names OpenClaw as the source of the claimed request, renders local human-readable times, uses relative expiry wording, and omits IDs and raw timestamps. Dynamic hearsay is sent without HTML or Markdown parsing and is flattened to one plain-text line so it cannot forge Bander-authored sections.

`npm run verify:telegram-conflict` changes the seeded Calendar after the real service posts its Card. The owner's approval produces one human-only refusal, no Bander mutation and no Receipt; replay stays closed, and the exported OpenClaw trajectory contains none of the refusal explanation.

The owner can turn on the bounded Focus-time routine entirely inside Telegram by asking OpenClaw, `Handle my focus time automatically.` The request still uses `propose_action`; Bander constructs the fixed predicate and posts its own clause-by-clause **Turn on automatic / Ask me each time** message. The agent receives only `{status:"proposed"}` and cannot supply, widen, or approve the predicate. Activation is bound to the authenticated owner, group, Bander bot and exact Bander-authored message.

An approved standing Band can then handle the bounded Focus-block move without another approval. Bander posts a human-only outcome with the current rolling counter and a distinct owner-bound **Turn off automatic** callback. The service persists one outcome per standing request ID before delivery; retry reconciles the same Draft, Permit and Receipt, while Telegram notification remains at least once. Revocation uses the authority engine's Band lock, is idempotent, and blocks future standing execution.

`npm run verify:telegram-standing` runs the complete path through real OpenClaw and Telegram: natural opt-in request, genuine owner activation, automatic move, owner revocation, and return to one-time review. It proves one standing authority, one Permit, one downstream execution and one outcome; rejects the wrong user, chat, Bander message, bot and callback; and verifies the activation explanation, exact outcome, callbacks and post-revoke Card remain absent from OpenClaw's model input and exported trajectory.

## Optional GPT-5.6 compiler

Set `OPENAI_API_KEY` before `npm run demo` to enable `/api/compiler/proposals`. The model uses strict Structured Outputs to select a versioned candidate fixture; deterministic Bander code still creates the Draft and owns every authorization decision. Without a key, the compiler route stays closed and the full judge demo remains runnable.

## Security boundary

In the canonical demo, the OpenClaw process has no Calendar or Messages credentials and no direct tool path to Bander’s mock Calendar or Messages services. Bander is the only route to those effects. This guarantee applies only to services mediated by Bander; it does not protect tools, credentials, or hosts outside that configured boundary.

OpenClaw may use network transport to reach its model provider and Bander's MCP endpoint. It has no direct Calendar, Messages, browser, shell, generic outbound-action tool, or downstream service credential in the canonical configuration.

The reference MCP endpoint is intentionally local-only and currently has no application-level authentication. The broker binds to `127.0.0.1` and limits each source address to 30 MCP POST requests per 60 seconds. Do not expose this endpoint directly to a LAN or the public internet.

## Build status

The current implementation verifies the isolated credential boundary, exact one-time authority, duration-preserving Calendar reschedules, idempotent response-loss recovery, changed-world refusal, attack suite, proposal flood control, the narrow standing Band, the real OpenClaw Streamable HTTP proposal flow, effective session tool inventory, provenance-isolated agent text, the real Bander-owned Telegram one-time and standing journeys, and the optional gated GPT-5.6 candidate compiler. See [BUILD_WITH_CODEX.md](./BUILD_WITH_CODEX.md) for the evidence ledger and [Bander_Build_Plan.md](./Bander_Build_Plan.md) for the product source of truth.

For demo preparation, see [docs/recording-plan.md](./docs/recording-plan.md) and [docs/submission-checklist.md](./docs/submission-checklist.md).
