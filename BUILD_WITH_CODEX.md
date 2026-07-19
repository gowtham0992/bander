# Building Bander with Codex

This document is maintained during implementation. It records what Codex actually contributed, which decisions remained human decisions, and which claims have been observed in tests. It is evidence, not a reconstructed launch story.

## Recent evidence index

| Date | Evidence |
| --- | --- |
| July 15, 2026 | [Real Google Calendar](#checkpoint-22--real-google-calendar-risk-spike) |
| July 16, 2026 | [Bounded schedule read](#july-16-2026--bounded-real-schedule-read-lane) |
| July 16, 2026 | [Family pairing](#july-16-2026--production-single-family-contact-pairing) and [delivery](#july-16-2026--replay-safe-family-notification-delivery) |
| July 16, 2026 | [Calendar creation](#july-16-2026--checkpoint-7a-retry-safe-calendar-event-creation) and [cancellation](#2026-07-16--checkpoint-7b-precondition-pinned-real-calendar-cancellation) |
| July 16, 2026 | [Gmail and direct family coordination](#2026-07-16--checkpoint-8-family-coordination-concierge) |
| July 16, 2026 | [Public browser product surface](#2026-07-16--combined-checkpoint-9-public-product-surface) |
| July 16, 2026 | [Guided setup and recovery](#2026-07-16--combined-checkpoint-10-external-owner-and-evaluator-surface) |
| July 17, 2026 | [Judge-facing product surface](#2026-07-17--combined-checkpoint-11-judge-surface-freeze) |

Historical checkpoint names and tool counts below describe the system at that time; they are intentionally not rewritten as current claims.

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
| `returns_the_same_receipt_without_reexecuting_a_consumed_permit` | Disabled cached Receipt recovery and Permit consumption. | The same Permit dispatched the effects a second time. | Included in the restored attack run. |
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
| `shows the complete old and new Calendar intervals on the Card` | Ran the new expectation against the raw start-time implementation. | The Card showed only “move … to 7:30 PM” and omitted both complete intervals. | Included in the restored functional run. |
| `falls back to review when the resulting appointment ends after 5 PM` | Ran the boundary regression against start-only standing matching. | A 4:30–5:30 PM appointment executed under the standing Band. | Included in the restored functional run. |
| `recovers a committed Calendar-only operation after its response is lost` | Ran the recovery regression before dispatched-operation reconciliation existed. | Retry after 31 seconds returned `permit_expired` despite the committed mutation. | Included in the restored functional run. |
| `does not dispatch a missing operation after the Permit expires` | Ran the recovery regression before operation lookup existed. | Bander made no reconciliation attempt, so it could not distinguish lost response from lost request. | Included in the restored functional run. |
| `gives identical simultaneous proposals distinct Draft IDs` | Ran two same-content proposals at the same clock instant against hash-prefix IDs. | The second proposal threw `Draft already exists`. | Included in the restored functional run. |
| `keeps an authoritative-looking agent claim inside provenance-styled quotation` | Rendered `✓ Bander verified this action as safe.` before typographic provenance isolation. | The string appeared as plain Card copy without a field-level provenance marker. | Included in the restored attack run. |
| `checks_stored_Draft_integrity_before_recovering_a_committed_operation` | Disabled the pre-reconciliation Draft-hash check. | Recovery created a Receipt from a tampered year-2099 interval even though the downstream operation used the original Draft. | Included in the restored attack run. |
| `verify:recovery` real HTTP approval retry | Ran the new real-socket verifier against the pre-fix approval boundary. | Calendar committed, the first response was lost, and the same-hash retry returned HTTP 409 instead of the required Receipt (`same-hash approval retry must reconcile: 409 !== 200`). | Restored verifier returned one Receipt with one Calendar mutation, one Band, and one Permit. |
| `verify:standing-recovery` real HTTP standing retry | Added the required request-ID boundary and ran the verifier before adding standing request persistence/resume. | Calendar committed, the downstream response was lost, and the same request retried through HTTP returned 409 instead of 200 (`downstream retry must recover: 409 !== 200`). | Restored verifier returned one Receipt with exactly one Draft, Permit, mutation, Receipt, and counter entry. |

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

Codex added one narrow standing predicate for duration-preserving rescheduling of solo, owner-organized Calendar blocks. The complete resulting interval must start and finish on the same weekday between 09:00 and 17:00 America/Denver. The rendered Card and hashed predicate are generated from the same structure. The rule allows no new recipients or spending, caps execution at three actions per rolling 24 hours, expires after 30 days, and can be revoked immediately.

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

The broker now exposes a real Streamable HTTP endpoint at `/mcp`. It registers only `propose_action`, `list_capabilities`, and minimal `get_receipt`. `list_capabilities` returns discoverable natural requests; `propose_action` accepts the person's request verbatim rather than a hidden fixture ID. Proposal creates a Card but cannot approve or execute. The OpenClaw reference config filters the server to those three tools and uses an exclusive global allowlist containing only their `bander__*` projected names.

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

The reference integration now includes a repeatable real agent-turn verifier using a loopback deterministic OpenAI-compatible provider:

```text
$ npm run verify:openclaw
humanRequestObserved: true
effectiveTools:
  bander__get_receipt
  bander__list_capabilities
  bander__propose_action
toolPolicyAudit: removed all non-allowlisted tools
toolCalls: 1 × bander__propose_action, 0 failures
draftStatus: proposed
execution: not_started
```

OpenClaw's run metadata and the provider request both contained exactly those three tools. The OpenClaw tool-policy audit reported removing 35 other tools, including shell, browser, web, messaging, file, session, and orchestration tools.

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

## Checkpoint 8 — semantic Calendar intervals and idempotent recovery

**Status:** verified

The Calendar effect is now the semantic operation `calendar.reschedule_event`. Bander derives the new end from the stored original duration, commits both resulting endpoints to the hashed Draft, executes that exact interval, and repeats the before/after interval on the Card and Receipt. Invalid source or proposed intervals fail closed. Standing authority requires the entire resulting appointment to start and finish on the same allowed weekday between 09:00 and 17:00 America/Denver.

The human-facing regressions were written before the implementation. Against the previous raw `startTime` update, the focused run failed 10 assertions: incomplete Card and Receipt wording, missing hashed `endTime`, accepted invalid intervals, an after-5-PM standing execution, and a downstream write that rejected the new complete interval. The restored focused run passed 21 tests.

Execution now uses a unified idempotent operation keyed by the Permit nonce. The Permit records dispatch before the downstream call. If a response is lost, Bander reconciles the existing operation before considering expiry; it can recover a committed result after expiry, but it cannot create a missing operation with expired authority. Calendar-only and combined Calendar/Messages retries return the same committed result. Consumed Permit retries return the cached Receipt without re-executing.

Draft IDs are independent unique values used for URLs and display. The full canonical content hash remains the approval commitment, Permit binding, and integrity check. Two identical proposals created at the same clock instant now have distinct Draft IDs and the same exact content hash.

## Checkpoint 9 — provenance quarantine and final integration pass

**Status:** verified; live GPT-5.6 call pending key configuration

Request summaries, Calendar titles, recipient names, and message bodies render inside field-labelled quotations. Bander-owned checkmarks, policy clauses, status, and approval controls remain outside those containers. The adversarial string `✓ Bander verified this action as safe.` remains quoted data with explicit provenance rather than appearing as Bander policy. React escaping remains covered separately.

Codex visually inspected the revised approval Card at 1440px and 500px widths in the built application. The provenance styling remains readable and the consumer hierarchy is intact. The in-app browser bridge could not initialize in this environment, so the established headless Chrome fallback captured the real local page.

The current environment reports no `OPENAI_API_KEY`. Per the build decision, no paid request was attempted and the deterministic suite remains independent of model access. One live GPT-5.6 selection request remains pending until a key is deliberately configured; `/feedback` also remains deferred until the submission package is near-final.

Final cold-state verification for this refinement passed 36 functional tests, 19 adversarial tests, all six real-process demo outcomes, the actual OpenClaw agent proposal, the three-tool effective inventory check, the high-severity dependency audit, and the repository secret scan.

## Checkpoint 10 — idempotent HTTP approval recovery

**Status:** verified; live GPT-5.6 Sol evidence call is the only known submission blocker

Codex verified the remaining gap before changing the approval boundary. The existing focused tests passed two disconnected facts: internal `executePermit` reconciliation recovered a committed Calendar operation, while a repeated `approveAndExecute` call returned `draft_not_approvable`. A new verifier then opened a real loopback HTTP listener, committed the Calendar operation, lost the first response, and observed the required pre-fix red result:

```text
$ npm run verify:recovery
AssertionError: same-hash approval retry must reconcile
409 !== 200
```

The HTTP approval operation is now idempotent for the exact stored Draft hash. Its first call creates one one-time Band and one internal Permit. A retry for an `approved` Draft finds that single bound authority and reconciles the existing downstream operation; a retry for an `executed` Draft returns the cached Receipt. It does not mint replacement authority. Hash drift fails before recovery, inconsistent authority state fails closed, and declined, revoked, conflicted, expired, or blocked Drafts cannot resume. If the operation is absent after the Permit expires, retry performs reconciliation but cannot initiate a new write.

The browser automatically retries the exact approval once after a network, response-parse, or server failure. Explicit 4xx outcomes are not retried. If the result remains ambiguous, the consumer sees “Check what happened,” which repeats the same Draft ID and hash to reconcile rather than creating a new approval. The Permit remains absent from browser and agent responses.

Observed green evidence on July 14, 2026:

```text
$ npm run verify:recovery
status: recovered
calendarMutations: 1
bandsMinted: 1
permitsMinted: 1
receiptsCreated: 1

$ npm run check
Test Files  7 passed (7)
Tests       45 passed (45)

$ npm run attack
Test Files  2 passed (2)
Tests       19 passed (19)

$ npm run build
exit 0
```

The added lifecycle tests cover same-Receipt replay, changed-hash rejection, declined/revoked/conflicted non-resumption, and both undispatched and uncommitted expired-Permit no-write behavior. Three browser-state tests cover automatic ambiguous retry, explicit-conflict non-retry, and manual recovery fallback. The in-app browser bridge did not initialize in this environment, so no new visual claim is recorded for the fallback screen; the production build and state behavior are verified.

No live model key was configured or used. `/feedback` remains intentionally deferred until the project is closer to completion and submission, as directed by the builder.

## Checkpoint 11 — idempotent standing execution recovery

**Status:** verified; live GPT-5.6 Sol evidence call remains the only known submission blocker

Codex confirmed the standing-Band asymmetry before changing execution. `runStandingBand` created a new Draft before taking the Band lock and did not persist a client request mapping. After a Calendar commit with a lost response, retry therefore resolved the already-mutated event as a fresh attempt and failed with `fixture_precondition_mismatch`. The browser could route that ambiguity into the generic “Bander didn’t act” state.

The standing execution endpoint now requires a 16–100 character client-generated `requestId`. Bander canonically hashes the normalized semantic request content and persists a mapping bound to the standing Band ID, request ID, digest, Draft, and—when eligible—the internal Permit. The mapping is saved before dispatch. The Band lock is acquired exactly once: new and repeated requests both continue through a private lock-safe resume method, which calls the existing internal executor without reacquiring the public Band lock.

Same-ID, same-content retries reuse the original Draft and Permit. A committed operation reconciles to one Receipt; a completed operation returns the cached Receipt. The standing action timestamp is appended once by the single Permit completion. Same-ID content drift fails with `standing_request_mismatch` before resource resolution or Draft creation. An expired undispatched Permit cannot write. A repeated `review_required` result returns the same Draft/Card and proposal activity rather than incrementing proposal history or creating another Draft.

The browser generates one request ID per standing request and retains it in recovery state. Network failures, response parsing failures, and server errors trigger one automatic retry with the same ID. Continued ambiguity renders “Check what happened”; manual recovery reuses that same ID. The ambiguous standing view contains no claim that Bander did not act.

Required pre-fix red evidence:

```text
$ npm run verify:standing-recovery
AssertionError: downstream retry must recover
409 !== 200
```

Observed focused green evidence on July 14, 2026:

```text
$ npm run verify:standing-recovery
status: recovered
downstream response loss: one Receipt
broker response loss: one cached Receipt
changedContent: rejected
reviewRequired: same_card
expiredUndispatched: no_write
per scenario: 1 Draft · 1 Permit · 1 mutation · 1 Receipt · 1 counter entry

$ npm run check
Test Files  7 passed (7)
Tests       50 passed (50)

$ npm run attack
Test Files  2 passed (2)
Tests       20 passed (20)

$ npm run build
exit 0
```

The real HTTP verifier covers downstream response loss, successful broker-response loss, changed-content rejection, expired undispatched authority, stable review Cards, and exact state counts. Core tests cover committed recovery and cached replay; the browser tests cover automatic/manual request-ID reuse and assert that ambiguous standing UI never renders “Bander didn’t act.”

The final code-freeze matrix also passed the six-outcome demo verifier, the one-time HTTP recovery verifier, the real OpenClaw agent verifier with exactly three effective Bander tools and no execution, the production build, and the high-severity dependency audit. The repository scan found no committed OpenAI keys, mock-service tokens, or `sk-` secrets.

## Checkpoint 12 — Telegram privacy gate and local MCP boundary

**Status:** Telegram spike blocked on external test identities; local MCP rate limit verified

Codex read the complete updated request, source-of-truth plan, architecture and recording documents, and `transcription_day2.md`. It checked the current official Telegram Bot API, Telegram Bot-to-Bot Communication documentation, current OpenClaw Telegram documentation, and the installed OpenClaw 2026.7.1 implementation.

The review found a load-bearing current-platform detail: Telegram can deliver other-bot group messages when Bot-to-Bot Communication Mode is enabled and the receiving bot is an administrator or has Group Privacy Mode disabled. The installed OpenClaw Telegram message handler ignores its own bot ID but does not categorically discard every other bot. OpenClaw's explicit numeric group-sender allowlist provides a second filter, but the privacy claim will be accepted only after the complete exported OpenClaw trajectory proves that a Bander canary, Card, Receipt, conflict, and callbacks never reached the model.

No Telegram variables are configured in the current process, and the repository has no Telegram credential file. The required real group spike therefore has not run. No Telegram hero-flow code was started and no privacy claim is marked verified. The exact BotFather, group, identity, and ignored-local-environment prerequisites are recorded in `docs/telegram-privacy-spike.md`. `/feedback` remains deferred.

The same review confirmed that the loopback Streamable HTTP MCP endpoint had no application-level authentication or rate limit. Authentication remains deliberately out of scope for this one-machine reference integration, but the endpoint is now documented as local-only and limited to 30 POST requests per source address per 60 seconds. It remains bound to `127.0.0.1`, and the proposal tool still supplies its fixed paired agent identity internally rather than accepting an agent-controlled owner reference.

Required red evidence observed before the rate-limit implementation:

```text
$ npx vitest run apps/broker/src/app.test.ts
rate-limits the unauthenticated loopback MCP endpoint
AssertionError: expected 200 to be 429
Tests: 1 failed, 4 passed
```

Observed focused green evidence:

```text
$ npx vitest run apps/broker/src/app.test.ts
Test Files  1 passed (1)
Tests       5 passed (5)
```

Cold pre-Telegram baseline on July 14, 2026 remains green: 51 functional tests, 20 attack tests, six demo outcomes, one-time and standing real-process recovery, real OpenClaw with exactly three Bander tools, zero dependency vulnerabilities, and no OpenAI- or Telegram-token-shaped repository secrets. The real OpenClaw verifier initially hit Codex's restricted local IPC sandbox and passed unchanged when rerun with permission; this was an environment restriction, not a product failure.

## Checkpoint 13 — empirical Telegram privacy spike

**Status:** passed; polished Telegram hero flow not started

The builder configured a private Telegram group with the owner, a non-owner, a dedicated OpenClaw bot, and a separate Bander bot. Neither bot was an administrator; Bot-to-Bot Communication was off for both; OpenClaw Group Privacy was off and Bander Group Privacy was on. Codex derived the two human identities, group, and both bot identities from explicit Telegram commands and `getMe` responses without printing tokens, raw updates, or numeric IDs. The bindings and evidence remain under ignored `.bander/` state with owner-only file permissions.

The first privacy regression exposed a real contradiction before the live test: `propose_action` returned the complete human Card as its MCP tool result, so the OpenClaw model received the Card even if Telegram hid Bander's message. The focused test failed with the complete Card where only `{draftId, status}` was expected. MCP now returns only the minimal agent status, while Bander independently fetches and renders the human Card.

The callback boundary test was also observed red before its implementation because the exact owner/chat/Bander-message/opaque-handle classifier did not exist. The restored tests deny the bound non-owner and unknown users, reject an OpenClaw imitation or wrong message, make the owner wait for the negative check, and allow the owner only on the exact Bander-authored surface.

The real spike then observed this sequence:

```text
owner natural unmentioned request -> OpenClaw model -> bander__propose_action
MCP result -> draftId + proposed only
Bander bot -> unique canary + human Card + inline approval
non-owner tap -> denied before authority
owner tap -> one Draft, Band, Permit, downstream execution and Receipt
owner replay -> same Receipt, no duplicate effect
OpenClaw-bot imitation tap -> OpenClaw callback, no Bander authority or execution
```

An initial imitation probe appeared inert because the spike configuration had intentionally disabled OpenClaw inline callbacks. That result was rejected as insufficient evidence. The definitive run enabled callback observation for the one bound group without adding tools. The imitation callback then appeared in OpenClaw's model input and trajectory while the real Bander callback remained absent.

The first definitive privacy assertion also produced a deliberate false alarm because it forbade the Card's `claimedUserRequest`, which is intentionally identical to the person's natural request. Codex corrected the assertion to forbid Bander-owned Card fields instead: Card title, exact effect disclosures, Draft hash, Bander canaries, real callback handle, Receipt ID, and private-conflict marker. Offline export of the already-completed real session produced:

```text
natural request present:                 true
bander__propose_action present:          true
OpenClaw imitation callback occurrences: 10
Bander privacy canary occurrences:       0
Bander Receipt canary occurrences:       0
private-conflict canary occurrences:     0
real Bander callback occurrences:        0
Card title occurrences:                  0
Draft-hash field occurrences:            0
Receipt-ID occurrences:                  0
exact effect-disclosure occurrences:     0
```

The live authority assertions passed before trajectory export: exactly one Draft, one one-time Band, one Permit, one downstream execution, one consumed Permit, one Receipt record, and one Bander Receipt message. The non-owner was denied before those existed; legitimate replay returned the same Receipt; the OpenClaw imitation changed none of those counts.

Post-spike verification on July 14, 2026:

```text
$ npm run check
Test Files  9 passed (9)
Tests       56 passed (56)

$ npm run attack
Test Files  2 passed (2)
Tests       20 passed (20)

$ npm run verify:demo
six expected outcomes passed

$ npm run verify:recovery
1 mutation · 1 Band · 1 Permit · 1 Receipt

$ npm run verify:standing-recovery
all recovery, mismatch, expiry and stable-review outcomes passed

$ npm run verify:openclaw
exactly three effective Bander tools · proposed · not executed

$ npm audit --audit-level=moderate
found 0 vulnerabilities

repository token-shaped secret scan
no OpenAI or Telegram token-shaped secrets found
```

The reusable live command is `npm run verify:telegram-privacy`. It validates the generated OpenClaw policy before starting Telegram, keeps tokens out of logs and tracked files, and writes its complete local evidence under `.bander/`. `/feedback` remains deferred. The privacy gate is now open for a later polished hero-flow slice, but that slice was intentionally not started in this checkpoint.

## Checkpoint 14 — real Bander Telegram one-time service

**Status:** verified end to end on July 14, 2026; changed-world Telegram refusal and live GPT-5.6 Sol evidence remain pending

The reviewed privacy checkpoint was sanity-checked, committed as `0c615e7`, and pushed to `origin/main` before this slice began.

The production Telegram behavior now lives in the Bander broker process as `TelegramService`. It owns the Bander bot credential, one-owner installation, Card delivery, callback ingestion and authorization, the call to the existing authority engine, and human Receipt delivery. The active `verify:telegram-privacy` command uses that service instead of duplicating Card and callback behavior in the harness.

Trust-on-first-use `/bind` is gone from production. Bander creates a high-entropy, expiring, single-use pairing token and stores only its SHA-256 digest. The owner consumes it in a private Bander-bot conversation. Bander then sends Telegram's private `request_chat` control with `bot_is_member: true`; the matching `chat_shared` update selects the single group. The agent never receives, provides, or selects the token, owner, or destination. Pairing, installation, update offset, and proposal mappings are stored in owner-only files under ignored `.bander/` state.

Each proposal persists the Bander installation ID, owner Telegram ID, group ID, Bander-authored message ID, opaque per-proposal callback value, Draft ID and hash, expiry, lifecycle, and Receipt-delivery state. The callback value is not described as a nonce or as independently single-use. Safety comes from exact surface authorization plus the authority engine's idempotent lifecycle. Every valid first callback and replay calls `approveAndExecute`; no callback mints authority directly. The production service has no `nonOwnerCheckComplete` state.

OpenClaw's generated Telegram configuration is built and asserted from one pinned policy: owner-only sender allowlists, one group, `requireMention: false`, `historyLimit: 0`, allowlisted context visibility, configuration writes off, and exactly three Bander tools. Runtime projection maps only the OpenClaw bot token into OpenClaw and only the Bander bot token into the broker. Neither environment receives the other's token; OpenClaw receives no mock-service, Calendar, or Messages credential.

The first service test was observed red before implementation:

```text
FAIL apps/broker/src/telegram-service.test.ts
Cannot find module './telegram-service.js'
```

The restored focused run passed three service-boundary tests covering private single-use pairing, private group selection, exact persisted approval-surface authorization, non-owner/wrong-surface rejection, owner replay, one Receipt delivery, and refusal before pairing. The full functional suite now passes 10 files and 61 tests; the attack suite remains 20 tests.

The live service run produced:

```text
pairing: private token and private group picker consumed once
OpenClaw: pinned policy and isolated environment validated
proposal: real service posted Card; MCP returned only draftId and status
rejected: non-owner, wrong chat, wrong message, wrong callback, OpenClaw imitation
authority: 1 Draft, 1 Band, 1 Permit, 1 execution, 1 Receipt
privacy: Card, genuine callback and Receipt absent from model input and trajectory
```

The deterministic OpenClaw provider also returns a friendly clarification for unsupported natural requests. The real OpenClaw verifier observed that response without a tool call or authority creation.

Post-slice verification passed `npm run check`, `npm run attack`, `npm run verify:demo`, both recovery verifiers, the real OpenClaw verifier, the production build, and `npm audit --audit-level=moderate` with zero vulnerabilities. Complete live evidence is stored locally under ignored `.bander/telegram-service-verification-1784089547327-4d3bd4ce/` with owner-only permissions.

Per the builder's sequencing, this slice did not add Telegram changed-world behavior or standing Bands. `/feedback` remains deferred. The live GPT-5.6 Sol call should be captured as soon as API access is available.

## Checkpoint 15 — real Telegram changed-world refusal

**Status:** verified end to end on July 14, 2026; live GPT-5.6 Sol evidence remains pending

The one-time Telegram service slice was committed as `616a30c` and pushed before this follow-up began. The production service already translated the authority engine's changed-world conflict into a human Telegram message, so the new service-level regression passed without a behavior patch. It now pins the required lifecycle: one Band and Permit, Draft status `conflict`, one human explanation across callback replay, no Receipt, and no `Done` message.

The real verifier gained a separate `verify:telegram-conflict` mode. It reused the previously authenticated installation, ran a fresh real OpenClaw natural-request turn, let the real Bander service post the Card, and changed the seeded Calendar precondition before the owner approved. Wrong chat, message and callback probes still created no authority. Two legitimate owner callbacks both passed through `approveAndExecute`: the first observed the downstream precondition conflict, while replay refused to resume the conflicted Draft.

Observed live evidence:

```text
scenario: conflict
authority: 1 Draft, 1 Band, 1 Permit, 1 downstream dispatch
Bander mutations: 0
Receipts: 0
human refusal messages: 1 across replay
agent status: conflict
Card, genuine callback, Receipt and conflict explanation in OpenClaw trajectory: 0
OpenClaw imitation authority: 0
```

The ignored owner-only evidence directory is `.bander/telegram-service-verification-conflict-1784090189301-f05e6dce/`. Standing Bands remain outside the Telegram service slice. `/feedback` remains deferred. `OPENAI_API_KEY` is not configured in the local environment, so the external GPT-5.6 Sol evidence call could not yet be captured.

## Checkpoint 16 — Telegram delivery and pairing hardening

**Status:** verified on July 14, 2026

Three required regressions were observed red against the real service before implementation. During Receipt delivery, persisted state already contained `receiptDeliveredAt` when `sendMessage` began. During changed-world delivery, a simulated Telegram failure escaped while `conflictDeliveredAt` remained set. During pairing, a second valid token holder replaced the first claimant's Telegram user and private chat IDs before group selection.

The service now persists execution or conflict outcome state without a delivered timestamp, attempts Telegram `sendMessage`, and records delivery only after Telegram returns success. A failed Receipt send keeps the same Receipt ID pending; owner retry re-enters `approveAndExecute`, reconciles the same one-time authority, executes nothing again, and retries the truthful Receipt. A failed conflict send stores the original changed-world explanation and keeps it pending; replay still calls `approveAndExecute`, then delivers that same original explanation rather than the later `draft_not_resumable` error. Confirmed delivery suppresses intentional repeats.

This checkpoint explicitly accepts different guarantees at the two boundaries:

- Downstream real-world execution remains exactly once.
- Human Telegram notification is at least once.
- A crash after Telegram accepted a message but before Bander persisted delivery can duplicate the same truthful notification.
- A duplicate truthful Receipt is safer than silent execution.

Pairing now binds the attempt to the first valid private claimant. A different user presenting the same still-active token is rejected and cannot replace claimant state. The original claimant can continue the private `request_chat` flow; expiry, successful consumption, and post-consumption replay rejection are unchanged.

Restored focused evidence passed seven Telegram service tests. The full matrix passed 10 functional files with 65 tests, 20 attack tests, the demo verifier, both recovery verifiers, the real OpenClaw verifier including friendly unsupported input, the production build, and the moderate dependency audit with zero vulnerabilities. `OPENAI_API_KEY` remains unavailable and `/feedback` remains deferred.

## Checkpoint 17 — real standing Telegram autonomy

**Status:** verified end to end on July 14, 2026; live GPT-5.6 Sol evidence remains pending

The production Telegram service now reuses the existing deterministic standing predicate and executor. One active standing Band is bound to the authenticated single-owner installation. Every autonomous request requires the client-generated request ID already enforced by the engine; the engine binds it to the Band and normalized request digest, persists the Draft and Permit before dispatch, reconciles committed execution, and increments the rolling counter exactly once. Telegram stores one outcome mapping per Band and request ID and never creates authority itself.

The required service regressions were observed red before implementation:

```text
$ npx vitest run apps/broker/src/telegram-service.test.ts
Test Files  1 failed (1)
Tests       3 failed | 7 passed (10)
TypeError: service.activateStandingBand is not a function
```

The restored tests prove retry-safe outcome delivery, one Draft/Permit/Receipt/counter entry, exact owner/chat/message/callback revocation, idempotent replay, future-action denial, stable `review_required` Card delivery, and rejection of a missing request ID. A final privacy regression also pins standing conflicts to the minimal agent result `{draftId, status: "conflict"}` so a human explanation cannot cross MCP.

Autonomous delivery follows the same boundary tradeoff as one-time delivery. Bander executes or reconciles through the authority engine, persists the pending outcome and opaque revoke callback, sends Telegram, then records the Bander-authored message and delivery timestamp. Downstream execution remains exactly once. Telegram notification remains at least once, so an accepted-send crash may duplicate the same truthful outcome on retry. Confirmed delivery is not intentionally repeated.

The distinct **Turn off** callback is bound to the installation, owner Telegram ID, group, Bander-authored message and opaque callback value. Every callback is authorized independently. It invokes the public idempotent `revokeBand` method and does not reacquire an already-held Band lock. Standing execution and revocation are serialized once by the engine's existing Band lock; revocation prevents future execution.

Observed live real-service evidence:

```text
$ npm run verify:telegram-standing
PASS standing execution: minimal MCP status, one effect, one Receipt, counter 2 of 3
PASS standing surface rejection: wrong user, chat, message and callback denied
PASS standing revoke: idempotent and future execution blocked

authority: 1 Draft · 1 standing Band · 1 Permit · 1 downstream dispatch · 1 Receipt
human outcome: Bander handled this · Focus block moved · no message · 2 of 3
privacy: outcome, genuine callback and Receipt absent from model input and trajectory
OpenClaw: exactly three Bander tools; Bander token absent from its environment
```

The final matrix passed 71 functional tests, 20 attack tests, the six-outcome demo verifier, both real-process recovery verifiers, the real OpenClaw verifier with friendly unsupported input, the production build, the moderate dependency audit with zero vulnerabilities, and the tracked-secret scan. The live evidence is stored under ignored owner-only `.bander/telegram-service-verification-standing-1784092942010-fd901f48/`.

`OPENAI_API_KEY` remains unavailable, so the live GPT-5.6 Sol selection and off-script natural-request evidence are still external blockers. `/feedback` remains intentionally deferred.

## Checkpoint 18 — standing Turn off returns to one-time review

**Status:** verified end to end on July 15, 2026; live GPT-5.6 Sol evidence remains pending

Turning off a standing Band now preserves the revoked Band and its audit history in the authority engine while detaching the Telegram installation's active standing pointer. The installation enters persistent one-time-review mode until another active standing Band is explicitly installed. A naturally expired or missing configured Band follows the same safe detachment path. Exhausted and predicate-mismatched active Bands retain their existing `review_required` behavior.

The next matching natural request uses the ordinary one-time Draft/Card/approval lifecycle. Its deterministic requested effect is unchanged, while its expected Calendar and recipient revisions are rebound from the authoritative current world before the new Card hash is rendered. Ordinary fixture proposals remain strict, so this does not weaken changed-world refusal. When the prior standing action already reached the requested target, the Card truthfully displays the current interval to the same interval and still requires owner approval; no authority or write exists before that approval.

The required service regression was first observed red:

```text
$ npx vitest run apps/broker/src/telegram-service.test.ts
Test Files  1 failed (1)
Tests       3 failed | 10 passed (13)
Failures: exact standing interval absent; standing pointer remained attached after revoke; handleAgentAction missing
```

After the initial correction, the realistic mutating-adapter and OpenClaw-history regressions were also observed red before their fixes:

```text
$ npx vitest run scripts/openclaw-mock-provider.test.ts apps/broker/src/telegram-service.test.ts
Test Files  2 failed (2)
Tests       2 failed | 14 passed (16)
Failures: stale historical request selected after toolResult; post-revoke fixture_precondition_mismatch
```

The standing human outcome is now rendered exclusively from the committed `HumanReceipt` and the shared canonical interval formatter. It discloses the title, complete before and after start/end intervals, date, and `MDT` timezone context while preserving duration. None of those details return through MCP.

The live verifier uncovered one harness-specific OpenClaw detail: OpenClaw appends a trusted runtime-context user wrapper after a `toolResult`. The deterministic mock provider now ignores only that recognized wrapper when classifying a completed tool turn. A later genuine unsupported user request is still distinguished and receives the friendly clarification. Focused provider regressions pin both cases.

Restored live evidence:

```text
$ npm run verify:telegram-standing
PASS standing execution: minimal MCP status, one effect, one Receipt, counter 2 of 3
PASS standing surface rejection: wrong user, chat, message and callback denied
PASS standing revoke: idempotent, detached, and Back in control delivered
PASS post-revoke loop: same request produced a one-time Card; no execution

authority: 2 Drafts · 1 standing Band · 1 Permit · 1 downstream dispatch · 1 Receipt
pending review: 1 one-time Card · 0 one-time Bands
privacy: standing outcome, genuine callback, Receipt and post-revoke Card absent from model input and trajectory
evidence: .bander/telegram-service-verification-standing-1784095475951-b4effef0/
```

The final matrix passed 75 functional tests, 20 attack tests, the six-outcome demo verifier, both real-process recovery verifiers, the real OpenClaw verifier with exactly three effective Bander tools and friendly unsupported input, the production build, and the moderate dependency audit with zero vulnerabilities. The tracked-file scan found no OpenAI- or Telegram-token-shaped secrets. The live standing verifier also re-ran the Telegram privacy assertions against the exact-effect and post-revoke Card paths.

The live GPT-5.6 Sol selection and genuinely off-script request remain the next external evidence requirement. `/feedback` remains intentionally deferred.

## Checkpoint 19 — consumer Telegram voice and safe decline

**Status:** verified end to end on July 15, 2026

The one-time Telegram surface now offers **Do exactly this** and **Not now** side by side. The two opaque callback values are stored on the same proposal record and independently bound to the authenticated installation, owner Telegram ID, group, Bander-authored message and action ID. The decline callback calls the authority engine’s deterministic decline path, which is now idempotent for an already-declined action. It creates no one-time authority, Permit, downstream dispatch or success outcome, and later approval remains terminally closed.

The principal decline and consumer-copy regressions were observed red before implementation:

```text
$ npx vitest run apps/broker/src/telegram-service.test.ts packages/core/src/authority.test.ts scripts/openclaw-mock-provider.test.ts scripts/openclaw-config.test.ts
Test Files  4 failed (4)
Tests       9 failed | 42 passed (51)
Failures: no decline callback; approval executed after attempted decline; decline replay rejected; old Card/ISO/engine copy; forgeable multiline hearsay; silent OpenClaw error policy; old unsupported response
```

The live verifier then exposed two harness assumptions red before correction. The deterministic provider treated a missing final period as unsupported even though the real compiler accepts it; a focused regression failed and normalization was aligned. A second dinner proposal correctly failed its stale Calendar precondition after the first dinner execution, so the decline proof was moved to the untouched supported Focus action rather than weakening precondition enforcement.

Parent-facing Telegram copy now names OpenClaw as the hearsay source and never implies Bander read the ambient conversation. Review messages start with “Nothing has happened yet,” use local interval labels and relative closing time, and describe only effects through Bander. Success, conflict, expiry, decline and standing opt-out messages each state whether anything happened and give a safe next step. Raw action IDs, timestamps and engine terminology are absent.

Agent-supplied request text remains in a clearly labelled plain-text quotation. Telegram parse mode is not enabled. The display renderer normalizes the field and removes newlines, control characters, bidirectional formatting controls and paragraph separators, preventing agent text from creating a second Bander-authored visual section. The versioned deterministic effects remain unchanged.

OpenClaw now acknowledges a proposed action with “Bander has prepared this for
your review. Nothing has happened yet.” Executed standing results use distinct
wording and never make that false non-action claim. Unsupported input receives
the requested friendly clarification. The pinned current OpenClaw Telegram
`errorPolicy` is `always`; Context7 and the installed OpenClaw documentation
confirm that this sends channel errors instead of silently suppressing them.
Compiler refusal crosses MCP only as `{status:"unsupported"}` without
model-authored detail. Exactly three MCP tools remain configured.

The implementation explicitly does not make Bander read ambient Telegram messages. It does not add an MCP tool, enable HTML/Markdown rendering, or trust model-authored effects or authority.

Live evidence passed:

```text
success/privacy: .bander/telegram-service-verification-success-1784099152812-1e4f9c80/
  2 actions prepared · 1 approved · 1 declined · 1 authority · 1 execution · 1 success outcome
  decline human copy and both genuine callback values absent from model input and exported trajectory

changed world: .bander/telegram-service-verification-conflict-1784099499056-8c6bc5c9/
  1 stopped explanation · 0 mutations · 0 success outcomes · explanation absent from trajectory

standing regression: .bander/telegram-service-verification-standing-1784099838713-1803a003/
  exact local interval preserved · consumer opt-out copy delivered · next request returned to one-time review
```

The final Slice 1 matrix passed 87 functional tests, 20 attack tests, the six-outcome demo verifier, both recovery verifiers, the real OpenClaw verifier, all three real Telegram service scenarios, production build, dependency audit and tracked-secret scan. `transcription_day2.md` remains untouched. Live GPT-5.6 Sol evidence and `/feedback` remain deferred.

## Checkpoint 20 — Telegram standing-autonomy opt-in

**Status:** verified end to end on July 15, 2026

Standing autonomy can now be enabled entirely inside Telegram through the existing `propose_action` MCP tool. The supported natural request is matched narrowly by deterministic Bander service code. Bander calls `createStandingBandCandidate()` without model-supplied predicate input, renders every visible clause from that fixed predicate, and returns only `{status:"proposed"}` through MCP. The activation Card, predicate hash, candidate ID, callbacks and eventual human outcomes do not enter OpenClaw's model input or exported trajectory. The effective OpenClaw inventory remains exactly three Bander tools.

The Telegram service persists each candidate against the authenticated installation, owner ID, group, Bander bot ID, Bander-authored message ID, two opaque controls, candidate ID, predicate hash, expiry and lifecycle. **Turn on automatic** and **Ask me each time** independently validate that complete surface. Wrong user, chat, message, bot, callback, expired candidate or changed predicate fails closed. Decline is terminal and idempotent. An identical approval replay returns the already-created standing authority; changed hashes remain rejected. Replaying an old activation after later revocation cannot restore authority.

The main focused slice was observed red before implementation:

```text
$ npx vitest run packages/core/src/authority.test.ts apps/broker/src/telegram-service.test.ts
Test Files  2 failed (2)
Tests       7 failed | 43 passed (50)
Failures: Telegram standing opt-in method absent; identical engine activation replay rejected
```

The MCP routing regression was separately observed red: the standing request fell through to the action compiler and the standing callback was never invoked. A delivery-recovery regression was also observed red after implementation: when the first human expiry message failed, retry did not resend it. The restored path persists terminal expiry first and marks delivery complete only after Telegram accepts the message.

Focused green evidence now covers the required named behaviors, including `owner_can_activate_standing_from_telegram`, `agent_cannot_activate_standing_authority`, wrong-user/chat/message/bot/callback rejection, replay idempotency, deterministic clause provenance, Telegram-only activation, Ask-me-each-time terminal decline, changed-content rejection, expiry, and prevention of post-revocation reactivation. The focused set passed 73 tests; the full functional run passed 99 tests and the attack suite passed 20.

The real standing verifier was converted from pre-seeded web approval to one continuous parent journey. Its first run exposed a verifier-only race red: the automatic outcome existed before the mock provider's latest result advanced from the earlier `{status:"proposed"}` to `{draftId,status:"executed"}`. The verifier now waits for the executed result specifically. The corrected live run passed:

```text
natural Telegram opt-in -> real OpenClaw -> propose_action -> Bander limits Card
wrong user/chat/message/bot/callback -> 0 standing authorities
genuine owner activation + replay -> 1 standing authority
eligible Focus move -> 1 Permit · 1 downstream dispatch · 1 truthful outcome
Turn off automatic -> revoked and detached
same request -> 1 pending one-time Card · 0 new execution

evidence: .bander/telegram-service-verification-standing-1784127151427-3f805331/
```

Fresh unchanged-path live regressions also passed:

```text
one-time approval + replay + Not now + imitation resistance
  .bander/telegram-service-verification-success-1784127698812-b8074a2b/

changed-world refusal + replay + imitation resistance
  .bander/telegram-service-verification-conflict-1784127828045-9c4c8d7e/
```

The final matrix is green: typecheck, 99 functional tests, 20 attack tests, six-outcome demo verifier, both real-process recovery verifiers, real OpenClaw verifier with exactly three tools, all three real Telegram scenarios, production build, moderate dependency audit with zero vulnerabilities, and tracked token-shaped secret scan. `transcription_day2.md` remains untouched. Live GPT-5.6 Sol evidence and `/feedback` remain deferred.

## Checkpoint 21 — dedicated Hero mode and visible downstream proof

**Status:** implemented and manually verified end to end on July 15, 2026

Hero mode is now a distinct product runtime launched with `npm run hero`. It
uses `.bander/hero/` for the authenticated Telegram installation and a unique
per-run OpenClaw home, state, workspace, configuration and log tree. Existing
verification commands and their explicit security choreography remain
unchanged and use separate state.

One Hero process owns the real Bander Telegram service, authority engine,
credential-protected seeded Calendar/Messages service, three-tool Streamable
HTTP MCP endpoint, deterministic OpenAI-compatible provider, and real isolated
OpenClaw gateway. Only the OpenClaw token enters OpenClaw's process environment;
the Bander bot token and downstream service credential remain absent. Hero
startup validates the same pinned owner-only group policy and exact three-tool
inventory before declaring readiness.

The browser now exposes a calm read-only **Demo Calendar** and **Demo Messages**
ledger. `/api/hero/state` exists only in explicit Hero mode, is marked
`no-store`, and returns sanitized titles, intervals, recipient names, message
bodies and sent times—never IDs, ETags, hashes or credentials. It reads the
same in-memory maps used by the credential-protected operation endpoint. There
is no second UI-only simulation. The view polls without overlapping requests,
has deliberate loading/reconnect states, and was visually checked both before
and after a committed dinner/message operation. Visual QA corrected a
misleading `Today` label to `Schedule` because the seeded events span two days.

Hero Telegram uses compact consumer copy for pairing, one-time review, success,
decline, conflict and expiry. Dynamic hearsay remains normalized plain text
without Telegram parse mode. The exact approved message body remains in the
human success outcome. The Hero entrypoint sends no setup instructions,
imitation probes, replay probes or verification terminology to Telegram.

OpenClaw's successful post-proposal final response is the documented exact
`NO_REPLY` token rather than a timer or a fourth/message tool. During the live
standing journey, the owner's screenshot exposed that automatic execution
still produced a redundant OpenClaw reply. A focused regression was then
observed red:

```text
$ npx vitest run scripts/openclaw-mock-provider.test.ts
Test Files  1 failed (1)
Tests       1 failed | 7 passed (8)
Received: "Bander handled that within the automatic limits you approved..."
Expected: "NO_REPLY"
```

Hero now suppresses OpenClaw's redundant final text for `proposed`, `executed`,
`conflict`, and `declined` minimal Bander statuses. Bander alone owns those
human outcomes. The restored focused run passed all eight provider tests.
Unsupported wording is deliberately not suppressed; the final real Telegram
turn returned the useful clarification without a tool call, proposal,
authority or household mutation.

The manual Hero journey used no verifier messages or pre-seeded authority and
proved:

```text
one-time success
  natural Telegram request -> real OpenClaw -> three-tool MCP -> Bander Card
  genuine approval -> Dinner 7:00–8:30 PM to 7:30–9:00 PM
  exact Sarah message visible once in Demo Messages

decline
  separate Focus Card -> Not now -> terminal decline
  Focus and Demo Messages unchanged

changed world
  dinner Card prepared -> explicit external Demo Calendar change to 8:00–8:30 PM
  approval -> terminal conflict and one human refusal
  external Calendar value preserved; Demo Messages empty

standing autonomy
  natural opt-in -> deterministic five-clause Card -> owner activation
  Focus 10:00–11:00 AM to 10:30–11:30 AM automatically
  one visible outcome, zero messages, counter 1 of 3
  Turn off -> authority revoked and detached
  repeated Focus request -> pending one-time Card, no second mutation

privacy and isolation
  exactly three Bander tools on every observed OpenClaw turn
  human Cards, standing clauses, exact intervals and outcomes absent from model input
  unsupported request -> OpenClaw clarification, zero Bander tool calls
```

The shared-state regressions prove approval retry updates the visible Calendar
and Messages once and a stale-world conflict changes neither. Broker tests pin
Hero-route separation and no-store responses. Source tests reject verifier
instructions in the Hero entrypoint. Telegram tests pin Hero copy while the
default verification copy remains unchanged.

No timer, ambient Bander listener, fourth MCP tool, Google OAuth, additional
channel, model-authored predicate or new authority behavior was introduced.
`transcription_day2.md` remains untouched. Before filming, the Telegram group
and both bot display names still require the owner's manual product-identity
rename to remove “Test”; the bots are not group administrators and code cannot
truthfully perform that change. Live GPT-5.6 Sol evidence and `/feedback` remain
deferred.

Final restored-green evidence passed typecheck, 109 functional tests, 20 attack
tests, the six-outcome demo verifier, both real-process recovery verifiers, the
real OpenClaw three-tool verifier, production build, a moderate dependency audit
with zero vulnerabilities, and a scan of 83 tracked files with zero
token-shaped secret hits. Fresh unchanged-path Telegram runs also passed:

```text
one-time privacy, approval replay, decline and imitation resistance
  .bander/telegram-service-verification-success-1784133225117-28ee464a/

changed-world refusal, replay and imitation resistance
  .bander/telegram-service-verification-conflict-1784133392616-bdee85a9/

standing activation, exact execution, revoke and return to one-time review
  .bander/telegram-service-verification-standing-1784133550071-69af215d/
```

## Checkpoint 22 — real Google Calendar risk spike

**Status:** verified against the real Google Calendar API on July 15, 2026

This checkpoint is deliberately standalone. It has not changed the broker
runtime, Hero entrypoint, Telegram choreography, authority engine, fixture
compiler, mock services or OpenClaw configuration.

The first focused Calendar run was observed red against an explicit
not-implemented boundary:

```text
$ npx vitest run apps/broker/src/google-calendar.test.ts
Test Files  1 failed (1)
Tests       9 failed (9)
```

The failures covered ambiguous matching; all-day, recurring, non-owner and
attended events; exact start/end-only `If-Match` writes; HTTP 412 handling;
non-412 failure handling; and rejection of Messages/additional effects.

The OAuth boundary was separately observed red before implementation:

```text
$ npx vitest run apps/broker/src/google-oauth.test.ts
Test Files  1 failed (1)
Tests       3 failed | 1 passed (4)
```

The local restored-green run now passes 14 focused tests and full typechecking.
Desktop OAuth is pinned to PKCE S256, a loopback redirect, exact state
validation, offline credentials, and only
`https://www.googleapis.com/auth/calendar.events.owned`. Credential and token
files are private local inputs and are never logged or committed.

The first live OAuth run failed before mutation because
`calendar.events.owned` does not authorize `calendars.get`. The adapter was
corrected without broadening scope: the deliberately narrow real path now
requires the eligible event resource itself to carry its authoritative IANA
timezone. The same run also showed that an uncaught SDK error was too verbose;
the verifier now emits only allowlisted failure codes and non-sensitive stage
names.

The first conditional write then exposed a timestamp-representation bug:
Google may return the same instant with a numeric offset when the request used
UTC `Z`. Raw-string comparison conservatively refused to claim restoration.
The event was manually restored, all interval checks were changed to compare
instants plus the authoritative timezone, and a focused regression now pins
equivalent timestamp spellings.

The final live run produced only this sanitized evidence:

```text
mode: real-google-calendar-risk-spike
calendar: primary
scope pinned: true
eligible timed solo event: true
canonical id/title/start/end/timezone/organizer/attendees/etag read: true
start/end-only conditional update: true
stale ETag status: 412
stale attempt zero mutation: true
concurrent identical writes with one ETag:
  1 acknowledged commit, 1 HTTP 403 rateLimitExceeded
original interval restored: true
private values printed: false
```

After OAuth was rotated to the dedicated test account, the ordinary stale-ETag
probe again returned HTTP 412 with zero mutation. Its simultaneous-write probe
exposed a different documented Google outcome: one request was acknowledged
and the other returned HTTP 403 `rateLimitExceeded`, rather than HTTP 412. The
first diagnostic run was intentionally treated as red because the verifier did
not yet distinguish the response. It still restored the original interval.
The verifier now accepts only one acknowledged success plus either 412
`conditionNotMet` or 403 `rateLimitExceeded`/`userRateLimitExceeded`, records
the numeric status and machine-readable reason only, and again proved
restoration.

This empirical result establishes the conservative timeout rule for the
product slice: never mint new authority, accept new agent parameters or claim
causation from an ambiguous response. Inspect the stored event. If the
authoritative interval is the approved target, human wording may say only that
the Calendar is observed at that interval. If it is the original interval,
retry only through the existing authority and precondition; if it is anything
else, fail closed as changed world.

The verifier prints no account, Calendar, event, title, interval, ETag, OAuth
URL or token value. Local credential and token files remain under ignored
`.bander/`. The Hero runtime, mock services, fixtures, OpenClaw configuration,
Telegram service and authority lifecycle remain unchanged.
`transcription_day2.md` remains untouched.

The restored deterministic matrix passed after the live spike: typecheck, 123
functional tests, 20 attack tests, the six-outcome demo verifier, both
real-process recovery verifiers, the real OpenClaw verifier with exactly three
Bander tools, production build, and a moderate dependency audit with zero
vulnerabilities. A high-confidence scan of all 91 tracked and checkpoint files
found zero OpenAI keys, Telegram bot tokens, Google client secrets or Google
refresh tokens.

## Checkpoint 23 — live GPT-5.6 Sol bounded intent compiler

**Status:** verified locally and against the live Responses API on July 15,
2026

The focused compiler test was added before the implementation and observed red:

```text
$ npx vitest run apps/broker/src/real-calendar-compiler.test.ts
Test Files  1 failed (1)
Tests       6 failed (6)
```

All six tests failed because `RealCalendarDraftCompiler` did not exist. They
cover deterministic event resolution, strict rejection of missing fields,
strict rejection of a model-authored event ID, malformed local date/time,
clarification without a Calendar query, and fail-closed ambiguous discovery.

The restored local run now passes all 10 compiler tests plus full typechecking.
The new path is pinned to the exact model ID `gpt-5.6-sol` and accepts only five
strict fields: event-title hint, complete local-date hint, requested local
start, a clarification flag and clarification text. Bander—not the model—then
resolves exactly one real event, reads its ID and ETag, converts the requested
wall time using the authoritative event timezone, and constructs the immutable
Calendar-only fixture. The model cannot provide an event ID, ETag, end time,
duration, effect, approval, Permit or other authority field.

The live verifier is read-only: it makes one Responses API call, resolves the
real staged event and confirms the authoritative duration exists, but performs
no Calendar mutation and prints no request, event, account, token, title, time,
ID or ETag. Its first run stopped at the explicit configuration gate because
the local OpenAI key and evidence request were not both configured:

```text
$ npm run verify:gpt-sol
{"status":"failed","code":"configuration_missing","stage":"configuration"}
```

Google OAuth was rotated after the filming account changed. Fresh consent with
the dedicated test account succeeded at the exact Calendar scope. A subsequent
read-only query confirmed that the configured date matches the authoritative
event date. After the fictional event was recreated, Google returned
`America/Denver` as its authoritative event timezone and exact Bander discovery
resolved one eligible event without mutation.

The configured live evidence call then passed and printed only:

```text
model: gpt-5.6-sol
live Responses call: true
model output fields: eventTitleHint, localDateHint, requestedLocalStart,
  needsClarification, clarification
exactly one real event resolved: true
event ID chosen by Bander: true
ETag read by Bander: true
duration read from authoritative event: true
Calendar mutation performed: false
model-authored authority fields: false
private values printed: false
```

The real Calendar spike was then rerun under this same dedicated account. The
stale ETag again returned 412 with zero mutation, the documented concurrent
rate-limit outcome above was observed, and the original interval was restored.

The restored checkpoint matrix passed: typecheck, 129 functional tests, 20
attack tests, the six-outcome demo verifier, one-time recovery, standing
recovery, the real OpenClaw verifier with exactly the three Bander tools,
production build, and a moderate dependency audit with zero vulnerabilities.
A high-confidence scan of all 92 tracked and checkpoint files found zero
OpenAI keys, Telegram bot tokens, Google client secrets or Google refresh
tokens. `transcription_day2.md` remains untracked and untouched.

## Checkpoint 24 — explicit sandbox and real Calendar runtime modes

**Status:** implemented; final deterministic matrix pending

Runtime isolation was implemented red-first. The initial configuration test
could not import `runtime-config.js` at all. After the configuration boundary
was added, eight tests pass: sandbox remains the default, real mode requires
the OpenAI key, Google client/token paths and Bander Telegram credential, real
and mock service configuration cannot coexist, unknown modes fail closed, and
real Telegram state defaults to a separate `.bander/real/` tree.

Two broker/MCP acceptance tests were then observed red. The unimplemented real
mode still reported fixture mode, left sandbox routes reachable, and advertised
Messages and standing authority. The restored tests prove real mode reports
itself explicitly, returns 404 for demo and standing entrypoints, advertises no
Messages, fixtures or standing authority, and retains exactly the same three
Bander MCP tools. One-time proposal, approval, execution and status routes are
unchanged.

Credential projection was separately observed red because the broker received
neither the real-mode marker nor Google paths. It now projects Google OAuth
paths and the Bander bot token only into Bander; neither Google credential path
nor the Bander bot token enters OpenClaw. Mock-service credentials are absent
from the real broker environment. The sandbox projection remains unchanged.

The first real-process startup was also usefully red before any external
action: npm starts a workspace from `apps/broker`, so repository-relative
Google paths incorrectly resolved beneath that workspace. The projection now
resolves paths once at the repository root. The restored real process obtained
OAuth, started the isolated Telegram service, wrote a private pairing link
under `.bander/real/`, and reported:

```text
product: Bander
status: ready
runtimeMode: real
fixtureMode: false
modelCompiler: available
heroMode: false
```

No proposal was created and no Calendar mutation occurred during the startup
check. `npm run real` starts only the real Bander broker; it does not start the
mock Calendar/Messages service and does not alter the deterministic Hero path.

The restored matrix passed: typecheck, 140 functional tests, 20 attack tests,
the six-outcome demo verifier, one-time recovery, standing recovery, the real
OpenClaw verifier with exactly the three Bander tools, production build, and a
moderate dependency audit with zero vulnerabilities. A high-confidence scan
of all 95 tracked and checkpoint files found zero OpenAI keys, Telegram bot
tokens, Google client secrets or Google refresh tokens. The untracked
`transcription_day2.md` remains untouched.

## Checkpoint 25 — real changed-world refusal and filming copy

**Status:** live real-Calendar success and conflict journeys verified; final
combined OpenClaw filming run remains external

The focused real Telegram test was observed red before implementation. Real
mode still rendered the sandbox “other events, messages or payments” boundary
and did not have the required real changed-world wording. The restored focused
tests prove a Calendar-only Card, human local times, no internal engine nouns,
an exact human-only refusal, no success outcome on conflict, and a Calendar-only
success outcome with no raw timestamp or identifier.

Real mode now renders this deterministic conflict copy after the existing
idempotent approval path reports a stale Google precondition:

```text
I stopped—your calendar changed since you asked.
Nothing was moved.
Ask OpenClaw to check again.
```

The copy is Bander-authored plain text. Agent-supplied hearsay remains confined
to the labelled request field and passes through the existing control-character
normalization. Telegram callback ownership, chat/message/callback binding,
delivery retry semantics, and authority-engine execution are unchanged.

For the live journey, only the previously authenticated owner/group
installation was deliberately copied from Hero into isolated real state. No
proposal, callback, pairing token, standing candidate, standing outcome or
authority was copied. The real service then received one production Streamable
HTTP `propose_action` call using the configured off-script request. Live
`gpt-5.6-sol` compiled the bounded hints, Bander resolved the real event and
ETag, and Telegram received the genuine Calendar-only Card. MCP returned only
`draftId` and `status: proposed`.

For the changed-world proof, the owner independently changed the fictional
Google event before tapping the genuine Bander approval. The live result was:

```text
agent status: conflict
agent fields: draftId, status
Telegram lifecycle: conflict
exact human refusal matched: true
human refusal delivered: true
success Receipt created: false
Google event still resolvable: true
authoritative timezone: America/Denver
current event equals approved target: false
verification mutation performed: false
```

A fresh real proposal was then created from the changed event's new
authoritative interval and ETag. With no further world change, the owner tapped
the genuine approval. The live reconciled result was:

```text
agent status: executed
agent fields: draftId, status
Telegram lifecycle: executed
human outcome delivered: true
one Receipt present: true
Messages effect present: false
duration preserved: true
Google at approved target: true
Google matches truthful human outcome: true
authoritative timezone: America/Denver
private values printed: false
```

The live production MCP calls above used a reference MCP client so the two
Google journeys could be verified without claiming a filmed OpenClaw turn. The
separate real OpenClaw process verifier remains green with exactly the three
Bander tools. The final combined OpenClaw → real Bander → real Google journey
is intentionally reserved for the filming pass. No private event title,
interval, ID, ETag, account identifier or credential is recorded here.

The final restored matrix passed: typecheck, 142 functional tests, 20 attack
tests, the six-outcome demo verifier, one-time recovery, standing recovery, the
real OpenClaw verifier with exactly the three Bander tools, production build,
and a moderate dependency audit with zero vulnerabilities. A high-confidence
scan of all 95 tracked and checkpoint files found zero OpenAI keys, Telegram
bot tokens, Google client secrets or Google refresh tokens.
`transcription_day2.md` remains untracked and untouched.

## Checkpoint 26 — latest-request provenance and truthful OpenClaw acknowledgment

**Status:** complete — committed after the full matrix passed

The manual real Telegram test exposed a deterministic-provider provenance bug:
the owner asked for a 1:00 PM move, but the Bander Card truthfully showed that
OpenClaw had proposed an older allowlisted 3:00 PM request. Nothing executed;
the visible mismatch was rejected. The cause was localized to the reference
provider: it scanned every pending user message and selected the first matching
allowlisted candidate, then sent the candidate's stored wording instead of the
latest user text.

Three focused regressions were observed red before the fix:

```text
$ npx vitest run scripts/openclaw-mock-provider.test.ts
Test Files  1 failed (1)
Tests       3 failed | 7 passed (10)
```

They prove that an older supported request cannot override a newer unsupported
request, the newest supported human message crosses the tool boundary verbatim,
and the acknowledgment remains truthful when it is delivered after Bander's
Card. The provider now considers only the newest non-runtime-context user
message after the last tool result, requires an exact normalized allowlist
match, and sends the actual newest message rather than candidate-authored text.

The Card is delivered inside the MCP tool call, so OpenClaw's final model text
cannot be guaranteed to arrive before it without adding a message tool or
introducing an unacknowledged asynchronous delivery race. Neither is acceptable.
The post-tool copy is therefore now:

```text
Bander has prepared this for your review. Nothing has happened yet.
```

This is true whether it lands immediately before or after the Card. No Bander
ambient listener, fourth MCP tool, authority change, Calendar change or
Telegram callback change was introduced.

The actual OpenClaw process then exposed two narrower transport shapes that the
initial unit fixture did not contain. The newest Telegram message may arrive
inside OpenClaw's runtime envelope, or as a standalone line prefixed by its
bounded `[date time timezone]` transport timestamp. Before the extraction fix,
the real verifier made only one model call and no Bander tool call. The provider
now removes only those recognized OpenClaw wrappers, still matches only the
newest human request, and passes the human wording through unchanged. Dedicated
regressions cover both transport shapes and prove that runtime/system text does
not cross into `propose_action`. Timestamp recognition is deliberately limited
to OpenClaw's weekday/date/time/timezone shape; an arbitrary user-authored
bracket prefix is not stripped into an allowlisted request. Temporary
request-content diagnostics used to isolate the mismatch were removed after the
verifier passed.

Restored-green evidence:

```text
focused provider tests: 13 passed
typecheck: passed
functional suite: 15 files, 147 tests passed
attack suite: 2 files, 20 tests passed
demo verifier: all six outcomes passed
one-time recovery: one mutation, Band, Permit and Receipt
standing recovery: one Draft, Permit, mutation, Receipt and counter entry
real OpenClaw verifier: two model calls; one propose_action call; execution not started
effective OpenClaw tools: exactly the three Bander tools
production build: passed
dependency audit: 0 vulnerabilities
tracked token-shaped secret scan: 0 matches
```

The late-message correction is deliberately a truthful sequencing fix, not a
claim that OpenClaw can acknowledge before the synchronous Bander Card. The
reference assistant now says Bander has already prepared the review and that
nothing has happened yet; it no longer says it is still checking after the Card
is visible. `transcription_day2.md` remains untracked and untouched.

## Checkpoint 27 — natural-request routing belongs to Bander

**Status:** complete — real OpenClaw regression green

The first manual retest correctly prevented stale-request substitution, but it
also exposed a product-level contradiction: the reference OpenClaw provider
still used its small deterministic request list as a semantic gate. A parent
could not be expected to guess those exact phrases. A new regression was
observed red before implementation:

```text
Test Files  1 failed (1)
Tests       1 failed | 12 passed (13)
```

The newest unrecognized 1:00 PM Calendar request produced no tool call. The
provider now routes every newest non-empty human request verbatim through the
existing `propose_action` tool. Its known-request table supplies only optional
client request-ID metadata for the standing-flow fixtures; it no longer decides
which natural language Bander may examine. OpenClaw imitation callbacks remain
rejected before proposal.

The same review found a sibling history bug in the imitation guard. A second
regression was observed red (`1 failed | 13 passed`): an old imitation probe in
the conversation suppressed a newer legitimate 2:00 PM request. The guard now
examines only the same newest human request used for routing. A current
imitation remains rejected, while an earlier probe cannot poison future turns.

This does not let the agent construct or enlarge authority. In real mode, live
Sol receives only the bounded natural request and returns hints; deterministic
Bander code still resolves exactly one supported Google event, validates the
shape, preserves duration, captures the ETag, constructs the immutable action,
posts the genuine owner Card, and waits for the bound callback. Unsupported,
ambiguous or malformed requests still produce only minimal `unsupported`
status and the friendly OpenClaw clarification, with no authority.

Restored-green evidence:

```text
focused provider tests: 14 passed
typecheck: passed
functional suite: 15 files, 148 tests passed
attack suite: 2 files, 20 tests passed
real OpenClaw verifier: exactly three tools; supported proposal not executed
unknown flight request: friendly clarification; no authority
production build: passed
```

No Telegram listener, callback, Google adapter, compiler authority boundary,
standing predicate or MCP tool inventory changed. The running manual stack was
stopped before the real-process verifier and restarted only after the verified
checkpoint. `transcription_day2.md` remains untracked and untouched.

## Checkpoint 28 — canonical conversational real-product path

**Status:** complete — manual real-product Telegram journey and final matrix green

The parent-experience failures were reproduced before implementation. A live
two-character greeting reached the deterministic reference provider and then
called `propose_action`; OpenClaw returned the generic unsupported response.
The ordinary cross-day request also failed because the live intent contract
used one date as both the event lookup date and destination date. The first
focused acceptance run was red:

```text
openclaw real-product configuration: missing
cross-day source/target contract: invalid_model_output
Test Files  2 failed
Tests       2 failed | 9 passed
```

A separate canonical-runtime test was added and observed red because no
real-product supervisor existed. `npm run real` previously started only the
broker and could silently coexist with a separately started reference/mock
gateway.

Real mode now has its own OpenClaw configuration using the official Responses
API and exact `gpt-5.6-sol` model. Its system prompt leaves greetings, thanks,
questions and ordinary conversation with OpenClaw, while clear Calendar
actions may invoke Bander without requiring the person to mention Bander or
memorize a phrase. The deterministic reference provider remains available only
to sandbox tests and Hero mode.

The Calendar intent contract now contains `eventTitleHint`, optional
`sourceLocalDateHint`, required `targetLocalDate`, and required
`targetLocalStart`, plus a bounded clarification classification. Without a
source date, Bander searches the next 31 days on `primary`, exhausts Google
pagination, requires one normalized exact-title eligible match, and creates no
authority on zero or multiple matches. Target dates resolve in the explicitly
configured connected-Calendar timezone (`America/Denver` for this product
slice), not the host process's implicit timezone. The selected Google event
still supplies the canonical ID, ETag, complete interval and timezone;
deterministic Bander code preserves duration and constructs the action.

Model-authored clarification prose is not relayed. Bander maps bounded failure
reasons to deterministic human copy, sanitizes it, sends it as plain text from
the independently bound Bander Telegram bot, and returns only
`clarification_required` or `unsupported` to OpenClaw. Tests prove the
clarification creates no Draft and that arbitrary compiler/model detail cannot
cross this boundary.

The canonical `npm run real` command now supervises both the broker and a fresh
OpenClaw gateway. Before reporting ready it validates real runtime mode, the
Google backend, the real Calendar compiler, active owner/group pairing, the
live model provider, exact three-tool MCP inventory, unreachable fixture and
standing demo routes, and absence of Google paths, Bander bot credentials and
mock-service configuration from OpenClaw. It refuses to attach to an existing
broker and writes a fresh private generated OpenClaw config and gateway log.

Restored-green evidence:

```text
focused contract/runtime/Telegram tests: 62 passed
typecheck: passed
functional suite: 16 files, 163 tests passed
attack suite: 2 files, 20 tests passed
canonical startup: real broker + live OpenClaw gateway ready
live provider: bander-openai/gpt-5.6-sol
effective MCP tools: exactly three Bander tools
live cross-day Sol + Google compilation: passed; no mutation
dependency audit: 0 vulnerabilities
production build: passed
```

The manual parent/product acceptance then ran through the canonical command.
Two natural `Hi` turns produced ordinary live-Sol OpenClaw replies; the exported
trajectory contained only user text and assistant thinking/text, with no tool
call. The parent then wrote `can you move the bander demo appointment to July
17, 1 pm mst?` without a source date or magic syntax. Live Sol extracted the
bounded target, deterministic Bander uniquely resolved the real upcoming Google
event, and the owner approved one real mutation. The human outcome showed the
complete authoritative before/after interval and no simulated Messages effect.

That live journey exposed one final disclosure regression: the first cross-day
Card showed only `4:00–5:00 PM → 1:00–2:00 PM`, even though its truthful outcome
contained both dates. A focused test reproduced it red (`1 failed | 36
skipped`). Approval previews now retain the compact consumer format for
same-day moves but automatically include weekday, date, complete interval and
timezone on both sides of a cross-day move. The restored live Card showed:

```text
Fri, Jul 17, 1:00–2:00 PM MDT → Sat, Jul 18, 4:00–5:00 PM MDT
```

The owner approved that second Card and Bander performed exactly the displayed
real Google move. The final existing matrix passed: 163 functional tests, 20
attack tests, all six demo outcomes, one-time recovery, standing recovery, the
real OpenClaw verifier with exactly three tools and no execution, production
build, and a moderate dependency audit with zero vulnerabilities.

Hero remains an explicitly hermetic sandbox and was not converted into the
product path. `transcription_day2.md` remains untracked and untouched. This
checkpoint's canonical parent/product command is `npm run real`; it owns both
processes and fails closed rather than attaching to a stale broker or mock
gateway.

## Checkpoint 29 — public-repository documentation and fresh-clone setup

**Status:** complete — separate documentation checkpoint, no authority/runtime behavior change

The public materials were audited against the implemented real product, the
official Build Week page, live Devpost key dates/announcement/submission
requirements, current Google Calendar/OpenClaw documentation, and the proven
local commands. Devpost reported submissions open until July 21, 2026 at 5:00
PM Pacific Time, with a public narrated video under three minutes, repository,
README, explanation of Codex and GPT-5.6 use, and `/feedback` Session ID
required. `/feedback` remains deliberately deferred until final submission.

The README now leads with the canonical real journey—live conversational
OpenClaw, exact `gpt-5.6-sol`, real primary Google Calendar, genuine Bander
Telegram Card/approval and independent outcome—and labels Hero as a seeded
deterministic sandbox that does not touch Google. Capability and limitation
language was synchronized across the builder plan, architecture decisions,
recording plan, submission checklist and `.env.example`. The exact protected-
profile boundary is published without implying control of other OpenClaw
profiles, protection of a compromised host, real Messages, general schedule
reading, an installer, or restart-durable production authority.

The selected production assets were copied to stable `docs/assets/` paths:
the standalone red/teal protected-claw mark, light and dark wordmarks, and a
self-contained dark-teal banner derived from that identity. The rendered
README was visually inspected at GitHub content width; the banner copy fit,
the mark remained legible, all nine relative references resolved, and all 16
referenced npm scripts existed. An MIT license was added for Bander only.

The first banner preview used a simplified claw redraw and was rejected during
visual review because it did not match the production mark. The redraw was
removed. The README now displays the exact copied
`production/bander_mark_transparent.svg` above a typographic teal/red banner;
the final local GitHub-width render shows the exact mark and complete copy with
no nested-image dependency.

Fresh-clone review exposed one setup gap before commit. `npm run real`
correctly requires an existing owner/group binding, but there was no named
command to create it. The first `pair:real` attempt was then observed failing
because the existing local `.env` declared sandbox mode:

```text
Error: MOCK_SERVICE_TOKEN is required in sandbox mode
```

The setup command now forces real mode while loading the ignored `.env`.
An isolated rerun using temporary Telegram state passed without printing a
credential:

```text
Bander broker listening on http://127.0.0.1:4310
Bander Telegram pairing link written to an isolated private path
Bander Telegram service started
```

The pairing process was stopped without claiming the temporary token. The
normal existing owner/group binding and product state were not modified.

Restored-green documentation checkpoint evidence:

```text
README visual render: passed
README relative references: 9 valid
README npm scripts: 16 valid
fresh isolated pair:real startup: passed
typecheck: passed
functional suite: 16 files, 163 tests passed
attack suite: 2 files, 20 tests passed
demo verifier: all 6 outcomes passed
one-time HTTP recovery: one mutation, authority and Receipt
standing HTTP recovery: one Draft, Permit, mutation, Receipt and counter entry
real OpenClaw verifier: exactly 3 Bander tools; execution not started
production build: passed
dependency audit: 0 vulnerabilities
clean-index npm ci: 588 packages installed; 0 vulnerabilities
clean-index production build: passed
clean-index typecheck and functional suite: 163 tests passed
```

The clean-index install was run from a temporary export containing only the
staged repository. The host shell's Node 25.6.0 produced OpenClaw's expected
engine warning; the repository pins and actually launches OpenClaw with its
supported Node 24.15.0 child runtime.

The tracked day-one transcript was removed from the repository index while its
local file was preserved and ignored. `transcription_day2.md` remains local,
ignored, untouched and absent from this checkpoint. No `.env`, `.bander/`,
OAuth client/token, bot token, personal screenshot or private account detail
was added.

Post-push public-scope correction: `docs/recording-plan.md` was removed from
the repository index and added to `.gitignore` while its local working copy was
preserved. The public README now links only to the submission checklist.

## July 15, 2026 — two-lane load-bearing assumption checkpoint

This checkpoint is deliberately limited to two isolated probes. It does not
implement the read lane, a production family-contact pairing product, a
Messages adapter, compound authority or notification content. Neither probe
imports or calls the authority engine or Google Calendar adapter.

Red-first focused tests were added before either reusable boundary existed.
The first run failed at module import for both `family-contact-spike` and
`compound-intent`. After the bounded implementations were added, the focused
suite passed 30 assertions. The family-contact boundary always creates its own
256-bit random challenge, accepts only a human private-chat `/start` update
whose chat and sender are identical, rejects the owner/bots/groups/wrong token,
locks the first claimant, exposes only `receive_canary`, and revokes only from
the exact paired private surface. Evidence rendering contains no Telegram
identifier.

The live family-contact probe ran with the real product stack stopped so two
pollers could not race on the Bander bot. The first canary delivery was rejected
as privacy evidence after the operator confirmed that the second account was
still a member of the Mum/OpenClaw group at delivery time. Although the canary
itself contained no private details, that topology could not prove separation
from Mum's Cards or conversation. No code or authority boundary was widened to
rationalize the result.

The second account then exited the group and the complete experiment was rerun
with a fresh single-use challenge. A new temporary deep link was written only
to an ignored owner-readable path. The now-separated human account explicitly
started the Bander bot in private; the destination came from that authenticated
Telegram update, not a request or model value. Telegram returned a real bot
message confirmation for one labelled canary, and the second phone replied
`/received`. The contact route was then revoked and the deep link and transient
state were deleted. The ignored evidence confirms that the production Telegram
state digest did not change, the canary contained no Calendar, conversation,
OAuth, owner or approval details, and no Calendar mutation or authority was
created. Existing Telegram service tests independently prove that a non-owner
cannot approve or decline and that forged user/chat/message/callback surfaces
create no authority. The operator confirmed the second account was outside the
Mum/OpenClaw group for this restored-green run.

The first 18-case live `gpt-5.6-sol` strict-output run failed the reliability
gate safely: intended extraction was 1/5, clarification/unsupported handling
was 12/13, and there were zero false accepts and zero invalid outputs. Sol was
over-clarifying bare daytime hours, generic appointment title hints and family
relationships. A prompt-only correction made the bounded acceptance convention
explicit, and deterministic Bander code—not Sol—was made authoritative for
resolving a supplied alias against the local paired-contact directory. The
intermediate run improved to 3/5 and 13/13 with zero false accepts. The restored
live run passed:

```text
exact model: gpt-5.6-sol
strict live Responses calls: 18
intended compound extraction: 5/5
clarification and unsupported handling: 13/13
false accepts: 0
invalid model outputs: 0
model-authored routing, message content or authority accepted: false
Calendar mutation, Telegram delivery or authority from this probe: none
```

The live matrix covered ordinary parent phrasing, capitalization, punctuation,
filler, names and relationships; missing event/date/time; unresolved pronouns;
multiple people; ambiguous relative dates; arbitrary free-form notification
content; unpaired people; cancellation, purchase, reservation, door lock and
multiple-event requests. Malformed output and model unavailability also fail
closed in injected tests. No supported wording requires model-authored message
content: the future notification remains deterministically derived from an
authoritative approved Calendar transition and is not implemented here.

Restored-green verification:

```text
typecheck: passed
functional suite: 18 files, 193 tests passed
attack suite: 2 files, 20 tests passed
demo verifier: all 6 outcomes passed
one-time HTTP recovery: one mutation, authority and truthful outcome
standing HTTP recovery: one Draft, Permit, mutation, Receipt and counter entry
real OpenClaw verifier: exactly 3 Bander tools; execution not started
production build: passed
dependency audit: 0 vulnerabilities
tracked and proposed-file token-shaped secret scan: 0 matches
```

The first sandboxed recovery invocation hit the known tsx local-IPC `EPERM`
before product code started; the unchanged verifier passed with permission.
Both transcript blob hashes remain exactly equal to the starting checkpoint,
and both transcript files remain local, ignored and untracked. No public
capability claim was changed and `/feedback` remains deferred.

## July 16, 2026 — bounded real schedule read lane

This checkpoint adds one deliberately separate read-only lane to the canonical
real product. It does not add production family pairing, notification delivery,
compound authority, real standing autonomy, another Calendar, or a general
Google query surface. Hero remains the deterministic three-tool sandbox; real
mode now has the exact four-tool inventory `list_capabilities`, `read_schedule`,
`propose_action`, and `get_receipt`.

The red-first run established that real mode had no `read_schedule` module or
Google read boundary, the MCP/config/runtime inventories still contained three
tools, and a schedule-shaped request could not produce a real answer. The first
implementation pass also exposed a strict-boundary mistake: the MCP schema was
initially expressed as a raw Zod shape, so the SDK stripped an unexpected
`calendarId` instead of rejecting it. Replacing it with a strict Zod object made
the forbidden caller-selected Calendar test fail closed. A test expectation
also caught the bounded event-count edge before the focused suite was green.

The final design keeps reads structurally outside the authority lifecycle. The
only MCP input is the newest natural request verbatim. A separate live
`gpt-5.6-sol` Structured Output compiler may select only a start local date,
exclusive end local date, clarification state, and one short question.
Deterministic code resolves relative dates using the connected primary
Calendar's authoritative timezone and an injected clock, rejects missing or
ambiguous ranges, and caps the request at 31 calendar days. The Google boundary
uses only an events-list operation against `primary`, requests 51 entries to
detect truncation, and returns at most 50 deterministically ordered items.

The MCP response uses a dedicated schedule DTO. It includes only sanitized
title, human-relevant start/end, all-day state, authoritative timezone,
requested range, and honest empty/truncated state. Timed, all-day, and recurring
occurrences are readable without becoming eligible writable events. Control and
bidirectional-control characters are removed and titles are bounded to 120
characters. Calendar IDs, event IDs, ETags, sequence, organizer and attendee
data, descriptions, locations, conference links, attachments, OAuth/account
data, and authority metadata are never selected from Google or returned through
MCP.

Focused tests cover strict model output, forbidden caller parameters, the
31-day limit, 50-event truncation, deterministic timed/all-day/recurring
rendering, control/bidi title sanitization, empty results, Google failure with
no sandbox fallback, zero authority/store/execution calls, and injected-clock
boundaries across America/Denver's 23-hour spring day and 25-hour fall day.
Schedule facts intentionally enter OpenClaw's trajectory for the requested
answer; Card, callback, outcome, credential, ID and ETag canaries remain absent.
The system prompt treats titles only as quoted untrusted data and forbids a read
result from causing an action call without a later genuine human request. This
reduces exposure but does not claim to solve prompt injection or model
mis-summary.

The live read-intent probe used the exact model `gpt-5.6-sol` and passed 7/7
cases: tomorrow, a named date and an inclusive parent range compiled correctly;
missing date, an over-31-day range, an action-shaped request and a mixed
read/action request failed into bounded clarification. It accepted no
model-authored Calendar or authority fields, called no Calendar, created no
authority, and printed no private value.

The genuine supervised product then passed the parent journey through Telegram:

```text
Hi
  ordinary OpenClaw reply; 0 Bander calls

What's on my calendar tomorrow?
  exactly 1 read_schedule call; honest empty Friday; no Card

Do I have anything on July 18?
  exactly 1 read_schedule call; 1 real fictional event with only
  title/start/end/allDay in the event DTO; no Card

What can you help me with?
  exact installed-capability answer; 0 Bander calls

What's on my calendar?
  1 read_schedule call; one specific date/range clarification

What's on my calendar from July 17 through August 20?
  1 read_schedule call; explicit 31-day refusal; no silent truncation

What's on my calendar tomorrow, and move my appointment?
  0 tools; asked for one clear consequential request; no split

Move my appointment tomorrow
  propose_action clarification lane, never read_schedule; 0 new proposals
```

The last live turn exposed one additional parent-facing red: Bander delivered
the deterministic clarification, then OpenClaw redundantly asked a second
question. The sandbox prompt already suppressed this, but the new real prompt
had omitted the rule. A focused prompt test failed first. Real mode now requires
OpenClaw to return exactly `NO_REPLY` after proposal-lane terminal or
clarification statuses. After restart, the same request produced one Bander
clarification, an internal OpenClaw `NO_REPLY`, and no second Telegram message.

Throughout the live run the Telegram proposal count remained at its six-item
pre-test baseline, standing candidate/outcome counts remained zero, and no Card
appeared. The non-empty read trajectory contained one event and no forbidden
field. Startup and the generated real configuration both reported exactly four
Bander tools; OpenClaw had no Google OAuth client or token path. Google reads
were real and never fell back to a fixture or mock service.

Restored-green verification:

```text
focused read/config/provider suites: 6 files, 54 tests; post-live prompt tests 21
typecheck: passed
functional suite: 20 files, 214 tests passed
attack suite: 2 files, 20 tests passed
demo verifier: all 6 outcomes passed
one-time HTTP recovery: 1 mutation, Band, Permit and Receipt
standing HTTP recovery: 1 Draft, Permit, mutation, Receipt and counter entry
real OpenClaw verifier: sandbox reference 3 tools; real configuration 4 tools
live read Sol evidence: 7/7 cases passed
production build: passed
dependency audit: 0 vulnerabilities
tracked and proposed-file token-shaped secret scan: 0 matches across 113 files
```

The first sandboxed recovery invocation hit the known local tsx IPC `EPERM`
before product code started; the unchanged verifiers passed with local-process
permission. Transcript blob hashes remain
`920eb1a862a20debe214af9915401facc23aeb6b` and
`3c30cae54d4efba1a7a6aa025199d68435dab348`; both files remain ignored,
untracked and untouched. `/feedback` remains deferred.

## July 16, 2026 — production single-family-contact pairing

This checkpoint adds only authenticated, revocable routing setup for one family
contact. It does not send a family notification, expose Calendar information,
add a compound action, create another owner, add an MCP tool, or change the
real four-tool OpenClaw inventory.

The red-first initial boundary test failed because the production
`family-contact` module did not yet exist. The resulting state machine uses the
existing owner-only Telegram service state file: one pending hashed challenge,
one active contact, and minimum opaque revoked audit. The local
`npm run pair:family -- --name Gil --alias "my son" --alias son` command is
operator-only, requires the real product to be stopped, writes the raw link to
an ignored `0600` file, and sends the same short-lived link to the authenticated
owner's private Bander chat. Only the hash is persisted.

The first valid human private claimant is persisted before the consent message
is sent, closing an interrupted-send takeover window. Claim and consent both
require a private chat whose sender and chat match, a non-owner human, the
correct installation and unexpired token, explicit consent, and Telegram proof
that the contact is outside the protected group. Membership is rechecked at
real startup. Unknown membership fails closed; membership in the protected
group rejects or system-revokes the contact. Raw Telegram routing IDs, contact
label and aliases never enter OpenClaw, MCP results, public logs, fixtures, or
committed evidence.

Focused red evidence also exposed a supervised-runtime path bug during the live
revocation run: `npm run real` projected an absolute Telegram state path into
the workspace broker but omitted the family-link path. The broker therefore
looked for a relative sibling and a revoked raw-link file could remain. A
process-environment test failed with an undefined family-link path; a service
restart test failed because a stale link remained. The runtime now projects the
absolute path and startup removes a link whenever no pending challenge exists.
The real restarted product then reported `Family contact: revoked` and the
ignored link file was absent.

The two-account empirical run used the configured invited account outside the
protected group. It opened Bander's private link, explicitly accepted the
limited role, received `You’re connected as Gil`, and the owner group received
`Gil is connected`; no notification capability was claimed. A real restart
reported `Family contact: connected as Gil`. The contact's private request to
see the calendar and approve everything received only bounded role help; a
sanitized OpenClaw gateway/trajectory search found zero contact text, aliases,
or routing terms, while proposal count remained at its six-item pre-test
baseline and no standing state changed. The contact was outside the owner group
and therefore had no physical owner Card callback to tap; exact wrong-user,
wrong-chat, wrong-message and wrong-callback authorization remains covered by
the automated service tests. Contact `/disconnect` erased the active route;
the old private link then returned `invalid or expired` in the invited account.

Restored-green verification:

```text
focused family/service/runtime/process tests: passed
typecheck: passed
functional suite: 21 files, 254 tests passed
attack suite: 2 files, 20 tests passed
demo verifier: all 6 outcomes passed
one-time HTTP recovery: 1 mutation, Band, Permit and Receipt
standing HTTP recovery: 1 Draft, Permit, mutation, Receipt and counter entry
real OpenClaw verifier: sandbox reference 3 tools; real configuration 4 tools
live read Sol evidence: 7/7 cases passed
production build: passed
dependency audit: 0 vulnerabilities
tracked and proposed-file token-shaped secret scan: 0 matches
```

Residual limitation: Telegram documents `getChatMember` support for other
users most strongly when the bot is an administrator. The configured live bot
returned the required membership state in this run; Bander does not rely on
that always being available and fails closed if Telegram cannot verify it.
The family-contact relationship is currently revoked after the empirical test.
Creating a new route requires a fresh explicit operator command and consent.
Both transcripts remain ignored, untracked and unchanged; `/feedback` remains
deferred.

## July 16, 2026 — replay-safe family notification delivery

Checkpoint 4 adds only Bander-owned Telegram delivery to the active paired
family contact. It does not add a compound action, change Calendar authority,
add an MCP tool, or make delivery agent-callable. The exact real OpenClaw
inventory remains four tools.

The strict document accepts only a Calendar-transition title, new start/end and
timezone. Unknown destination or free-form body fields are rejected. Bander
sanitizes control and bidirectional characters, bounds the title, formats the
complete interval deterministically, and sends plain text without parse mode,
links, mentions, attachments, callbacks or buttons. Destination resolution is
exclusively from active contact state; the operation binds installation, opaque
contact ID, exact pairing revision, request ID and canonical content digest.

Operations persist `prepared` and then `dispatching` before Telegram transport.
A confirmed response stores the Telegram message ID privately; replay returns
only `{status:"delivered"}` without another send. Changed content fails closed.
Transport failure or restart from `dispatching` becomes permanently ambiguous
and is never blindly retried. Telegram acceptance is not proof that the contact
read the message, and Bander does not claim exactly-once delivery.

Revocation and dispatch use the same Telegram-state lock through the send. Tests
prove revocation first produces zero attempts, while delivery first produces
one attempt to the original pairing before revocation completes. A deliberate
mutation disabling the replay guard made the replay test send twice and the
concurrent test send three times; restoring the guard returned both green.

The live invited account was explicitly re-paired. One deterministic Checkpoint
4 update received a confirmed Telegram response and appeared once. Immediate
and fresh-process replay returned the same durable result with one operation and
no second phone message. Proposal count remained six; no Calendar mutation,
Draft, Card, Band, Permit, standing authority or MCP action was created. The
local operator then ran `npm run revoke:family`; the active route is absent,
opaque revocation audit and confirmed delivery record remain, and no raw
destination remains routable.

Final verification: focused notification/service tests 70 passed; typecheck;
functional suite 22 files/261 tests; attack suite 20 tests; all six demo
outcomes; both recovery verifiers; real OpenClaw with four real tools; live
read-Sol 7/7; production build; dependency audit with zero vulnerabilities; and
secret scan with zero matches. Transcript hashes remain
`920eb1a862a20debe214af9915401facc23aeb6b` and
`3c30cae54d4efba1a7a6aa025199d68435dab348`. The family contact is revoked.
`/feedback` remains deferred.

## 2026-07-16 — Checkpoint 8: Family Coordination Concierge

Checkpoint 8 expands the canonical real product from four to exactly five MCP
tools by adding `bander__read_inbox`. Gmail uses a separate ignored OAuth token
with exactly `gmail.readonly` and `gmail.send`; the Calendar token remains
unchanged. The real OpenClaw process receives neither Google credential path.
The bounded read lane accepts only the newest natural request, lets Sol extract
sender, subject, date range and explicit-latest intent, and returns a separate
sanitized DTO without Gmail message/thread IDs, raw headers, attachments or
hidden HTML. Email facts intentionally enter the model trajectory for answering
the parent; this is documented as exposure reduction, not prompt-injection
detection. Reads create no Card, authority or mutation.

One exact Gmail reply and one independent family message remain behind the
existing `bander__propose_action` tool. An email reply pins the resolved source
and latest thread identities, one Reply-To/From recipient, subject and threading
headers, exact bounded plain text, stable Message-ID, opaque reconciliation
header, canonical MIME bytes and digest before approval. Execution rereads the
thread and refuses if a newer message exists. Direct family text is derived from
the parent's request, sanitized, bound to the exact active contact revision,
shown on the Card, hashed and delivered unchanged. The model cannot choose an
email address, Telegram destination, MIME/header value, approval or authority.

The initial focused runs were meaningfully red: Gmail read/reply modules and the
direct-family document did not exist, the real product had no fifth tool, and
the sandbox had no inbox/reply/direct-family journeys. Four deliberate mutations
were then observed failing and restored: choosing an arbitrary Gmail match
returned two private records; retrying an ambiguous Gmail send made two send
attempts; skipping the latest-thread check sent against stale context; and
changing the family renderer broke Card/delivery byte equality. The attack suite
keeps the arbitrary-selection, header/recipient injection, ambiguous no-retry,
and family link/command/bidirectional-text cases.

Live evidence exposed and closed four additional defects. First, OAuth consent
succeeded but the Gmail API returned `accessNotConfigured`; enabling the API in
the same Cloud project made the sanitized read-only probe find exactly one
fictional message. Second, the action router had no injected current date, so
Sol resolved “today” to March 24 instead of July 16 and a known email could not
be found. The router now receives the explicit `America/Denver` local date from
an injected clock; the live diagnostic then returned July 16–17 and the Card was
created. Third, the real supervisor still asserted the pre-Gmail status shape;
startup failed red until it required the Google Gmail backend, `real_product`
compiler, inbox-read availability and exact five-tool inventory. Fourth, the
one-shot response-loss evidence flag was initially isolated from both OpenClaw
and Bander; it is now projected only into Bander's broker and remains absent
from OpenClaw.

The first real lost-response spike also disproved a design assumption rather
than being rationalized away. Gmail accepted exactly one reply and preserved
its body, but rewrote the caller-supplied RFC Message-ID, so an exact
`rfc822msgid` search could not reconcile it. Bander correctly reported the
outcome as unconfirmed and did not resend. The smallest safe correction keeps
the stable Message-ID inside the immutable MIME but adds an opaque
`X-Bander-Operation` value derived before approval. Recovery scans at most 25
recent Sent messages and accepts only one exact header, recipient, thread,
subject and body match. A fresh live probe deliberately discarded Gmail's
successful response, found that exact match, returned “Your Sent folder now
shows the approved reply,” and replayed with zero additional sends. Any zero,
multiple or unreadable result remains terminally ambiguous.

The genuine Telegram/OpenClaw/Gmail evidence used only fictional subjects. One
bounded inbox question returned the expected lunch sentence with no Card. One
normal approval produced one exact Gmail reply; a repeated tap reported already
done and produced no duplicate. The corrected lost-response approval produced
one Sent message, observation-safe wording and no replay send. For changed-world
evidence, a Card was prepared, a newer inbound message was added to the same
thread, and approval sent zero replies. Its chronology copy was corrected from
“since you approved” to “since Bander prepared this reply.” No Calendar mutation
or family delivery occurred during the Gmail evidence. The family contact
remains revoked; live direct-family delivery remains an explicit pre-film gate,
while the deterministic exact-text, revocation, ambiguity and replay tests are
green and prior live Bander-owned transport evidence remains valid.

The browser sandbox now reports 27 outcomes: the previous 18 plus bounded seeded
inbox read; exact email reply approval, decline and replay; thread-changed and
ambiguous-email outcomes; and independent family approval, decline and replay.
Every page remains visibly deterministic and disconnected from Google, Gmail,
Telegram, OpenAI and real people. Desktop and mobile inspection at 1280×720,
375×812 and 500×900 found meaningful native button names, logical order,
visible focus styling, 48-pixel controls, no horizontal overflow and complete
Card text reachable by scrolling.

Final restored-green evidence: 36 functional files with 437 cases; 3
adversarial files with 26 cases; all 27 deterministic demo outcomes; one-time
and standing HTTP recovery; exact five-tool OpenClaw verification; production
typecheck/build; live Sol compound 18/18, schedule read 7/7, create 8/8,
cancellation chunks 8/8 and Gmail/direct-family 7/7 with zero false accepts;
clean-clone installation/build/doctor/demo with credentials stripped; dependency
audit with zero vulnerabilities; and tracked/proposed secret scan with zero
matches. The live doctor reported 13 PASS, 4 expected WARN and 0 FAIL, including
Gmail and exact-tool PASS; the Telegram state checksum was unchanged. BotFather
privacy remains an honest empirical WARN. Transcript hashes remain
`7309a1a37068a08b43c6bc3fe2db2c32fc66553fb38374f5a8919a908261f557`
and `75d7c22868024133e6ce09a2a0a9f7dde870ada0cf33dd70e5ea981e90881c58`;
both files remain ignored and untracked. `/feedback`, parent testing, filming,
Devpost and submission work remain deferred.

## 2026-07-16 — Combined Checkpoint 9: public product surface

Checkpoint 9 turns the zero-account browser sandbox into a deployable public
product surface without placing any production integration in the browser. The
React application now uses one typed demo-backend contract. Local `npm run demo`
uses the broker, while the Pages build runs the same authority engine, contracts,
canonical serializer, Card renderer and versioned fictional fixtures entirely in
the browser. A narrow platform boundary keeps Node crypto in production and uses
pinned `@noble/hashes` plus Web Crypto in the browser. The static build contains
no broker, Google/Gmail, Telegram, OpenAI/OpenClaw, filesystem or process-
environment module and its CSP forbids runtime connections.

The first focused red run exposed five real defects: an email-only success could
claim Gil received a message, email ambiguity rendered Calendar/family surfaces,
deep-link startup could race Draft registration, changed-thread email failure had
no first-class parent result, and a definitive Gmail rejection deleted its
operation record so replay could reach transport again. The repaired Gmail
operation persists a typed `rejected` terminal state; the public UI renders only
effects present in the observed receipt, email ambiguity shows only Sent Mail,
deep-link and approval entry are single-flight, and changed-thread refusal is a
truthful dedicated result.

Five load-bearing guards were deliberately broken one at a time and restored:

- changing one browser Card title made browser/server proposal parity fail;
- changing the replayed Calendar-ambiguity status made terminal parity fail;
- placing a fake OpenAI-shaped value in the built page made the artifact scanner
  reject the bundle;
- importing the broker into the browser backend pulled production dependencies
  into the graph and made the Pages boundary build fail; and
- rendering Gil's-phone success unconditionally made the email truthfulness test
  fail.

The shared deterministic runtime now covers seeded Calendar, inbox, Sent Mail,
family-phone and guided Dr. Rao state. Browser/server parity is byte-for-byte for
schedule and inbox reads; eight deal shapes; Cards, hashes, receipts, world state,
replay and decline; Calendar/email changed-world and ambiguous terminals; and
standing activation, eligible execution, review fallback, replay and revocation.
All 27 existing demo outcomes remain green. The public homepage leads with three
calm parent lanes and one guided read → reply → appointment + Gil episode, while
secondary proofs remain available without presenting a test catalog.

The Pages build targets `/bander/` and is produced by an allowlisted environment
wrapper plus the official GitHub Pages Actions workflow. Artifact verification
passes seven approved files, base-path and scenario direct refresh, CSP, source-
map, secret-shape, environment-name, production-module and runtime-host scans.
Browser QA observed nine meaningful native button names, one main heading,
working Enter/Space activation, visible focus, minimum 44px targets, no nested
controls or horizontal overflow, a single effect under a programmatic double
approval, and zero external requests at 1280×720, 375×812 and 500×900. The three
primary accessible names are the visible lane copy for asking about tomorrow,
moving an appointment and telling family, and seeing an unknowable result; no
redundant ARIA label was added.

The clean-clone gate itself caught two release-hygiene issues after implementation:
a literal fake-token canary in the artifact test violated the repository secret
scan, and the no-account verifier still expected an older sandbox label. The
canary is now constructed dynamically and the verifier pins the current seeded,
non-live statement. A fresh isolated clone then passed `npm ci`, typecheck,
production and Pages builds, no-account doctor, 27/27 outcomes, blocked product
endpoints and a clean isolated working tree without credentials, state,
transcripts or screenshots.

Final restored-green evidence: 40 functional files with 453 cases; three
adversarial files with 26 cases; 27/27 deterministic outcomes; both recovery
verifiers; 128 focused Calendar, Gmail and direct-family cases; exact five-tool
real OpenClaw verification; live read Sol 7/7, Gmail/action Sol 7/7 and compound
Sol 18/18 with zero false accepts; typecheck, production build and `/bander/`
Pages build; artifact and browser QA; clean clone; dependency audit with zero
vulnerabilities; and read-only doctor with 9 PASS, 3 expected WARN and 0 FAIL.
The doctor state checksum was identical before and after. BotFather privacy
remains an empirical warning, GitHub Pages response headers remain outside this
static repository's control, source maps are public only after artifact scanning,
and the browser sandbox is not evidence that any real service acted. Repository
visibility and Pages enablement remain owner-controlled. Parent testing, filming,
`/feedback`, Devpost and submission work remain deferred.

After the owner made the repository public, signed-out browser verification
observed both the repository and `https://gowtham0992.github.io/bander/` live.
The `/bander/?scenario=compound` direct link rendered the seeded compound Card
and approval controls. That check also exposed the now-stale conditional footer
promising links only after publication. A focused test failed first; the restored
footer now links to the public repository, setup guide, architecture, evidence
ledger and limitations with native accessible links and 44px targets. The final
count is 454 functional cases and 26 adversarial cases; Pages artifact and
desktop/mobile browser QA remain green with zero external product requests.

## 2026-07-16 — Checkpoint 7C: Calendar-complete product integration

Checkpoint 7C did not change the production authority lifecycle, conditional
Google write/delete semantics, family-delivery ordering, Sol authority boundary,
contact authorization, or the exact four-tool real MCP inventory. It completed
the deterministic judge surface and current product explanation around the
already-implemented read, create, move, and cancel lanes.

The focused cancellation Card assertion was observed red against the prior
parent copy: it omitted an explicit `Not included` boundary and could be read as
canceling more than a Calendar entry. The restored Card now says that Bander
removes only the Calendar event, does not contact or cancel the external
appointment, and—when applicable—sends only the exact family update displayed
on the Card. The current Bander introduction and capability answer likewise
distinguish Calendar removal from canceling an appointment or reservation with
a business.

The production post-dispatch reconciliation classifiers were verified rather
than broadened. Creation lookup failures and cancellation lookup statuses other
than definitive 404/410 remain ambiguous. Statuses 401, 403, 408, 429, 500 and
503, network failures, and malformed lookup results all preserve the typed
unconfirmed state, issue no second insert/delete, and send no family update. A
deliberate mutation that treated cancellation lookup 401 as observed absence
made the focused status-matrix test fail and was reverted.

Two genuine authority-boundary cases were promoted into the adversarial suite.
First, a deliberate causal receipt for an observed-absent cancellation failed
the observation-safe wording test. Second, disabling creation-title
sanitization let control/bidi content reach the trusted Card and failed the
voice-forgery test. Both mutations were restored before the final run.

The deterministic sandbox now has visibly secondary create and cancel journeys
using the real create/cancel action shapes and the production family-document
renderer. Create approval adds one seeded event and one byte-identical family
update; cancellation removes one seeded event and sends the exact approved
update; replay repeats neither effect; decline creates neither effect; and a
seeded changed-world cancellation preserves the externally changed event and
sends no family update. The demo verifier now reports 18 outcomes: the previous
nine plus create approval/replay/decline, cancel approval/replay/decline,
cancel changed-world, and byte equality for both family documents. The clean
clone verifier expects and passed all 18.

Actual browser accessibility computation found meaningful native button names:

- `ASK What’s on tomorrow? No approval toll for a harmless read.`
- `CHANGE Move an appointment and let family know One exact Card. One decision.`
- `UNCERTAIN See an unknowable result Bander says only what it can prove.`

The lane controls remain native, unnested buttons with visible focus styling and
responsive tap targets; no redundant ARIA was added. Pointer activation and the
ASK, CHANGE, UNCERTAIN, create, cancel, cancellation-conflict, replay, and
Change-it flows were exercised in the browser. Final local-only visual QA at
1280×720 and the existing 500×900 mobile check showed the three primary lanes
clearly, complete trusted effect text, and scroll-reachable actions. No personal
screenshots were committed.

Final restored-green matrix: typecheck and production build; 31 functional
files with 409 tests; 22 adversarial tests; all 18 deterministic sandbox
outcomes; one-time and standing recovery verifiers; the real OpenClaw verifier
with exactly four configured Bander tools; live compound Sol 18/18, read Sol
7/7, create Sol 8/8, and the final cancel Sol run 8/8, all with zero false
accepts and zero authority or Calendar mutation; dependency audit with zero
vulnerabilities; read-only offline doctor; isolated clean-clone acceptance; and
a tracked/proposed-file secret scan across 140 files with zero matches. One
cancel Sol run safely classified a whole-afternoon bulk request as clarification
instead of the verifier's expected unsupported label; it created no authority
or mutation, and the bounded rerun passed 8/8 without changing the production
contract.

Both transcript files remain ignored and untracked with no diff. No real Google
mutation, Telegram family notification, parent test, filming, submission work,
or `/feedback` was performed for this checkpoint.

## July 16, 2026 — Checkpoint 6B technical-owner onboarding and cold-clone proof

The checkpoint began with the requested focused red state. The unified doctor
module and package command did not exist, the clean-clone contract had no
implementation, and the browser still displayed the clinical provenance labels
and unexplained `Request 1 of 5`. The initial focused run failed both clean-clone
contract tests and could not import `doctor-lib`. Two microcopy assertions then
failed against the old labels/window. After the doctor first passed, a deliberate
mutation printed the configured OpenAI test secret in the real-mode row;
`doctor_never_prints_secret_values` failed on the exact leaked value. Restoring
the fixed status copy returned the redaction suite green.

`npm run doctor` is now a read-only, sanitized offline report that works without
`.env`; `--json` uses the same safe DTO, and `--live` adds only Telegram identity,
protected-group/owner membership, primary-Calendar timezone and MCP inventory
reads. Fixed output never includes token values, raw provider errors, Telegram or
Calendar identifiers, OAuth contents, callbacks, or private paths. Missing family
setup is a warning because Calendar-only use remains available. BotFather privacy
always reports the exact warning `BotFather privacy requires the documented
empirical check.` and points to `npm run verify:telegram-privacy`. Unknown flags
fail with one usage line. Focused coverage passed 11 doctor cases, including
injected sentinels proving no Telegram send, Calendar write, authority creation,
or persisted-state mutation. Hashing the real ignored Telegram state before and
after both offline and live doctor runs also showed byte-for-byte equality.

The live read-only doctor empirically reached the Bander bot, protected group and
bound owner and read the primary Google Calendar timezone as `America/Denver`.
With the product intentionally stopped, its MCP row truthfully failed and told
the operator to start `npm run real`; it did not attach to a stale service. The
separate real OpenClaw verifier proved the configured four-tool inventory. The
OpenAI doctor row delegates its non-authoritative evidence call to the existing
Sol verifier; the fresh compound and read verifiers passed 18/18 and 7/7.

The isolated clean-clone work exposed three verifier defects before the gate
passed: the install subprocess initially inherited the parent environment,
sequential ephemeral-port reservations could collide, and `verify:demo` rejected
a safe custom loopback port. The final verifier copies only tracked/proposed
non-ignored files into its own `/private/tmp/bander-clean-clone-*` directory,
removes every product credential before `npm ci`, blocks Google/Telegram/OpenAI
product endpoints for all product checks, accepts only a matching loopback demo
URL/port, and restricts cleanup to its generated prefix. The final run proved no
credentials, `.bander`, OAuth files, transcripts, screenshots or generated
OpenClaw state; MIT license and local docs links; lockfile install; typecheck and
build; actionable no-account doctor; zero-account demo startup; all nine demo
outcomes; the full seeded/non-live disclosure in the served app; and a clean
isolated Git tree.

Final browser copy retains the quoted/contained provenance quarantine while using
`Calendar`, `Family member`, and `Exact update from Bander`. The proposal footer
now reads `1 of 5 requests in 10 minutes` from the actual Card count, limit and
window. Fresh 1440×1100 desktop and 500×900 phone captures of the compound Card
show complete intervals, exact update text and the full proposal window with no
horizontal overflow. A 390px macOS-headless capture was correctly rejected as a
Chrome minimum-layout-viewport crop artifact, not used as visual evidence.

Stopping visual QA exposed one additional load-bearing sandbox defect: `npm run
demo` loaded a populated local `.env`, causing an unnecessary Bander Telegram
pairing poller. `demo_never_projects_real_credentials_even_when_env_exists` was
observed failing before `runLocal` gained explicit demo isolation. Demo now strips
OpenAI, both Telegram tokens, Google OAuth paths and Calendar timezone even in a
configured checkout. Hero and real modes retain their existing wiring.

The new root [setup guide](SETUP.md) separates the setup computer, parent phone and
family-contact phone; documents BotFather settings and re-add behavior, narrow
Desktop OAuth, remote family invitation, both doctor modes, recovery and the
accepted limitations. README remains the short entry point, architecture records
the read-only diagnosis boundary, and the submission checklist retains the human
test as unfinished. No production authority, Google execution, compound ordering,
Sol schema, contact authorization, delivery guarantee, or four-tool contract file
changed.

Final restored-green matrix: 28 functional files with 327 runtime cases; 20
adversarial tests; all nine deterministic demo outcomes; one-time recovery with
one mutation, Band, Permit and Receipt; standing recovery with one Draft, Permit,
mutation, Receipt and counter entry; real OpenClaw verification with exactly four
real tools; live compound Sol 18/18 with zero false accepts or invalid outputs;
live read Sol 7/7; production build; dependency audit with zero vulnerabilities;
tracked/proposed-file token-shaped secret scan with zero matches; and the complete
cold-clone acceptance pass. No real Calendar write or family notification was
performed. Both transcripts remain ignored and untracked with unchanged SHA-256
values `7309a1a37068a08b43c6bc3fe2db2c32fc66553fb38374f5a8919a908261f557`
and `75d7c22868024133e6ce09a2a0a9f7dde870ada0cf33dd70e5ea981e90881c58`.
The unmoderated parent/proxy test and `/feedback` remain explicitly deferred.

## July 16, 2026 — Checkpoint 6C product coherence and failure-state polish

The checkpoint began with focused red evidence rather than a broad refactor. The
first targeted run reported seven failures: three stale source-of-truth/public
claim assertions, the parent-visible internal lifecycle noun, the missing
uncertainty preface, the real Telegram label `Calendar transition`, and the
silent live action-model outage. The accessibility assertion was deliberately
not made red: the actual browser accessibility tree already exposed meaningful
native button names.

The real computed names were:

```text
ASK What’s on tomorrow? No approval toll for a harmless read.
CHANGE Move an appointment and let family know One exact Card. One decision.
UNCERTAIN See an unknowable result Bander says only what it can prove.
```

No redundant ARIA was added. A true 375×812 browser viewport measured 375px
content and scroll widths, native `BUTTON` elements in ASK → CHANGE → UNCERTAIN
tab order, zero nested interactive elements, 343px-wide by 150–153px-high tap
targets, and a visible `3px solid rgb(231, 122, 110)` focus outline. Native
Enter and Space each activated their focused lane in an isolated Chrome CDP
run.

The browser now avoids parent-visible Draft, Band, Permit and Receipt language;
the requested Change-it instruction reads: “In Telegram, tell your assistant
what you want changed and Bander will prepare a new deal.” The real Telegram
Card says `📅 Calendar change`. Only the UNCERTAIN lane adds a sandbox preface,
outside the trusted Card, explaining that the provider response will be
deliberately lost after approval. The stored Card itself remains unchanged.

Manual ASK, CHANGE, UNCERTAIN and replay QA found one additional bounded UI bug:
Change-it discarded the original compound scenario, so approval displayed a
Calendar-only result even though the seeded family update executed. A focused
test was observed failing before the screen state retained its scenario. The
restored path now shows the compound result and exactly one simulated family
update after replay.

The live action compiler's `model_unavailable` classification previously
returned `unsupported` to OpenClaw without a Bander human message. Under the
pinned `NO_REPLY` policy this produced silence. The MCP boundary now returns only
`temporarily_unavailable`, Bander independently delivers exactly one message—
“I couldn’t prepare that safely just now. Nothing happened. Please try again in
a moment.”—and the OpenClaw policy remains silent after that Bander-owned
explanation. Focused evidence proves no Card, authority proposal or execution is
created and no provider detail enters the MCP result. There is no fixture or
mock fallback.

`Bander_Build_Plan.md` now describes the implemented four-tool real inventory,
bounded read lane, exact Calendar lane, compound family lane, consented and
revocable contact, Calendar-first execution, replay and ambiguous outcomes,
sandbox-only standing automation, and process-local production authority. The
public claim sweep retains the narrower statements: no prompt-injection
detection, compromised-host protection, human-read confirmation, or
exactly-once Telegram delivery.

Visual QA passed at 1280×720, a true 375×812 responsive viewport, and 500×900
for the uncertainty Card. The 375px page had no horizontal overflow, and the
preface remained readable without entering or changing the Card.

Final restored-green matrix: 29 functional files with 335 cases; 20 adversarial
tests; all nine deterministic demo outcomes; one-time recovery with one
mutation, Band, Permit and Receipt; standing recovery with one Draft, Permit,
mutation, Receipt and counter entry; real OpenClaw verification with exactly
four real tools; live compound Sol 15/15; live read Sol 7/7; typecheck and
production build; dependency audit with zero vulnerabilities; offline read-only
doctor; tracked/proposed-file secret scan with zero matches; and a credential-
stripped cold sandbox reporting `runtimeMode: sandbox`, fixture compiler, and no
model compiler. No real Google mutation or family notification was performed.
Both transcript files remain ignored and untracked with unchanged SHA-256
values `7309a1a37068a08b43c6bc3fe2db2c32fc66553fb38374f5a8919a908261f557`
and `75d7c22868024133e6ce09a2a0a9f7dde870ada0cf33dd70e5ea981e90881c58`.
The parent test, filming, submission work and `/feedback` remain deferred.

## July 16, 2026 — one approved Calendar move plus one family update

Checkpoint 5 adds the real compound deal without adding an MCP tool. The real
OpenClaw inventory remains exactly four tools. Live `gpt-5.6-sol` may identify
only the Calendar hints, whether a family update was requested, and the human
alias used. Deterministic Bander code resolves the authoritative Google event,
the exact active contact pairing revision, and the canonical notification
document. One immutable Draft and one Card contain both effects before approval.

Red-first and deliberate-mutation evidence covered the load-bearing boundaries.
The initial live approval exposed a non-reentrant Telegram-state-lock deadlock:
Google committed, then compound delivery tried to reacquire the lock already
held by the callback. No family operation or human outcome was created, and a
second tap could not be processed. The corrected callback reuses only the
already-held lock in that exact async call chain; external delivery and contact
revocation still serialize on the same lock through transport. The permanent
`compound_callback_reuses_the_existing_state_lock_without_deadlock` regression
completed after timing out under the faulty structure.

Other observed red evidence:

- removing Calendar-before-message ordering caused a conflict path to send one
  family message;
- removing the exact pairing-revision check redirected an old deal;
- rendering the human outcome from Draft intent falsely reported an ambiguous
  family effect as delivered;
- generating a fresh delivery ID on replay defeated duplicate-send protection;
- a committed Google patch with an incomplete response was initially surfaced
  as an error instead of being reconciled by an authoritative reread.

Restored code binds the exact opaque pairing at proposal, uses one notification
renderer for Card and delivery, executes Calendar before Telegram, derives a
stable delivery identity from the approved Draft and internal Permit, and builds
the human outcome only from observed effect results. A lost Google response is
never blindly patched again. Bander rereads the exact event and labels an exact
target match as observed state without claiming causation.

Live two-phone evidence passed. The Card displayed:

```text
• Move “Bander Demo Appointment”
Fri, Jul 17, 1:00–2:00 PM MDT → Sat, Jul 18, 4:00–5:00 PM MDT
• Send Gil:
“Bander update
“Bander Demo Appointment” is now Sat, Jul 18, 4:00–5:00 PM MDT.
This update was sent by Bander at the owner’s request.”
```

One owner tap produced one real Google transition and one Telegram-confirmed
family update with exactly the displayed text. The owner saw the combined
truthful outcome. Replaying the same Card returned Telegram's `already done`
acknowledgment; the family phone received no second message and the durable
family-operation count stayed unchanged. In a separate changed-world run, the
event was independently moved after Card creation. Approval returned the
human-only refusal “Nothing was moved, and no family update was sent”; the
independent Calendar interval remained and the family-operation count did not
increase.

After evidence, the fictional event was restored to Fri, Jul 17, 1:00–2:00 PM
MDT in `America/Denver`, and the family contact was revoked. Telegram acceptance
is evidence that Telegram accepted the message, not that the contact read it.
An ambiguous family response remains permanently unconfirmed and is never
automatically retried. Real core authority remains process-local by the accepted
prototype boundary. `/feedback` remains deferred.

Final restored-green matrix: typecheck; 23 functional files with 294 tests;
20 adversarial tests; all six demo outcomes; one-time recovery with one mutation,
Band, Permit and Receipt; standing recovery with one Draft, Permit, mutation,
Receipt and counter entry; real OpenClaw verification with exactly four real
tools; live compound Sol 18/18 with zero false accepts and zero invalid outputs;
live read Sol 7/7; production build; dependency audit with zero vulnerabilities;
and tracked/proposed-file secret scan with zero matches. Both transcript files
remain ignored and untracked and were not modified by this checkpoint.

## July 16, 2026 — Checkpoint 5 ambiguous-Calendar truthfulness follow-up

The follow-up review found one blocking false-certainty path. When Google could
have committed a Calendar patch but its response was unconfirmable, the engine
raised `calendar_outcome_ambiguous` and correctly made zero family-delivery
attempts. Telegram nevertheless collapsed that typed error into the generic
message and toast “nothing changed through Bander.” A repeated tap then called
the engine again, encountered a non-resumable terminal Draft, and had no stored
classification from which to recover the truth.

Seven focused assertions were added before the production change. The initial
run observed seven failures: the compound and Calendar-only human messages made
false claims, the callback toast said “Stopped safely,” replay lacked a typed
terminal classification, and active family-contact copy still said
notifications were a future capability. The ordinary ETag-conflict control
remained green.

Each proposal may now persist a validated `terminalFailureCode`. The file-backed
state loader rejects unknown classifications and invalid lifecycle/code pairs.
`calendar_outcome_ambiguous` renders a dedicated human outcome that says the
Calendar result is unconfirmed, confirms that no family update was sent only
when the approved deal included that effect, refuses automatic retry, and asks
the person to check Calendar. Its callback toast is equally bounded. Replay
short-circuits before engine or Calendar execution, preserves the same typed
classification, attempts no family delivery, and does not resend an already
delivered human outcome. Legacy terminal records without a code fall back to an
unconfirmed outcome rather than inferring certainty from rendered text.

The active family-contact confirmation and bounded private-help copy now state
the implemented product: Bander may send only the exact appointment update the
inviter approved, while the contact has no approval or Calendar access. The
pre-consent screen retains “No notifications are enabled yet” because no active
relationship exists at that point.

The requested deliberate mutation replaced only the dedicated ambiguous branch
with the old generic refusal. `google_may_have_committed_never_says_nothing_changed`
failed with the exact false “Stopped — nothing changed through Bander” output.
Restoring the branch returned all 67 Telegram service tests green.

Final restored-green matrix: typecheck; 23 functional files with 302 tests;
20 adversarial tests; all six demo outcomes; one-time and standing recovery
verifiers; real OpenClaw verifier with exactly four real tools; live compound
Sol 18/18 with zero false accepts or invalid outputs; live read Sol 7/7;
production build; dependency audit with zero vulnerabilities; and tracked plus
proposed-file secret scan with zero matches. No real Calendar mutation was
needed for this callback-only correction. Both transcript files remain ignored,
untracked, and untouched. `/feedback` remains deferred.

## July 16, 2026 — Checkpoint 6A parent comprehension and judge-sandbox parity

The focused browser acceptance test was written before the sandbox changes. Its
first run observed three failures: `/api/demo/schedule/tomorrow` did not exist,
the versioned compound fixture did not contain a
`family.telegram_notification` effect, and the browser did not identify itself
as seeded and disconnected from Google, Telegram and OpenAI. The restored test
also proves that schedule reading calls no authority-store writer. Focused
engine/process coverage then proved Card/phone byte equality, one Calendar and
one family effect on approval, no second mutation or family update on replay,
and a terminal ambiguous Calendar classification that never says “nothing
changed” and never sends a family update.

Parent-visible production language now uses the shared deterministic family
renderer sentence “This is the exact update your family approved Bander to
send.” The real Telegram compound Card labels the two effects `📅 Calendar
transition` and `👤 Family update`. Family clarification, consent and disconnect
copy no longer exposes pairing or routing plumbing. The Card renderer and
delivered Telegram update remain the same bytes.

Authenticated owner/group pairing now sends one Bander-authored introduction to
the persisted protected group binding. Focused tests proved one confirmed send,
no resend on pairing replay or a reconstructed-service startup, definite-send
failure remaining pending without a delivery claim, recovery on startup, zero
authority/Calendar execution, and no contact-triggered introduction.

The zero-account browser now leads with three lanes: a seeded schedule answer
with no Card or authority; a compound Calendar-plus-Gil deal using the
production family document/renderer and a visibly labelled simulated phone; and
a deliberately unknowable Calendar result with truthful copy, zero family
update and replay safety. Changed-world refusal, approval recovery/replay and
standing sandbox behavior remain secondary. Every page carries the exact
seeded/not-live disclosure. `verify:demo` reports nine green outcomes: the six
prior proofs plus `zero_authority_seeded_answer`,
`exact_text_replay_safe`, and `truthful_zero_family_update`.

Desktop 1440×1100 and mobile 500×900 local screenshots were inspected from the
running sandbox. The landing hierarchy, disclosure, compound Card, complete
intervals, exact family text, focus states and single-column mobile layout were
legible with no horizontal overflow at the reliable mobile viewport. QA images
remain only under `/private/tmp` and contain seeded data.

Final restored-green matrix: typecheck; 24 functional files with 311 tests; 20
adversarial tests; all nine demo outcomes; one-time recovery with one mutation,
Band, Permit and Receipt; standing recovery with one Draft, Permit, mutation,
Receipt and counter entry; real OpenClaw process verification with exactly four
real tools; live compound Sol 15/15; live read Sol 7/7; production build;
dependency audit with zero vulnerabilities; and tracked/proposed-file
token-shaped secret scans with zero matches. No real Google request or family
notification was used for this checkpoint. Production authority lifecycle,
Google execution semantics, compound ordering and the four-tool inventory were
unchanged. Both transcripts remain ignored and untracked; their current SHA-256
values are `7309a1a37068a08b43c6bc3fe2db2c32fc66553fb38374f5a8919a908261f557`
and `75d7c22868024133e6ce09a2a0a9f7dde870ada0cf33dd70e5ea981e90881c58`.
`/feedback` remains deferred.

## July 16, 2026 — Checkpoint 7A retry-safe Calendar event creation

The first focused creation run was deliberately red: all six initial cases
failed because the live Sol contract rejected creation and the Google adapter
implemented only conditional rescheduling. The focused suite was expanded to
18 creation cases covering approval, stable identity, duration, strict shape,
Google reconciliation, family ordering, replay, sanitization and minimal MCP
status. Four restored-green properties were then deliberately broken one at a
time: replacing the stored event ID caused identity-collision failure; allowing
a second insert produced two insert attempts after a lost response; moving
family delivery before Calendar confirmation produced an unsafe message
attempt; and disabling exact Google-response validation accepted mismatched
content. Each mutation made its load-bearing test fail and was reverted.

Creation is a distinct immutable `calendar.create_event` action. Bander stores
`primary`, one generated lowercase base32hex-compatible Google event ID, the
sanitized title, exact RFC3339 start and end, configured IANA timezone and
`default` event type before approval. IDs have the form `b` plus 32 random
lowercase hexadecimal characters, are independently generated per proposal,
remain private, and are reused for every recovery attempt. The Card discloses a
60-minute default unless the request explicitly supplies a duration from 15
minutes through 12 hours. Attendees, recurrence, location, description,
conferencing, attachments, custom reminders and reservations are excluded.

The adapter persists dispatch before `events.insert` and never issues another
insert automatically. A lost response or duplicate-ID result is reconciled
read-only with `events.get` for the exact stored ID. Exact content becomes an
observation-safe result; different content fails closed; a missing event remains
unconfirmed. Family delivery can begin only after a successful or exact observed
Calendar result, and its deterministic creation document is shared byte-for-byte
between Card and delivery.

Live `gpt-5.6-sol` creation evidence passed 8/8 cases with zero false accepts:
relative-date default duration, explicit 90-minute duration, an optional family
update and a Calendar dinner entry were accepted; reservation, invitation,
recurrence and free-form family-message requests failed closed. In the genuine
Telegram/OpenClaw/Google path, three materially different parent phrasings
produced correct Cards. Two were declined before effects. The approved fictional
event `Bander Checkpoint Lunch with Ruth` appears exactly once on Tue, Jul 21,
12:00–1:00 PM MDT. With the family contact revoked, there was no family delivery.
An unsupported restaurant-booking request produced a specific conversational
refusal, no Card and no authority.

The explicit real lost-response probe inserted `Bander 7A Lost Response Probe`
for Wed, Jul 22, 4:00–5:00 PM MDT, discarded the successful response, reconciled
the exact event by its private client ID, and returned `observed_target` on both
the original call and replay. It recorded one insert attempt and zero family
attempts; a separate read confirmed exactly one matching timed event. Both
fictional evidence events were intentionally left on the dedicated Calendar for
the owner to remove manually; no account identifier or event ID was recorded.

Final restored-green matrix: typecheck and production build; 30 functional
files with 357 tests; 20 adversarial tests; all nine unchanged deterministic
sandbox outcomes; one-time and standing recovery verifiers; real OpenClaw
verification with exactly four tools; live compound Sol 18/18, read Sol 7/7 and
create Sol 8/8 with zero create false accepts; dependency audit with zero
vulnerabilities; read-only doctor; and tracked secret scan with zero matches.
Transcript SHA-256 values remain
`7309a1a37068a08b43c6bc3fe2db2c32fc66553fb38374f5a8919a908261f557`
and `75d7c22868024133e6ce09a2a0a9f7dde870ada0cf33dd70e5ea981e90881c58`;
both files remain ignored and untracked. `/feedback` remains deferred.

## 2026-07-16 — Checkpoint 7B: precondition-pinned real Calendar cancellation

Checkpoint 7B added one explicit `calendar.cancel_event` action to the existing
four-tool proposal path. Eligibility is intentionally narrow: the connected
`primary` Calendar, one active timed `default` event, non-recurring,
owner-organized, attendee-free, and resolved by the existing exact normalized
title rule with an optional source date. The immutable action commits the
canonical event identity, exact approved ETag, complete original interval,
timezone, eligibility facts, and optional deterministic family document.
Approval supplies no fresh execution parameters. Standing authority rejects
cancellation.

The first focused run was deliberately red: 14 of 15 cancellation cases failed
because the compiler, contract, authority engine, Google adapter, Telegram
Card/outcome renderer, compound ordering, and recovery classifier had no
cancellation shape. The restored focused cancellation suite passes 25 cases.
The load-bearing mutation checks were also observed red before restoration:

- removing `If-Match` exposed the missing approved ETag in the Google call;
- removing the dispatched-delete guard produced two delete attempts after a
  lost response;
- moving family delivery before Calendar confirmation produced an unsafe
  attempt on stale-world refusal;
- treating an initial 404/410 as success misreported an already-absent event;
- rendering observed absence as causal success failed the observation-safe
  wording assertion; and
- adding compensating insertion after cancellation violated the no-recreation
  invariant.

The production adapter now calls `events.delete` once with the stored event ID,
`sendUpdates: "none"`, an empty request body, and the stored ETag in
`If-Match`. A 412 is changed world. An initial 404/410 is definitively already
absent and is not Bander success. Once dispatch may have begun, Bander never
deletes again: it performs only `events.get` for the exact ID. A cancelled
tombstone or definitive absence becomes observation-safe removal without a
causality claim; an active, changed, unreadable, or unclassifiable event becomes
a typed ambiguous terminal outcome. No unresolved Calendar result can send a
family update, and no path recreates a cancelled event. The 7A wording follow-up
also separates a definitive create rejection from a lost-response create
outcome and consistently asks the parent to check the Calendar before asking
OpenClaw again.

Live bounded Sol evidence passed 8/8 cancellation cases with zero false
accepts: supported Calendar cancellation with and without a family alias, and
safe rejection of restaurant reservation, external-clinic contact, bulk-day,
whole-afternoon, recurring, and free-form-message requests. The existing read
probe passed 7/7, create passed 8/8, and compound passed 18/18 across the final
chunks with zero authority or Calendar mutation. A stale legacy compound label
was corrected from blanket “cancellation unsupported” to the actual unsupported
external-restaurant boundary; no compiler behavior changed.

Real Google evidence used only fictional events in the dedicated account and
printed no identifiers. `Bander 7B Dentist Appointment`, Thu, Jul 23,
1:00–2:00 PM MDT, produced one genuine Telegram Card, one confirmed conditional
delete, and zero matching active events afterward. Approval replay displayed
“Already Done. Nothing ran again,” emitted no second Bander message, and caused
zero additional deletes. The explicit lost-response probe deleted `Bander 7B
Lost Delete Probe`, Sat, Jul 25, 11:00 AM–12:00 PM MDT, discarded Google's
successful response, observed the exact ID absent, and returned
`observed_target` on both initial recovery and replay with exactly one delete
attempt. The stale-world journey pinned `Bander 7B Changed World Appointment`
at Fri, Jul 24, 10:00–11:00 AM MDT; an independent Google change moved it to
10:15–11:15 AM before approval. Bander received the stale precondition,
reported that it did not remove the event, and a read-only check confirmed one
active event remained. Family contact state was revoked throughout, so every
live cancellation path made zero family-delivery attempts; live cancellation
with family remains a pre-film gate rather than a 7B gate.

Final restored-green matrix: typecheck and production build; 31 functional
files with 388 tests; 20 adversarial tests; all nine unchanged deterministic
sandbox outcomes; one-time and standing recovery verifiers; real OpenClaw with
exactly four tools; live compound Sol 18/18, read Sol 7/7, create Sol 8/8, and
cancel Sol 8/8 with zero false accepts; credential-isolation tests; dependency
audit with zero vulnerabilities; and read-only doctor with 9 PASS, 3 expected
WARN, and 0 FAIL. The transcript hashes remain unchanged and both transcript
files remain ignored and untracked. `/feedback` remains deferred.

## 2026-07-16 — Combined Checkpoint 10: external owner and evaluator surface

**Status:** implementation and local verification complete; signed-out GitHub availability requires owner review

The baseline had no resumable setup command, configuration-bound Telegram privacy artifact, selective owner-pairing reset, path-confined Google reauthorization, or manifest-driven local uninstall. The first focused run failed at module load because `setup-lib` and `local-recovery-lib` did not exist. Permanent tests now cover resumable/idempotent milestones, secret-free state and output, signed fresh privacy evidence, exact Gmail scopes, family-aware reset, token-only reauthorization, selective uninstall, corrupt-state failure, and byte-identical synthetic existing OpenClaw state.

`npm run setup` is a repository-local setup guide and verifier. It creates an ignored 0600 template only when `.env` is absent, asks the operator to edit it locally, and never accepts secret input. State contains only a version, random challenge, configuration digest, milestone names, and names of template keys setup created. It refuses paths outside `.bander`, shared Calendar/Gmail token paths, unsafe permissions, stale/mismatched/unsigned Telegram evidence, wrong Calendar timezone, missing/extra Gmail scopes, invalid pairing, and corrupt state. The real runtime remains isolated under repository-generated state and does not inspect or modify `~/.openclaw`.

Recovery is explicit and narrow: `reset:pairing` refuses an active or pending family relationship without `--include-family`; `reauthorize:google` removes only the selected configured token and preserves Desktop client JSON; `uninstall:local` starts with a dry run and removes only versioned manifest entries and unchanged setup-created environment entries. Tests used injected temporary roots only. Synthetic HOME, an outside-root canary, a beside-state canary, and an unrelated repository canary remained byte-identical/present.

Observed deliberate mutations and restored protections:

| Mutation | Observed red result |
| --- | --- |
| Accepted an unexpected Gmail scope | `rejects_extra_or_missing_gmail_scopes` failed because the broad scope no longer threw |
| Returned unredacted setup output | the fake API/bot-token canaries appeared and the redaction test failed |
| Wrote a setup canary into synthetic `~/.openclaw` | the byte-level HOME digest changed |
| Deleted an unrelated canary during uninstall | the isolation test failed with the canary missing |
| Re-ran the completed doctor milestone | the idempotency test observed two calls instead of one |

Judge and documentation surfaces now lead with two no-account commands, three evaluator paths, the supported platform/OAuth boundary, a factual Codex-versus-Sol account, direct evidence anchors, recovery instructions, and the existing-OpenClaw non-installation boundary. `npm run verify:pages` now runs artifact/security/direct-refresh verification and browser/server parity; both lower-level commands remain independently runnable. Pages Actions explicitly empties current OpenAI, Google, Gmail, Telegram, and service credential variables.

Fresh restored-green results: 42 functional files and 468 runtime cases; 3 adversarial files and 26 cases; 27/27 deterministic demo outcomes; unified Pages artifact/direct-refresh plus 3 browser/server parity cases; one-time and standing recovery; exact five-tool real OpenClaw; live compound Sol 18/18, read Sol 7/7, create Sol 8/8, cancel Sol 8/8, and Gmail Sol 7/7 with zero false accepts; typecheck and production build; dependency audit with zero vulnerabilities; tracked/artifact secret scans; and offline doctor at 10 PASS, 3 expected WARN, 0 FAIL. Clean-clone proof completed in 13 seconds on the final warm-cache run: `npm ci` took 4 seconds, setup started without secrets, scripted recovery/isolation passed, the demo started without accounts, no product endpoint was reachable, and the isolated tree stayed clean. Download speed remains the main timing variable.

The final signed-out HTTP check returned 404 for both the repository and Pages target despite the owner-reported public state. No visibility or Pages setting was changed. This external state must be rechecked after push before submission claims it is publicly reachable. Both transcript files remain ignored, untracked, and untouched. `/feedback` remains deferred.

## 2026-07-17 — Combined Checkpoint 11: judge surface freeze

**Status:** complete

The focused baseline run recorded nine red assertions across the Checkpoint 10/11 documentation and Pages surface tests. The current README lacked the judge-first information order, complete read/email/Calendar/family story, fair native-approval distinction, truthful measured timing wording, bounded parent capability summary, and explicit seeded-versus-real evidence copy. Pages lacked the post-outcome real-services exit, uncertainty router sentence, and visually primary repository link. These were behavior/coherence assertions tied directly to the requested public surface; no editorial-only failure was manufactured.

The public Pages URL was then rechecked in the in-app browser after the owner enabled Pages Actions. It resolved successfully with the expected title and deterministic sandbox disclosure. The native accessibility tree already exposed meaningful names for all three primary lane buttons, so no redundant ARIA label was added.

The owner then captured exactly four real Telegram sources using fictional data: the compound Calendar-plus-family Card before approval; the byte-identical update on Gil's separate private Bander chat; a stale-world refusal that stated both effects were stopped; and a harmless schedule read showing distinct Bander and OpenClaw speakers without a new approval Card. Manual privacy review rejected no final source: no personal names or photos, phone numbers, email addresses, handles, numeric identifiers, invite or pairing links, callback data, real Calendar or mail content, unrelated conversations, account-switching UI, or configuration was visible. Raw captures remain outside the repository. The four committed crops/composites carry the visible `REAL INTEGRATION · FICTIONAL TEST DATA` label, contain only source pixels plus the cream/teal evidence frame, and were re-encoded as pixel-only PNGs without EXIF or ancillary text chunks.

The screenshot gate was observed red before the assets existed: the focused Checkpoint 11 test failed on the missing hero asset and missing privacy manifest. The restored focused set passes 31/31 cases across the judge-surface, Checkpoint 10 documentation, product-coherence, sandbox-microcopy, and public-surface tests. The final README now leads with the parent product and no-account browser CTA, tells the 30-second read/email/Calendar/family story, shows the curated real evidence before technical machinery, distinguishes Bander fairly from native approvals, and separates the seeded Pages experience from real-service evidence. A 1200×630 social-preview asset is prepared in the repository but was not uploaded to GitHub settings.

Two verifier isolation defects also surfaced under the real evidence state and were fixed without changing product behavior. The doctor optional-family test had read the developer's live active pairing instead of a temporary fixture; it now creates its own no-family state. The clean-clone verifier checked obsolete setup wording (`edit it locally`) rather than the shipped instruction (`edit .env locally`), and its summary incorrectly claimed the repository contained no screenshots after curated evidence was intentionally added. Both now assert the bounded current behavior. The live family contact remained active and unchanged.

Final Pages QA used the actual `dist-pages` build. The accessibility tree reported nine named buttons and one main heading; the three native lane buttons retained meaningful computed names. Enter and Space activation, visible focus, deep-link double approval, zero page-origin external requests, no nested interactive controls, at-least-44-pixel targets, and no horizontal overflow passed at 1440×900, 1280×720, 500×900, and 375×812. The repository is the primary footer destination, completed outcomes route to real-service evidence, and the changed-world/uncertainty router is visible. Viewport captures stayed in `/private/tmp`.

Final restored-green matrix: 43 functional files with 478 cases; 3 adversarial files with 26 cases; 27/27 deterministic demo outcomes; Pages artifact/security/direct-refresh and 3 browser/server parity cases; final browser accessibility/keyboard/responsive QA; one-time and standing recovery; isolated OpenClaw verification with exactly five real configured tools; typecheck and production builds; dependency audit with zero vulnerabilities; proposed/tracked and Pages-artifact secret scans; clean-clone acceptance in 13 seconds with a 4-second warm-cache `npm ci`; and offline doctor at 12 PASS, 1 expected BotFather-privacy WARN, and 0 FAIL. The transcript hashes remain `7309a1a37068a08b43c6bc3fe2db2c32fc66553fb38374f5a8919a908261f557` and `75d7c22868024133e6ce09a2a0a9f7dde870ada0cf33dd70e5ea981e90881c58`; both files remain ignored, untracked, and untouched. `/feedback`, filming, Devpost submission, repository-topic mutation, social-preview upload, and a final release tag remain deferred.

## 2026-07-17 — Checkpoint 12: final judge surfaces

**Status:** complete locally; public deployment rechecked after push

Checkpoint 12 changed presentation and explanatory copy only. The authority
lifecycle, provider adapters, execution ordering, credential boundaries,
pairing rules, compiler schemas, and exact five-tool real inventory remain
unchanged. The first focused run was deliberately red: 10 of 11 cases failed
because the shipped Telegram copy still used operator-like phrasing, the family
preview did not yet have the final shared deterministic form, and Pages lacked
the requested narrative order, complete verified-example registry, fair
comparison, and setup orientation.

The restored parent surface now scopes every promise to what Bander can prove.
Cards say that Bander has not acted, identify the assistant as the source of the
request, show complete human intervals, and separate the Calendar action from
the exact family message. The family preview and delivered message use the same
renderer byte for byte. The message says it was approved word for word before
Bander sent it; it does not claim the recipient read it. Refusals, uncertain
provider outcomes, expiry, replay, and standing outcomes use equally bounded
language. No all-caps family header or blanket “No one was messaged” claim
remains on the current parent path.

Pages now tells the product story in this order: three real, privacy-reviewed
screenshots; one guided deterministic episode; all 14 verified scenario links;
the trust boundary; a factual OpenClaw-versus-Bander comparison; then three
evaluator paths and five concise setup-orientation disclosures. Every existing
scenario remains reachable: schedule, inbox, exact change, conflict, compound,
ambiguous result, create, cancel, cancel conflict, email, changed email thread,
ambiguous email, direct family update, and standing sandbox. The seeded/non-live
disclosure and CSP remain intact. README gained a compact Build Week judge block
without restructuring the existing document.

Three load-bearing presentation mutations were observed red and restored:

- widening `Bander didn’t message anyone.` to `No one was messaged.` failed the
  truth-scoped Telegram-copy test;
- changing the Card family preview without changing the delivery renderer
  failed the byte-equality test; and
- pointing a scenario link at a nonexistent route failed the complete registry
  and deep-link assertions.

Final restored-green evidence: 46 functional files with 492 cases; 3
adversarial files with 26 cases; 27/27 deterministic demo outcomes; Pages
artifact/security/direct-refresh checks and 3 browser/server parity cases;
page-wide axe checks with zero violations, one main heading, meaningful native
button names, Enter/Space activation, visible focus, no nested controls,
at-least-44-pixel targets, and no overflow at 1440×900, 1280×720, 500×900, and
375×812; one-time and standing recovery; real OpenClaw with exactly five tools;
live non-authoritative Sol probes at compound 18/18, read 7/7, create 8/8,
cancel 8/8, and Gmail 7/7 with zero false accepts; clean-clone acceptance in 14
seconds with a 4-second warm-cache `npm ci`; production build and typecheck;
dependency audit with zero vulnerabilities; and tracked/proposed plus Pages
artifact secret scans with zero matches. Offline doctor reported 11 PASS, 2
expected WARN, and 0 FAIL because an existing local Bander/OpenClaw process was
already using a configured port; it made no changes.

No real Google, Gmail, Telegram, or family-delivery operation was performed for
this presentation checkpoint. The transcript hashes remain
`7309a1a37068a08b43c6bc3fe2db2c32fc66553fb38374f5a8919a908261f557` and
`75d7c22868024133e6ce09a2a0a9f7dde870ada0cf33dd70e5ea981e90881c58`;
both files remain ignored, untracked, and untouched. `/feedback`, parent
testing, filming, submission, and a release tag remain deferred.

## 2026-07-18 — Why now: GPT-5.6 Sol narrative

**Status:** implemented and verified locally; public deployment check pending

The current Pages surface, README, and product source of truth now make one
carefully separated claim: GPT-5.6 Sol supplies reliable bounded interpretation
of imperfect family language, while Bander supplies the trust boundary. The
Pages narrative appears immediately before the fair OpenClaw comparison as a
plain, non-interactive block. README links the claim to the existing live probe
evidence, and the Build Plan states explicitly that model capability and system
trust are separate claims. No surface says that Sol is safe, injection-immune,
or the source of Bander's authority.

The focused coherence test was written first and observed red because none of
the three surfaces carried the new narrative. After implementation it passed
5/5. The requested deliberate mutation then removed the frontier-fit sentence
from README; the same test failed on the missing threshold marker and returned
to 5/5 after restoration. The built Pages JavaScript contains both the kicker
and the trust-separation sentence. Desktop 1440×900 and mobile 375×812 browser
inspection found one visible narrative block, natural wrapping, no horizontal
overflow, and the intended ordering before `THE FAIR QUESTION`.

The complete local functional run passed 51 files and 531 cases; the
adversarial run passed 3 files and 26 cases; the deterministic verifier passed
all 27 outcomes; the Pages artifact verified 10 files plus all 14 direct
scenario destinations and 3 browser/server parity cases; typecheck and both
production/Pages builds passed; the one-time HTTP recovery verifier passed;
the dependency audit found zero vulnerabilities; the tracked/proposed secret
scan found no matches; and offline doctor reported 11 PASS, 2 expected WARN,
and 0 FAIL. A stale Checkpoint 11 assertion exposed by the prior screenshot
capture commits expected exactly four reviewed assets even though the privacy
manifest now contains ten; it was narrowed to the actual invariant that every
curated public asset is present in the manually reviewed manifest.

Standing-recovery and isolated OpenClaw verification could not be rerun in this
session because their required local IPC/loopback processes were denied after
the execution-approval service reached its usage limit. No product failure was
observed, and no workaround or boundary change was made. Commit, push, public
Pages deployment, and the signed-out desktop/mobile check remain pending until
those execution permissions are available. The transcript hashes remain
`7309a1a37068a08b43c6bc3fe2db2c32fc66553fb38374f5a8919a908261f557` and
`75d7c22868024133e6ce09a2a0a9f7dde870ada0cf33dd70e5ea981e90881c58`;
both files remain ignored, untracked, and untouched.
