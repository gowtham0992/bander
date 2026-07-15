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

OpenClaw now acknowledges a proposed action with “I’m checking with Bander. Nothing has happened yet.” Executed standing results use distinct wording and never make that false non-action claim. Unsupported input receives the requested friendly clarification. The pinned current OpenClaw Telegram `errorPolicy` is `always`; Context7 and the installed OpenClaw documentation confirm that this sends channel errors instead of silently suppressing them. Compiler refusal crosses MCP only as `{status:"unsupported"}` without model-authored detail. Exactly three MCP tools remain configured.

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
