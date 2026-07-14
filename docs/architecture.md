# Architecture decisions

## ADR-001: Local modular system with an explicit credential boundary

**Status:** accepted, July 13, 2026

The judge experience runs locally from one command. The repository contains a Bander broker/executor, a React user interface, versioned deterministic fixtures, and seeded Calendar/Messages mock services.

The mock services run in a separate process and accept only an internal credential. The Bander broker/executor receives that credential; the OpenClaw process does not. OpenClaw connects only to Bander's narrow Streamable HTTP MCP endpoint.

This boundary is separated because it is expensive to fake convincingly later. The rest remains a modular local system because the hackathon scope has one fictional owner, modest data, and no independent scaling or deployment requirement.

### Failure behavior

- Missing or wrong internal credentials fail closed with no downstream data.
- Stale resource versions fail conditional writes with no mutation.
- Bander timeouts fail the proposed execution; they do not imply success.
- Retried message writes use an idempotency key.
- The optional GPT-5.6 compiler can be unavailable without affecting deterministic Draft execution or tests.

## ADR-002: Standing authority is a hashed structural predicate

**Status:** accepted, July 13, 2026

A standing Band is not a prompt and does not use model judgment at execution time. It stores a versioned predicate, hashes the predicate together with its expiry, renders the review clauses from that same structure, and evaluates each canonical Draft structurally before issuing a short-lived Permit.

The first predicate is intentionally narrow: one Calendar start-time change; owner as organizer and sole attendee; weekdays between 09:00 and 17:00 America/Denver; three actions per rolling 24 hours; no recipients or spending. Any mismatch becomes a normal one-time Card. Revocation and execution share the Band lock so whichever operation acquires it first determines the result.

## ADR-003: GPT-5.6 selects candidates but never authors authority

**Status:** accepted, July 13, 2026

The optional model path maps an agent's claimed request to one versioned local fixture ID using strict Structured Outputs. The model cannot return Calendar IDs, recipients, payloads, preconditions, Bands, or Permits. Deterministic code owns those fields and the complete authority lifecycle.

This deliberately makes the hackathon claim smaller than a general natural-language action compiler. It gives the demo a real GPT-5.6 path while ensuring model unavailability, refusal, ambiguity, or drift cannot block or enlarge the canonical fixture path.
