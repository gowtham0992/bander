# Bander

## Product source of truth — July 15, 2026

This document describes the implementation that exists today and the final Build Week product position. Historical red/green evidence remains in [BUILD_WITH_CODEX.md](BUILD_WITH_CODEX.md).

## 1. Product promise

**The OpenClaw I’d actually give my parents.**

OpenClaw helps. Bander holds the keys and independently confirms what happened.

Bander is a confidence layer for personal AI agents. The agent can converse and propose a real-world action. Bander independently resolves the authoritative object, shows the person the exact deal, and performs only the stored action that the bound person approves.

The core claim stays small and testable:

> Bander does not judge what an agent wants. For effects routed through Bander, nothing happens beyond the specific deal the person saw and approved.

## 2. Canonical real-product journey

The filmed Build Week journey is:

1. A parent speaks naturally in one private Telegram group.
2. A dedicated Bander-protected OpenClaw profile converses normally and uses genuine `gpt-5.6-sol` tool selection.
3. For a clear Calendar move, OpenClaw sends the newest natural request through one of exactly three Bander tools.
4. Bander makes a separate live `gpt-5.6-sol` call that returns only bounded intent fields.
5. Deterministic Bander code discovers exactly one eligible event on the connected primary Google Calendar, reads its complete interval, timezone, organizer, attendees, and ETag, and constructs the immutable action.
6. The separate Bander Telegram bot posts the complete old and new intervals and asks the bound owner to approve or decline.
7. Approval executes the stored start/end-only change with the approved ETag. Decline is terminal. A stale ETag stops with no retry against a changed plan.
8. Bander independently reports the authoritative Google result to the person. OpenClaw receives only a minimal lifecycle status.

The canonical command is `npm run real`. It supervises both the Bander broker and a fresh real OpenClaw gateway, validates the runtime boundary, and refuses stale/mock coexistence.

## 3. Current real capability

Implemented in real mode:

- conversational OpenClaw for greetings and ordinary chat, with no Bander call unless the model genuinely selects a Bander tool;
- natural-language Google Calendar rescheduling;
- primary Calendar only;
- timed, non-recurring, owner-organized, attendee-free events only;
- one exact normalized title match, optionally narrowed by a source date;
- a bounded 31-day upcoming search when no source date is supplied;
- required target local date and target local start;
- complete source/destination disclosure, duration preservation, cross-day moves, and IANA timezone handling;
- owner-bound Telegram approval and decline;
- ETag/`If-Match` conditional writes with `sendUpdates: "none"`;
- changed-world refusal with zero Bander mutation; and
- a human-only outcome constructed from the authoritative committed event.

Zero or multiple matches, missing destination fields, unsupported cancellation, unsupported event shapes, malformed or broadened model output, and Google failures create no authority.

## 4. Parent-facing experience

OpenClaw and Bander have distinct jobs and identities.

- **OpenClaw** is the warm assistant. It converses, acknowledges a clear action request once, and may ask Bander to prepare it.
- **Bander** is the protective identity. It does not ambient-listen to the group. It posts the review, accepts the bound owner's button callback, performs the conditional write, and posts the result or refusal.

Parent-facing messages use ordinary language, human dates and times, and a next step. They do not expose internal authority nouns, IDs, hashes, ETags, OAuth details, or MCP terminology. Agent-supplied text remains clearly attributed to OpenClaw, plain text, flattened, and unable to forge Bander-authored sections or buttons.

The person can always tell whether anything happened:

- before approval: “Nothing has happened yet.”
- decline: “Nothing changed.”
- success: complete authoritative before/after interval;
- changed world: “I stopped—your calendar changed since you asked. Nothing was moved.”
- clarification or unsupported request: a specific reason and safe next step from Bander's independent identity.

## 5. Security boundary

Use this statement verbatim in public materials:

> In the Bander-protected OpenClaw profile, the model can converse and propose through three bounded Bander tools. It does not receive the connected Google credential, cannot approve its own proposal, and cannot author Bander’s Card or outcome. Bander does not protect a host already compromised at the operating-system/user-account level.

The strong route claim applies only to the dedicated protected profile and only to effects routed through Bander. It does not restrict another OpenClaw profile, another tool, another credential, or another process owned by the user.

The protected OpenClaw process may use network access to reach its model provider and Bander's loopback MCP endpoint. It does not receive Google OAuth client/token paths, the Bander bot credential, mock-service credentials, Calendar tools, a browser, a shell, or generic outbound-action tools.

The local MCP endpoint is unauthenticated and loopback-only. This prototype must not expose it to a LAN or the public internet.

## 6. Technical authority lifecycle

The parent interface avoids these terms; the technical implementation uses them deliberately:

- A **Draft** is an immutable canonical action plus authoritative preconditions and a hash.
- A **Card** is Bander's deterministic human rendering of that stored Draft.
- A one-time **Band** records exactly what the owner approved.
- A short-lived **Permit** is internal execution authority for that one Draft hash.
- A **Receipt** records the observed committed result.

Approval does not accept fresh agent parameters. It loads the stored Draft, verifies the same owner/chat/Bander-authored message/callback binding, mints authority once, records dispatch before the downstream call, and reuses the same operation identity on replay. A different Draft hash, terminal decline, revocation, conflict, or expired-undispatched Permit fails closed.

Google execution uses the canonical event ID and approved ETag stored in the Draft. It updates only start and end, preserves exact duration, fixes Calendar ID to `primary`, and uses `sendUpdates: "none"`. Bander never automatically refetches and executes a different plan after a precondition failure.

Human Telegram notification is at least once. Delivery is marked complete only after Telegram confirms the send. A crash after Telegram accepted a message but before the delivered-state write may produce a duplicate truthful notification; that is safer than silent execution.

## 7. GPT-5.6 Sol's bounded role

Real mode uses the exact model ID `gpt-5.6-sol` in two places:

1. OpenClaw uses it for conversation and genuine tool selection.
2. Bander uses a separate Responses API Structured Output call to extract:
   - `eventTitleHint`;
   - optional `sourceLocalDateHint`;
   - required `targetLocalDate`; and
   - required `targetLocalStart`.

The model does not select a Calendar ID, event ID, ETag, final end, recipient, effect, authority object, or execution parameter. Deterministic code resolves the real event, calculates the final end from its exact duration, constructs the Draft, and validates the result. Model refusal, ambiguity, timeout, malformed JSON, missing fields, invented fields, or broadened intent creates no authority.

## 8. Telegram installation and privacy

The hackathon product has one owner and one bound private group. Pairing uses an expiring high-entropy deep link in a private Bander-bot chat. The first valid claimant is fixed for that pairing attempt, the claimant chooses the group through Telegram's private picker, and the token is consumed after a successful binding.

Verified bot configuration:

- neither bot is an administrator;
- Bot-to-Bot Communication is off for both bots;
- OpenClaw Group Privacy is off;
- Bander Group Privacy is on;
- OpenClaw accepts only the bound owner's messages in the bound group;
- `requireMention` is false and `historyLimit` is zero; and
- Bander's bot credential exists only in Bander's process environment.

Every callback is independently bound to the installation, owner Telegram ID, group ID, Bander-authored message ID, opaque callback value, Draft/candidate, expiry, and lifecycle. Replays use the existing idempotent engine path rather than creating fresh authority.

## 9. Real and sandbox modes

### Real product

`npm run real` means live conversational OpenClaw, live `gpt-5.6-sol`, real Google Calendar, and the genuine Bander Telegram Card/outcome. Startup fails unless real mode, the Google adapter, active Telegram pairing, live model provider, exactly three Bander tools, credential separation, and absence of fixture routes all validate.

Real authority state is currently memory-only and is not restart-durable. Telegram installation and delivery bindings are file-backed. This is an explicit prototype limitation.

### Hero sandbox

`npm run hero` is the reproducible Telegram/judge sandbox. It uses a deterministic model provider plus seeded mock Calendar and Messages services. It proves authority, privacy, replay, recovery, standing limits, and presentation without personal accounts. It never claims a Google mutation and is not the canonical parent product.

`npm run demo` is the fully local browser version of the deterministic sandbox.

The sandbox's Messages and standing examples remain valuable test surfaces. They are not current real-product capabilities.

## 10. Verification contract

The implementation is accepted only with executable evidence:

- functional and type checks;
- an authority attack suite whose important mutations were observed failing first;
- idempotent one-time and standing recovery tests through real local HTTP processes;
- a real OpenClaw verifier with exactly three tools and no downstream credentials;
- empirical Telegram owner/non-owner, wrong-chat/message/callback, imitation, replay, decline, delivery-retry, and trajectory-privacy checks;
- Google OAuth, authoritative timezone, conditional write, stale ETag, concurrent ETag, ambiguous matching, unsupported shape, and failure-response tests;
- a real `gpt-5.6-sol` evidence call and malformed/broadened-output tests;
- production build, dependency audit, and tracked secret scan; and
- a manual real Telegram → OpenClaw → Bander → Google journey.

Observed evidence and command outputs live in [BUILD_WITH_CODEX.md](BUILD_WITH_CODEX.md). The public setup and commands live in [README.md](README.md).

## 11. Honest non-claims

Bander does not currently claim:

- general schedule reading or summarization;
- email or message sending in real mode;
- reservations, purchases, payments, transportation, medical actions, locks, or smart-home control;
- prompt-injection detection or model-behavior correctness;
- protection from a compromised same-user runtime or operating-system account;
- a production installer for arbitrary existing OpenClaw configurations;
- restart-durable production authority;
- coverage of all personal-agent effects; or
- that the deterministic Hero sandbox touched Google.

## 12. Build Week submission contract

Bander enters **Apps for Your Life**. As of July 15, Devpost reports submissions close Monday, July 21 at 5:00 PM Pacific Time. The submission needs a working project, category, project description, public sub-three-minute YouTube demo with audio explaining Codex and GPT-5.6, repository URL with README and license, and the `/feedback` Session ID from the task where most core functionality was built.

The filmed story is the real Calendar journey, including one successful approval and one changed-world refusal. Hero remains available for deterministic judge access. Final video, sanitized screenshot, public-repository switch, Devpost copy, and `/feedback` happen only after the public documentation checkpoint is green.

## 13. Future roadmap

Future work may add:

- an additive installer that preserves an existing OpenClaw configuration;
- durable transactional production authority storage and startup reconciliation;
- real independently credentialed adapters beyond Calendar rescheduling;
- setup/doctor/reset/uninstall workflows;
- additional human channels; and
- carefully bounded real standing autonomy.

None of those items is presented as implemented today.
