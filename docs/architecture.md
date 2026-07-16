# Architecture decisions

This document describes the implemented Build Week architecture as of July 15, 2026. Parent-facing copy avoids the internal authority terms used here.

## ADR-001: Real and sandbox are separate fail-closed runtimes

**Status:** accepted

The repository has two deliberately distinct product paths:

- **Real:** live conversational OpenClaw, exact model `gpt-5.6-sol`, Bander's Google Calendar adapter, one bound Telegram owner/group, and no fixture or mock-service routes.
- **Sandbox:** deterministic provider, versioned fixtures, seeded credential-protected mock services, and no claim of Google access.

`npm run real` supervises a fresh broker and OpenClaw gateway. Before printing ready, it verifies `runtimeMode: real`, the Google backend, real compiler, paired Telegram installation, exact three-tool inventory, live model configuration, credential separation, and missing fixture/standing demo routes. It refuses an existing broker rather than attaching to a possibly stale sandbox.

## ADR-002: The protected OpenClaw profile has exactly three Bander tools

**Status:** accepted

The dedicated profile can call:

- `bander__list_capabilities`
- `bander__propose_action`
- `bander__get_receipt`

The OpenClaw model may converse normally and decide whether to propose a clear Calendar action. It cannot approve, mint authority, author a Card or outcome, or call Google directly. Its environment contains the OpenAI key and OpenClaw Telegram token needed for its own work, but not Google OAuth paths, the Bander Telegram token, mock-service credentials, Calendar tools, browser, shell, or generic outbound-action tools.

The strong route property applies only inside this profile. Bander does not restrict other OpenClaw profiles or a host compromised at the operating-system/user-account level.

## ADR-003: Bander owns Google OAuth and the conditional write

**Status:** accepted after real Google risk spike

Bander uses desktop OAuth with PKCE S256 and a loopback callback. It requests only `https://www.googleapis.com/auth/calendar.events.owned`, fixes the Calendar ID to `primary`, and keeps the OAuth client/token files under ignored local storage with private permissions.

Real event eligibility is narrow: timed, non-recurring, owner-organized, no attendees. Bander reads the canonical ID, title, complete start/end interval, timezone, organizer, attendees, and ETag. Execution sends only the approved start/end fields, preserves exact duration, sets `sendUpdates: "none"`, and uses the approved ETag in `If-Match`.

A 412 is a changed-world conflict, not permission to re-plan. Bander performs no automatic refetch-and-write. Concurrent empirical tests show that two writes using the same approved ETag allow one commit and make the other fail precondition. Timeout reconciliation may describe only the Calendar state Bander later observes; it must not claim causality it cannot prove.

## ADR-004: GPT-5.6 Sol compiles intent but cannot author authority

**Status:** accepted after live Responses API evidence

Real mode uses a separate strict Structured Output call with exact model ID `gpt-5.6-sol`. The output contract contains:

- event-title hint;
- optional source-local-date hint;
- required target local date; and
- required target local start.

If no source date is supplied, deterministic code searches a bounded upcoming 31-day window and requires exactly one eligible normalized title match. Date resolution uses the configured connected-Calendar timezone; the selected authoritative event supplies the complete interval and timezone.

The model cannot select the Calendar ID, event ID, ETag, final end, effects, authority, or execution parameters. Invalid, missing, ambiguous, broadened, or malformed output fails closed. Clarification text is deterministically mapped and delivered by Bander; model-authored Calendar details do not cross the MCP boundary.

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

## ADR-006: Telegram is a separate human authority surface

**Status:** accepted after empirical privacy verification

Bander does not ambient-listen to the group. The Bander-owned service holds its bot credential, installation, Card delivery, callback ingestion and authorization, engine execution, refusal delivery, and outcome delivery. OpenClaw and Bander use visibly distinct Telegram identities.

Pairing uses an expiring high-entropy private-chat deep link and Telegram's group picker. The first valid claimant is locked to the attempt; the token is consumed after the group is bound. The agent never receives or selects the token, owner, or destination.

Each proposal callback binds the installation, owner Telegram ID, chat ID, Bander-authored message ID, opaque callback value, Draft, expiry, and lifecycle. Approval and replay always enter the engine's idempotent approval method. Decline is terminal and idempotent. Wrong owner, chat, message, bot, callback, expiry, or changed content fails closed.

The accepted bot policy is: Bot-to-Bot Communication off for both bots, OpenClaw Group Privacy off, Bander Group Privacy on, owner-only sender allowlist, bound group only, `requireMention: false`, `historyLimit: 0`, and restricted context visibility. Exported OpenClaw trajectories must contain no human Card, callback, Calendar/refusal detail, or Bander outcome.

## ADR-007: Execution and human notification have different retry guarantees

**Status:** accepted

Downstream execution is idempotent. Human Telegram notification is at least once. Bander attempts the Telegram send before persisting delivered state, so a failed send remains retryable. A crash after Telegram accepted a message but before the delivered-state write can produce a duplicate truthful notification; silent execution is considered worse.

Changed-world refusal follows the same delivery rule. A failed refusal send stays pending; retry sends the same deterministic human explanation while OpenClaw retains only minimal `conflict` status.

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
