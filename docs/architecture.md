# Architecture decisions

## ADR-001: Local modular system with an explicit credential boundary

**Status:** accepted, July 13, 2026

The judge experience runs locally from one command. The repository contains a Bander broker/executor, a React user interface, versioned deterministic fixtures, and seeded Calendar/Messages mock services.

The mock services run in a separate process and accept only an internal credential. The Bander broker/executor receives that credential; the OpenClaw process does not. OpenClaw connects only to Bander's narrow Streamable HTTP MCP endpoint.

This boundary is separated because it is expensive to fake convincingly later. The rest remains a modular local system because the hackathon scope has one fictional owner, modest data, and no independent scaling or deployment requirement.

### Failure behavior

- Missing or wrong internal credentials fail closed with no downstream data.
- Stale resource versions fail conditional writes with no mutation.
- Bander records dispatch before every downstream operation and reconciles an idempotent operation record after an ambiguous response loss.
- Permit expiry blocks a missing operation from being dispatched, but does not hide or misreport an operation that already committed.
- Human Telegram outcomes are marked delivered only after Telegram confirms `sendMessage`. Delivery is at least once; an ambiguous crash after Telegram accepted a message can produce a duplicate truthful notification on retry.
- The optional GPT-5.6 compiler can be unavailable without affecting deterministic Draft execution or tests.

## ADR-002: Standing authority is a hashed structural predicate

**Status:** accepted, July 13, 2026

A standing Band is not a prompt and does not use model judgment at execution time. It stores a versioned predicate, hashes the predicate together with its expiry, renders the review clauses from that same structure, and evaluates each canonical Draft structurally before issuing a short-lived Permit.

The first predicate is intentionally narrow: one duration-preserving Calendar reschedule; owner as organizer and sole attendee; the complete resulting interval starts and finishes on the same weekday between 09:00 and 17:00 America/Denver; three actions per rolling 24 hours; no recipients or spending. Any mismatch becomes a normal one-time Card. Revocation and execution share the Band lock so whichever operation acquires it first determines the result.

## ADR-003: GPT-5.6 selects candidates but never authors authority

**Status:** accepted, July 13, 2026

The optional model path maps an agent's claimed request to one versioned local fixture ID using strict Structured Outputs. The model cannot return Calendar IDs, recipients, payloads, preconditions, Bands, or Permits. Deterministic code owns those fields and the complete authority lifecycle.

This deliberately makes the hackathon claim smaller than a general natural-language action compiler. It gives the demo a real GPT-5.6 path while ensuring model unavailability, refusal, ambiguity, or drift cannot block or enlarge the canonical fixture path.

## ADR-004: Every execution shape uses one idempotent operation record

**Status:** accepted, July 13, 2026

The Permit nonce is the downstream operation key. Bander stores `dispatchedAt` before the call, and the credential-holding mock service binds that key to the Draft hash and committed result. Calendar-only and combined Calendar/Messages execution use the same endpoint and recovery protocol.

After an ambiguous failure, Bander first asks whether that exact operation committed. A committed result is finalized into one consumed Permit and one truthful Receipt even if the Permit has since expired. If no operation exists and the Permit is expired, Bander does not dispatch it.

## ADR-005: Natural agent requests select bounded candidates outside authority

**Status:** accepted, July 13, 2026

The MCP proposal tool accepts the person's natural request verbatim, not an internal fixture ID. In no-key mode, deterministic code matches only the discoverable versioned requests returned by `list_capabilities`; adjacent wording requests clarification. When configured, GPT-5.6 may replace only this selection step. Both paths produce the same versioned candidate and cannot approve, mint authority, or supply execution parameters.

## ADR-006: Telegram privacy is an empirical release gate

**Status:** accepted after empirical Telegram spike, July 14, 2026

The intended consumer flow uses separate OpenClaw and Bander Telegram bots in one test group. Bander must own its messages, callbacks, identity checks, and approval surface. OpenClaw must receive only the owner's natural request and Bander's minimal MCP status—not Bander's Card, Receipt, conflict details, callback payloads, or canary.

This boundary cannot be accepted from documentation or configuration review alone. Telegram's current Bot-to-Bot Communication Mode can deliver other-bot messages to a bot whose group privacy is disabled, and the installed OpenClaw Telegram handler does not categorically discard every other bot. The release gate therefore requires Bot-to-Bot Communication Mode to be disabled, an owner-only OpenClaw group sender allowlist, and inspection of OpenClaw's exported model trajectory after real messages and callbacks in the target group.

The empirical spike passed, and the accepted one-time implementation now lives in the Bander broker process as a Bander-owned Telegram service. Pairing begins with an expiring single-use token in a private Bander-bot chat. Telegram's private `request_chat` picker then returns the selected group to Bander through `chat_shared`. The token and destination selection never enter the shared group or OpenClaw.

The service persists one installation and per-proposal bindings containing the installation, owner, group, Bander-authored message, opaque callback value, Draft, expiry, and lifecycle. Every exact legitimate callback and replay calls the authority engine's idempotent `approveAndExecute` method. Callback authorization has no test-ordering state. OpenClaw and Bander bot credentials are projected into separate process environments; only Bander holds downstream credentials.

The first valid private pairing claim fixes the claimant identity for that attempt. The same claimant may finish private group selection; another holder of the still-unconsumed token cannot replace the owner. The token is consumed only after the selected group is bound.

The local Streamable HTTP MCP endpoint remains deliberately unauthenticated in the hackathon reference build. It binds to `127.0.0.1`, accepts no agent-controlled owner identity, and is limited to 30 POST requests per source address per 60-second fixed window. This is a local demonstration boundary, not a deployable network authentication design.

## ADR-007: Standing Telegram outcomes reuse engine authority

**Status:** accepted after real-service verification, July 14, 2026

The Telegram service stores one active standing-Band binding for the single-owner installation and one outcome binding per Band and client request ID. The request ID and normalized request digest remain enforced by the authority engine. Telegram does not create a Draft, Permit, Receipt or counter entry itself.

An eligible request enters `runStandingBand`, which serializes execution under the Band lock and returns the existing Receipt on replay. Bander persists the human outcome before attempting Telegram delivery and records delivery only after `sendMessage` succeeds. Therefore real-world execution is exactly once and the Telegram outcome is at least once. A crash after Telegram accepted the message but before the delivered write may produce a duplicate truthful outcome on recovery.

The outcome includes the rolling action count and an opaque **Turn off** callback bound to the installation, owner, chat and Bander-authored message. Revocation calls the public idempotent `revokeBand` method directly; it does not call it while holding the engine Band lock. Execution and revocation therefore acquire that lock exactly once and are serialized by the engine. OpenClaw receives only Draft ID and lifecycle status, including the minimal `conflict` status when standing execution encounters a changed-world precondition.
