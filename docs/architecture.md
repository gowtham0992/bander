# Architecture decisions

This document describes the implemented Build Week architecture as of July 16, 2026. Parent-facing copy avoids the internal authority terms used here.

## ADR-001: Real and sandbox are separate fail-closed runtimes

**Status:** accepted

The repository has two deliberately distinct product paths:

- **Real:** live conversational OpenClaw, exact model `gpt-5.6-sol`, Bander's Google Calendar adapter, one bound Telegram owner/group, and no fixture or mock-service routes.
- **Sandbox:** deterministic provider, versioned fixtures, seeded credential-protected mock services, and no claim of Google access.

`npm run real` supervises a fresh broker and OpenClaw gateway. Before printing ready, it verifies `runtimeMode: real`, the Google Calendar and Gmail backends, real action and read compilers, paired Telegram installation, exact five-tool inventory, live model configuration, credential separation, and missing fixture/standing demo routes. It refuses an existing broker rather than attaching to a possibly stale sandbox.

## ADR-002: The protected OpenClaw profile has a small exact tool inventory

**Status:** accepted

The dedicated profile can call:

- `bander__list_capabilities`
- `bander__read_schedule`
- `bander__propose_action`
- `bander__get_receipt`

The OpenClaw model may converse normally, ask Bander for one bounded schedule range, and decide whether to propose a clear Calendar action. It cannot approve, mint authority, author a Card or outcome, choose a Calendar/account/API query, or call Google directly. Its environment contains the OpenAI key and OpenClaw Telegram token needed for its own work, but not Google OAuth paths, the Bander Telegram token, mock-service credentials, Calendar tools, browser, shell, or generic outbound-action tools.

The strong route property applies only inside this profile. Bander does not restrict other OpenClaw profiles or a host compromised at the operating-system/user-account level.

## ADR-003: Bander owns Google OAuth and the conditional write

**Status:** accepted after real Google risk spike

Bander uses desktop OAuth with PKCE S256 and a loopback callback. It requests only `https://www.googleapis.com/auth/calendar.events.owned`, fixes the Calendar ID to `primary`, and keeps the OAuth client/token files under ignored local storage with private permissions.

Real reschedule eligibility is narrow: timed, non-recurring, owner-organized, no attendees. Bander reads the canonical ID, title, complete start/end interval, timezone, organizer, attendees, and ETag. Execution sends only the approved start/end fields, preserves exact duration, sets `sendUpdates: "none"`, and uses the approved ETag in `If-Match`.

Real creation is a separate action shape: one timed `default` event on `primary`, no attendees, recurrence, location, description, conferencing, attachments, custom reminders, booking, or reservation. Bander generates a cryptographically random lowercase base32hex-compatible client event ID once per proposal and commits it with the sanitized title, exact start/end, and configured IANA timezone. After dispatch it never issues another insert automatically. A lost response or duplicate-ID result is reconciled only with `events.get` for that exact stored ID; exact content is reported as observed, different content fails closed, and a missing event remains unconfirmed.

Real cancellation is a third explicit action shape for one active timed `default` event on `primary` that is non-recurring, owner-organized, and attendee-free. The immutable action stores the canonical event ID, exact ETag, complete original interval, timezone, and eligibility facts. Execution calls `events.delete` once with `sendUpdates: "none"` and the stored ETag in `If-Match`; it sends no body and never recreates the event. A stale ETag is changed world. An initial 404/410 is already absent rather than success. After an ambiguous dispatched delete, Bander never deletes again: it reads only the exact ID, treats a cancelled tombstone or action-specific 404/410 absence as observation-safe removal, and otherwise records an ambiguous terminal result with no family delivery. Authorization, rate-limit, timeout, server, network, and malformed-client lookup failures never collapse into absence.

A 412 is a changed-world conflict, not permission to re-plan. Bander performs no automatic refetch-and-write. Concurrent empirical tests show that two writes using the same approved ETag allow one commit and make the other fail precondition. Timeout reconciliation may describe only the Calendar state Bander later observes; it must not claim causality it cannot prove.

## ADR-004: GPT-5.6 Sol compiles intent but cannot author authority

**Status:** accepted after live Responses API evidence

Real mode uses a separate strict Structured Output call with exact model ID `gpt-5.6-sol`. The output contract contains:

- action kind (`reschedule_event`, `create_event`, or `cancel_event`);
- event-title hint;
- optional source-local-date hint;
- required target local date;
- required target local start;
- optional duration minutes for creation;
- whether a paired-family update was requested; and
- the human alias used for that contact.

If no source date is supplied, deterministic code searches a bounded upcoming 31-day window and requires exactly one eligible normalized title match. Date resolution uses the configured connected-Calendar timezone; the selected authoritative event supplies the complete interval and timezone.

The model cannot select a recipient address, Telegram identifier, notification body, Calendar ID, event ID, ETag, timezone, final end, effects, authority, or execution parameters. Bander resolves an alias only against the one active, operator-configured contact, generates any create identity itself, and constructs the notification from the authoritative Calendar action. Invalid, missing, ambiguous, broadened, or malformed output fails closed. Clarification text is deterministically mapped and delivered by Bander; model-authored Calendar details do not cross the MCP boundary.

## ADR-005: Authority binds approval to one immutable action

**Status:** accepted

Internally, Bander uses Draft → Card → Band → Permit → Receipt:

- the Draft contains the canonical effect and precondition snapshot;
- the Card renders only that stored Draft;
- approval creates a one-time Band and internal Permit for the Draft hash;
- execution uses no new agent parameters; and
- the Receipt records the observed committed result.

Every execution shape has one idempotent downstream operation identity. Bander records dispatch before the call. A retry with the same Draft hash reuses existing authority and reconciles the operation; it does not mint another Band or Permit. A different hash, terminal decline, conflict, revocation, or expired-undispatched Permit fails closed.

The sandbox mock service can truthfully reconcile an operation after a lost response. The current real Google adapter uses observed Google state and ETag behavior; it does not overclaim that Bander caused a state merely because the state matches.

For a compound deal, the immutable Draft contains both the complete Calendar
create, reschedule, or cancellation action and the exact opaque family-contact pairing revision plus canonical
notification document. The Card and delivery use the same renderer. Execution
is deliberately ordered: validate and conditionally update Calendar first,
then attempt the bound family update. This is not an atomic distributed
transaction. The human outcome is built from observed effect results and can
truthfully report Calendar success with ambiguous or absent family delivery.

## ADR-006: Telegram is a separate human authority surface

**Status:** accepted after empirical privacy verification

Bander does not ambient-listen to the group. The Bander-owned service holds its bot credential, installation, Card delivery, callback ingestion and authorization, engine execution, refusal delivery, and outcome delivery. OpenClaw and Bander use visibly distinct Telegram identities.

Pairing uses an expiring high-entropy private-chat deep link and Telegram's group picker. The first valid claimant is locked to the attempt; the token is consumed after the group is bound. The agent never receives or selects the token, owner, or destination.

Each proposal callback binds the installation, owner Telegram ID, chat ID, Bander-authored message ID, opaque callback value, Draft, expiry, and lifecycle. Approval and replay always enter the engine's idempotent approval method. Decline is terminal and idempotent. Wrong owner, chat, message, bot, callback, expiry, or changed content fails closed.

The accepted bot policy is: Bot-to-Bot Communication off for both bots, OpenClaw Group Privacy off, Bander Group Privacy on, owner-only sender allowlist, bound group only, `requireMention: false`, `historyLimit: 0`, and restricted context visibility. Exported OpenClaw trajectories may contain the bounded schedule DTO when the parent asks a read question. They must contain no human Card, callback, writable Calendar identifier or precondition, action/refusal detail, credential, or Bander outcome.

## ADR-007: Execution and human notification have different retry guarantees

**Status:** accepted

Downstream execution is idempotent. Human Telegram notification is at least once. Bander attempts the Telegram send before persisting delivered state, so a failed send remains retryable. A crash after Telegram accepted a message but before the delivered-state write can produce a duplicate truthful notification; silent execution is considered worse.

Changed-world refusal follows the same delivery rule. A failed refusal send stays pending; retry sends the same deterministic human explanation while OpenClaw retains only minimal `conflict` status.

## ADR-012: One family contact is a Bander-owned routing setup, not authority

**Status:** accepted for the current prototype

The real Telegram installation may contain at most one active family contact.
The local technical owner configures the contact's display label and normalized
aliases before pairing; Bander never derives them from the model or the
contact's Telegram profile. A high-entropy, short-lived token is hashed in the
existing owner-only Telegram state file. The raw deep link is written to an
ignored `0600` file and sent only to the already authenticated owner's private
Bander chat.

The invited person must claim the link in a private human Telegram chat, where
the chat ID equals the sender ID, explicitly accept the limited role, differ
from the owner, and be outside the protected owner group. The first claimant is
persisted before consent delivery, so a second claimant cannot take over after
an interrupted send. Bander checks membership again at acceptance and real
startup. An unknown Telegram membership result fails closed; a contact found in
the protected group is rejected or system-revoked.

The contact receives no authority. They cannot approve, decline, replay owner
callbacks, view the group, query a schedule, call OpenClaw, add or redirect a
contact, or alter aliases. Contact private messages stay in Bander and receive
only bounded role help. No MCP tool exposes routing identifiers; the real
This pairing boundary does not add an MCP tool; after Checkpoint 8 the real OpenClaw inventory remains exactly five tools.

Either the contact's private `/disconnect` or the owner's Bander-owned group
control revokes the relationship idempotently. Revocation removes the raw
Telegram destination and invalidates pending links, retaining only opaque audit
hashes needed to recognize replay. Startup removes any stale local link file.
Pairing by itself delivers no Calendar facts, Cards, outcomes, or action
authority. A later approved compound deal may use the exact bound route under
the separate delivery boundary below.

## ADR-013: Family notification delivery is durable but not exactly once

**Status:** accepted after live Telegram verification

Only Bander resolves the active contact's private destination. A structured
Calendar-transition document contains a sanitized title, complete new interval,
and timezone; it has no destination or free-form body field. Bander renders
plain Telegram text without Markdown, HTML, links, mentions, attachments,
callbacks, or buttons. OpenClaw and MCP cannot invoke delivery and receive no
content or routing details.

Each caller-generated request ID is durably bound to the installation, opaque
contact ID, exact pairing revision, and canonical content digest before
transport. Identical confirmed replays return the same minimal status without a
send. Changed content fails closed. Revocation and dispatch share the Telegram
state critical section through the send boundary, so revocation first means no
send, while dispatch first targets only the original pairing before revocation
completes.

Telegram `sendMessage` has no client idempotency key, so Bander does not claim
exactly-once delivery. It persists `dispatching` before the call. A confirmed
response stores Telegram's message ID privately and yields `delivered`. A lost,
failed, or restart-interrupted response becomes permanently `ambiguous`; replay
does not send again and must not claim the contact was notified. Telegram's
confirmed acceptance is not proof that the human read the message.

Compound execution derives one stable family-delivery request ID from the
approved Draft and internal Permit. Approval replay therefore returns the same
observed outcome without another Calendar patch or Telegram attempt. The exact
contact pairing is bound when the proposal is created; a revoked or replacement
contact makes the family effect `not_sent` and is never substituted. Calendar
conflict or failure occurs before the message boundary and produces zero family
attempts. If a Google write response is ambiguous, Bander rereads the exact
event and proceeds only when the authoritative event is observed at the exact
approved target; that observation does not prove who caused the change.

## ADR-008: Standing autonomy remains sandbox-only in the current product claim

**Status:** accepted scope boundary

The engine and Telegram service contain a fully verified narrow standing predicate: solo owner events, duration preserved, weekdays within work hours, three moves per rolling day, no messages or spending, and serialized idempotent revocation. The explanation is rendered from the enforced predicate, not model prose.

That path remains part of Hero and the deterministic verification matrix. It is not presented as a current real-Google product capability and is not part of the canonical Build Week film.

## ADR-009: Persistence is intentionally incomplete for the prototype

**Status:** accepted limitation

Telegram installation and delivery/callback bindings are file-backed under ignored `.bander/` storage. Core authority state in the running real broker remains in memory and is not restart-durable. The sandbox exercises ambiguous-response recovery, but the public product does not claim durable production authority across a broker restart.

A future production version needs transactional durable authority storage, migrations, and startup reconciliation. This checkpoint does not add them.

## ADR-010: The local MCP endpoint is not a network deployment boundary

**Status:** accepted limitation

The Streamable HTTP MCP endpoint binds to `127.0.0.1`, accepts no agent-controlled owner identity, and rate-limits proposal traffic. It has no application-level authentication and must not be exposed to a LAN or public network. The prototype's trust boundary assumes the local OS/user account is not already compromised.

## ADR-011: Schedule reading is a separate bounded data lane

**Status:** accepted after live Google + Telegram evidence

Real mode alone adds `bander__read_schedule`. Its sole input is the newest natural user request verbatim; the caller cannot provide a Calendar ID, account, query, filter, timezone, event ID, or API parameter. A separate live `gpt-5.6-sol` Structured Output call may return only the start local date, exclusive end local date, clarification state, and one short clarification question. Deterministic Bander code resolves relative dates in the connected primary Calendar's authoritative timezone using an injected clock, rejects missing or ambiguous ranges, and enforces a maximum of 31 calendar days.

The Google boundary performs only a primary-Calendar event listing for this lane. It returns a separate DTO capped at 50 deterministically ordered events: sanitized title, human-relevant start/end, all-day state, authoritative timezone, requested range, and honest empty/truncated state. Timed, all-day, and recurring occurrences are readable; that does not make them eligible for writable authority. Calendar IDs, event IDs, ETags, sequence, organizer/attendee data, descriptions, locations, conference links, attachments, OAuth/account data, and internal metadata are omitted.

Calendar titles are untrusted data. Bander normalizes them, strips control and bidirectional-control characters, bounds them to 120 characters, and tells OpenClaw to treat them only as quoted data—not instructions or a reason to call an action tool. This narrows exposure but does not claim to solve prompt injection: schedule facts intentionally enter the model trajectory, and a model can still mis-summarize benign or adversarial text. Consequential execution remains structurally unreachable from the read handler, and action tools require a later genuine human request.

The Hero/reference sandbox remains on its historically verified three-tool profile. The canonical real product has exactly five Bander tools, adding `bander__read_inbox`; the distinction is asserted at startup and in the real-process verifier.

## ADR-016: Gmail is a separate bounded read/reply boundary

**Status:** accepted for Checkpoint 8

Gmail uses a separate OAuth token path with exactly `gmail.readonly` and `gmail.send`; it may reuse the Desktop client document but never broadens or replaces the Calendar token. `bander__read_inbox` accepts only the newest natural request. Sol extracts sender, subject, bounded date range, and explicit-latest intent; deterministic Bander code constructs the Gmail search, excludes spam/trash, requires a unique match unless latest was explicit, and returns a separate sanitized DTO without Gmail identities, raw headers, attachments, or hidden HTML. Email facts intentionally enter OpenClaw’s trajectory for answering the parent. Sanitization and an untrusted-data prompt reduce exposure but are not prompt-injection detection.

`email.reply` remains behind `bander__propose_action`. One immutable deal pins the source/thread/latest-message identities, one valid Reply-To or From address, subject/threading headers, exact plain text, stable RFC Message-ID, an opaque `X-Bander-Operation` value derived from that identity, canonical MIME bytes, and digests. Execution rereads the thread and refuses if a newer message exists. Dispatch is recorded before Gmail send. Live evidence showed that Gmail rewrites the caller-supplied RFC Message-ID, so it is not a reliable recovery key. An ambiguous send is never repeated: Bander scans at most 25 recent Sent messages, accepts only one exact opaque-header/recipient/thread/subject/body match as observation-safe, and otherwise remains terminally ambiguous. The opaque header is deterministic Bander state, never model-authored or exposed through MCP.

Independent family messages use the existing `family.telegram_notification` effect with a separate `direct_message` document. The parent-requested plain text is sanitized, stored, hashed, shown, and delivered unchanged to only the exact active pairing revision. This differs from Calendar-bound family updates, whose text is deterministically rendered from authoritative Calendar state.

## ADR-014: Parent explanation is Bander-owned and delivered once

**Status:** accepted for the current prototype

After authenticated owner/group pairing, the Bander Telegram service posts one
plain-text introduction to the bound protected group. The selected group comes
only from the persisted installation, never an agent parameter. Confirmed
delivery stores the Telegram message ID and delivery timestamp; startup and
pairing replay therefore do not resend it. A definite send failure leaves the
introduction pending for startup recovery and creates no authority or Calendar
activity.

The zero-account browser experience is a deterministic sandbox. Its seeded
schedule read creates no authority. Its move, create, and cancellation deals use
the production Card previews and family-notification document renderer, and its
simulated phone receives the same bytes displayed on the Card. Create and
cancellation approval, decline, replay, and changed-world behavior operate on
the same seeded Calendar pane. Its ambiguous Calendar scenario deliberately
records an unknowable external result, sends no family update, and never claims
that nothing changed. The sandbox never loads real Google, Telegram, or OpenAI
credentials.

## ADR-015: Setup diagnosis is read-only and sanitized

**Status:** accepted for the current prototype

`npm run doctor` performs offline configuration, dependency, file-permission,
ignore-rule, port, and persisted-state validation without requiring `.env` to
exist. Missing setup is a reported result, not an exception. `--live` adds only
read operations: Bander bot/group/owner reachability, the connected primary
Calendar timezone, and the running MCP tool inventory. It does not send a
Telegram message, patch Calendar data, call an action tool, create authority,
or change persisted pairing state. The bounded OpenAI evidence call remains in
the dedicated Sol verifier so the doctor does not spend or compile intent.

Human and JSON output contain fixed explanations, environment-variable names,
safe software versions, status, and the authoritative timezone. They omit
secret values, raw provider errors, Telegram/Calendar identifiers, callback
values, OAuth content, and private file paths. Telegram's API cannot prove all
BotFather privacy settings, so the doctor always reports that boundary as an
empirical-check warning instead of inferring a pass.

`npm run verify:clean-clone` copies only tracked and proposed non-ignored files
into a generated directory under `/private/tmp`, installs from the lockfile,
and proves the no-account doctor and 27-outcome deterministic sandbox. Product
credentials are removed from the verifier subprocess environment, and outbound
Google, Telegram, and OpenAI product endpoints are blocked while local loopback
services remain available. Cleanup is restricted to the verifier's own
generated prefix.
