# Building Bander with Codex

This document is maintained during implementation. It records what Codex actually contributed, which decisions remained human decisions, and which claims have been observed in tests. It is evidence, not a reconstructed launch story.

## Checkpoint 0 — product and boundary review

**Date:** July 13, 2026

Codex read the complete builder plan and livestream transcript, inspected the supplied logo variants, checked the live OpenAI Build Week page and Devpost requirements, and verified the current OpenClaw MCP documentation. No product code was written before the material decisions were answered.

Human decisions:

- The canonical judge flow must run without an OpenAI key using versioned deterministic Draft fixtures.
- GPT-5.6 is optional at runtime behind `OPENAI_API_KEY`; it may propose structured Drafts but never grants authority.
- The first judgeable artifact is a one-command local app.
- OpenClaw integration follows the credential boundary and broker tests.
- The demo uses one fictional local owner and no sign-in.
- The demo beats are built in strict risk order: one-time proof, changed-world/attack suite, then standing Bands.
- The source repository is private during the build and may become public for submission.
- OpenClaw may reach its model provider and Bander's MCP endpoint over the network, but receives no downstream credentials or generic outbound-action tools.

## Checkpoint 1 — workspace and credential boundary

**Status:** verified

Codex selected a small TypeScript workspace. Bander and the seeded mock services run as separate processes because credential isolation is part of the claim. Other modules remain in one repository so the prototype stays easy to run and inspect.

Planned verification evidence:

- Requests without the internal mock-service credential are rejected.
- Conditional Calendar writes reject stale ETags without mutation.
- Message retries are idempotent.
- The future OpenClaw child environment and tool manifest contain no downstream secrets or direct action tools.

Observed verification on July 13, 2026:

```text
$ npm run typecheck
exit 0

$ npm test
Test Files  1 passed (1)
Tests       6 passed (6)

$ npm audit --audit-level=high
found 0 vulnerabilities
```

## Deliberately invalidated tests

Each security-critical test will be observed failing after a targeted mutation, then restored. Entries will include the test name, mutation, observed failure, and restored run.

| Test | Deliberate mutation | Observed failure | Restored result |
| --- | --- | --- | --- |
| `rejects downstream reads without Bander's service credential` | Disabled the credential rejection branch. | Expected 401, received 200. | Included in the restored six-test green run. |
| `fails closed on an ETag mismatch without mutating the event` | Disabled the ETag mismatch branch. | Expected 412, received 200. | Included in the restored six-test green run. |
| `rejects approval when the displayed hash does not match the stored Draft` | Disabled the exact Draft-hash comparison. | The mismatched approval executed and returned a Receipt instead of rejecting. | Included in the restored full green run. |
| `executes the stored canonical Draft once and returns a human Receipt` | Disabled the pending-Draft lifecycle check. | A second approval executed and returned a second Receipt instead of rejecting. | Included in the restored full green run. |
| `does not place downstream credentials in the OpenClaw environment` | Deliberately projected `MOCK_SERVICE_TOKEN` into the OpenClaw child environment. | The environment-boundary assertion exposed the 64-character service credential. | Included in the restored full green run. |
| `rejects_extra_recipient_after_approval` | Disabled stored-Draft integrity verification in the executor. | The extra-recipient Draft executed and returned a Receipt. | Included in the restored attack run. |
| `rejects_payload_or_field_drift` | Disabled stored-Draft integrity verification in the executor. | The altered message payload executed and returned a Receipt. | Included in the restored attack run. |
| `rejects_substitution` | Disabled stored-Draft integrity verification in the executor. | The substituted Calendar target executed and returned a Receipt. | Included in the restored attack run. |
| `rejects_unrequested_helpful_action` | Disabled stored-Draft integrity verification in the executor. | The added effect executed and returned a Receipt. | Included in the restored attack run. |
| `rejects_permit_replay` | Disabled both Permit consumption and active-Band checks. | The same Permit returned a second Receipt. | Included in the restored attack run. |
| `rejects_expired_band` | Disabled the Band-expiry check. | The expired Band executed and returned a Receipt. | Included in the restored attack run. |
| `rejects_revoked_band` | Disabled the active-Band check. | The revoked Band executed and returned a Receipt. | Included in the restored attack run. |
| `revocation_linearizes_before_execution_commit` | Disabled the active-Band check while revoke was ordered first under the shared lock. | Execution committed after revocation instead of rejecting. | Included in the restored attack run. |
| `fails_closed_on_etag_mismatch` | Disabled conflict translation and state transition in the executor. | The raw downstream conflict escaped instead of the closed Bander refusal. | Included in the restored attack run. |
| `conflict_leaks_nothing_to_agent` | Disabled conflict translation and the minimal conflict state transition. | The test received a raw downstream error and no minimal conflict receipt. | Included in the restored attack run. |
| `agent_claimed_request_is_rendered_with_provenance` | Replaced the hearsay label with “Your request was.” | The provenance assertion reported the misleading label. | Included in the restored attack run. |
| `renders_agent_text_only_in_quoted_preview` | Temporarily rendered agent text as raw HTML. | Static React markup contained an active heading and button instead of escaped text. | Included in the restored attack run. |
| `rejects a tampered standing predicate after approval` | Forced the standing predicate matcher to return `true` for every Draft. | A Draft outside the approved predicate executed instead of returning for review. | Included in the restored 15-test attack run. |
| `rejects_standing_approval_replay` | Disabled the proposed-candidate lifecycle check. | The same reviewed candidate minted a second active standing Band. | Included in the restored 16-test attack run. |
| `pauses repeated agent proposals without affecting execution authority` | Changed the limiter boundary from `>=` to `>`. | The third proposal was accepted with a configured limit of two. | Included in the restored 17-test functional run. |
| `allowlists only Bander's three narrow MCP tools` | Added OpenClaw's host `exec` tool to the reference allowlist. | The manifest test displayed the unexpected fourth tool and failed. | Included in the restored 19-test functional run. |
| `can select but cannot alter a versioned Draft fixture` | Let the model-compiler path replace the selected fixture's Calendar start time. | The test showed the unapproved year-2099 payload instead of the versioned fixture value. | Included in the restored 22-test functional run. |

## Checkpoint 2 — one-time authorization vertical slice

**Status:** verified functionally and visually

Codex implemented the canonical versioned Draft fixture, deterministic canonicalization and SHA-256 hash, provenance-labelled Card view model, exact-hash one-time Band, internal 30-second executor-scoped Permit, stored-Draft execution, atomic seeded Calendar/Messages adapter, human Receipt, minimal agent status, and the first consumer UI.

The approval endpoint accepts only the Draft hash. During testing, Fastify's default validator was observed stripping an unexpected replacement `message` field and continuing. The broker and mock services were changed to reject unknown JSON fields instead, and the regression test now passes.

Observed one-command local flow without `OPENAI_API_KEY`:

```text
$ npm run demo
Bander mock services listening on http://127.0.0.1:4311
Bander broker listening on http://127.0.0.1:4310

GET  /api/status                         200 (fixture mode; compiler not configured)
GET  /                                   200 (built React shell)
POST /api/demo/proposals                 200 (deterministic Card)
POST /api/drafts/:draftId/approve        200 (deterministic Receipt)
```

The in-app browser connection failed during setup before it could open the local page. A scoped headless Chrome fallback rendered the real local app instead. The welcome screen and one-time Card were inspected at 1440px; responsive layout was inspected at Chrome's 500px minimum headless layout width. One mobile headline-size issue was found and corrected before the final responsive render.

## Checkpoint 3 — changed-world and authority attack suite

**Status:** verified

Codex split internal approval from execution without exposing Permit IDs through the browser or agent APIs. Approval and execution share the same keyed lock as revocation. The executor re-fetches the stored Draft, Band, and Permit under that ordering boundary before calling the mock adapter.

The local changed-world scenario approves the exact Draft, changes the seeded Calendar revision, then attempts execution. The conditional deal write commits neither Calendar nor Messages. The human receives the documented refusal; the agent receives only Draft ID plus `conflict`.

```text
$ npm run attack
Test Files  2 passed (2)
Tests       12 passed (12)

Exact flow:         reset 204 · proposal 200 · approval 200
Changed-world flow: reset 204 · proposal 200 · execution 409
Human: Your calendar changed after you approved this. I didn’t act.
Agent: { draftId, status: "conflict" }
```

## Checkpoint 4 — standing Bands and proposal flood control

**Status:** verified functionally and visually

Codex added one narrow standing predicate for rescheduling solo, owner-organized Calendar blocks on weekdays from 09:00–17:00 America/Denver. The rendered Card and hashed predicate are generated from the same structure. The rule permits only a start-time change, allows no new recipients or spending, caps execution at three actions per rolling 24 hours, expires after 30 days, and can be revoked immediately.

An eligible seeded focus-block move executes with a Calendar-only Receipt. An adjacent dinner move has another attendee and therefore returns to the ordinary one-time Card instead of executing. Agent proposal flood control pauses repeated Cards independently of execution authority.

Observed real-process flow through the credentialed mock-service boundary:

```text
Standing candidate: 5 exact clauses rendered
Eligible request:   executed · Focus block moved to 10:30 AM · no message sent
Adjacent request:   review_required · one-time Card returned

$ npm run check
Test Files  4 passed (4)
Tests       17 passed (17)

$ npm run attack
Test Files  2 passed (2)
Tests       15 passed (15)

$ npm run build
exit 0
```

## Checkpoint 5 — OpenClaw Streamable HTTP reference integration

**Status:** verified

Codex installed and pinned OpenClaw `2026.7.1`, its compatible project-local Node `24.15.0` runtime, and the stable MCP TypeScript SDK `1.29.0`. The machine-wide Node installation was not changed. OpenClaw uses a project-local home, state directory, workspace, and versioned config; it does not load the owner's normal OpenClaw state.

The broker now exposes a real Streamable HTTP endpoint at `/mcp`. It registers only `propose_action`, `list_capabilities`, and minimal `get_receipt`. Proposal creates a Card but cannot approve or execute. The OpenClaw reference config filters the server to those three tools and uses an exclusive global allowlist containing only their `bander__*` projected names. No shell, browser, web, messaging, Calendar, or direct downstream tool appears in the manifest.

The OpenClaw child environment is constructed from an allowlist. Model-provider keys may cross that boundary; mock-service, Calendar, and Messages credentials do not. The broker alone receives the generated mock-service token.

Observed against the running one-command local app:

```text
$ npm run openclaw -- config validate
Config valid: openclaw/reference.openclaw.json

$ npm run openclaw -- mcp doctor bander --probe
- bander: ok

$ npm run openclaw -- mcp probe bander --json
servers.bander.tools: 3
tools:
  bander__get_receipt
  bander__list_capabilities
  bander__propose_action
diagnostics: []

$ npm run check
Test Files  5 passed (5)
Tests       19 passed (19)

$ npm audit --audit-level=high
found 0 vulnerabilities
```

The official OpenClaw probe needed permission to open the loopback endpoint outside Codex's restricted network sandbox. The same endpoint also passed a direct MCP SDK initialize, tool-list, and tool-call integration test.

## Checkpoint 6 — optional GPT-5.6 candidate compiler

**Status:** verified without an API key; live model call pending key configuration

Codex checked the current official OpenAI model and Structured Outputs documentation, then pinned the official OpenAI JavaScript SDK `6.46.0`. The optional selector uses the Responses API with the `gpt-5.6` alias, Zod-backed strict Structured Outputs, no response storage, a ten-second timeout, and one retry.

The model can select only one of three versioned local fixture IDs or return `unsupported`; it cannot supply effect fields. Deterministic code copies the selected fixture, preserves the agent's exact claimed request for provenance, resolves live seeded resources, validates preconditions, and creates the canonical Draft. Clarification, refusal, an unsupported request, timeout, or malformed/no parsed output creates no Draft and grants no authority.

The compiler object is constructed only when `OPENAI_API_KEY` is non-empty. Without it, `/api/compiler/proposals` returns `model_compiler_not_configured`, while every fixture route, test, attack, and one-command judge flow remains available. The current environment has no key, so no live paid API request was attempted.

```text
$ npm run check
Test Files  6 passed (6)
Tests       22 passed (22)

No-key compiler route: 503 model_compiler_not_configured
Deterministic proposal: available and independent of compiler
```

## Checkpoint 7 — consumer and recording-path refinement

**Status:** in progress

Codex visually inspected the welcome, one-time, and standing-Band Cards in the real built app. The interface remains a calm consumer flow rather than a security dashboard. Standing authority now has a visible “Turn off this Band” control; the real-process verifier proves that an eligible action after revocation returns `standing_band_inactive`. A standing proposal is also single-use: its lifecycle changes from `proposed` to `approved`, and replay cannot mint a second active Band.

When `OPENAI_API_KEY` is configured, the welcome screen now reveals a small natural-language GPT-5.6 entry point. It remains absent in canonical no-key mode. Recording shortcuts can open `?scenario=exact`, `?scenario=conflict`, or `?scenario=standing` without bypassing the corresponding broker flow.

```text
$ npm run verify:demo
exact:             executed
changedWorld:      conflict
agentConflict:     conflict
standingEligible:  executed
standingAdjacent:  review_required
standingRevoked:   standing_band_inactive
```

The recording plan and live submission checklist now exist under `docs/`. `/feedback` is deliberately deferred until the recording and submission package are closer to final, per the builder's direction.
