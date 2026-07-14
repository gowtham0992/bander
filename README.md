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

Run the deterministic verification commands with no personal account or model key:

```bash
npm run check
npm run attack
npm run verify:demo
npm run verify:recovery
npm run verify:openclaw
```

`npm run verify:recovery` opens a real local HTTP listener and proves the ambiguous-response path: the Calendar commits, the first approval response is lost, the same-hash approval is retried, and Bander returns one Receipt without minting new authority or repeating the mutation.

For an interactive MCP probe, keep the demo running and use a second terminal:

```bash
npm run openclaw -- config validate
npm run openclaw -- mcp doctor bander --probe
npm run openclaw -- mcp probe bander --json
```

OpenClaw runs through the compatible Node runtime pinned inside this project and uses isolated state under `.bander/`. Its versioned config is [openclaw/reference.openclaw.json](./openclaw/reference.openclaw.json).

`npm run verify:openclaw` runs a real local OpenClaw agent turn against a deterministic OpenAI-compatible mock provider. The model receives exactly `bander__list_capabilities`, `bander__propose_action`, and `bander__get_receipt`; it passes the human request through MCP, creates a proposed Draft/Card, and performs no execution.

## Optional GPT-5.6 compiler

Set `OPENAI_API_KEY` before `npm run demo` to enable `/api/compiler/proposals`. The model uses strict Structured Outputs to select a versioned candidate fixture; deterministic Bander code still creates the Draft and owns every authorization decision. Without a key, the compiler route stays closed and the full judge demo remains runnable.

## Security boundary

In the canonical demo, the OpenClaw process has no Calendar or Messages credentials and no direct tool path to Bander’s mock Calendar or Messages services. Bander is the only route to those effects. This guarantee applies only to services mediated by Bander; it does not protect tools, credentials, or hosts outside that configured boundary.

OpenClaw may use network transport to reach its model provider and Bander's MCP endpoint. It has no direct Calendar, Messages, browser, shell, generic outbound-action tool, or downstream service credential in the canonical configuration.

## Build status

The current implementation verifies the isolated credential boundary, exact one-time authority, duration-preserving Calendar reschedules, idempotent response-loss recovery, changed-world refusal, attack suite, proposal flood control, the first narrow standing Band, the real OpenClaw Streamable HTTP proposal flow, effective session tool inventory, provenance-isolated agent text, and the optional gated GPT-5.6 candidate compiler. See [BUILD_WITH_CODEX.md](./BUILD_WITH_CODEX.md) for the evidence ledger and [Bander_Build_Plan.md](./Bander_Build_Plan.md) for the product source of truth.

For demo preparation, see [docs/recording-plan.md](./docs/recording-plan.md) and [docs/submission-checklist.md](./docs/submission-checklist.md).
