# Bander

## Product source of truth — July 16, 2026

This document describes the implementation that exists today and the final Build Week product position. Historical red/green evidence remains in [BUILD_WITH_CODEX.md](BUILD_WITH_CODEX.md).

## 1. Product promise

**The OpenClaw I’d actually give my parents.**

OpenClaw helps. Bander holds the keys and independently confirms what happened.

Bander is a confidence layer for personal AI agents. The agent can converse and propose a real-world action. Bander independently resolves the authoritative object, shows the person the exact deal, and performs only the stored action that the bound person approves.

The core claim stays small and testable:

> Bander does not judge what an agent wants. For effects routed through Bander, nothing happens beyond the specific deal the person saw and approved.

## 2. Canonical real-product journey

The filmed Build Week journey is:

1. A parent speaks naturally in one private Telegram group. A dedicated Bander-protected OpenClaw profile converses normally and uses genuine `gpt-5.6-sol` tool selection.
2. The parent asks what is on their Calendar or what one clearly identified sender said. OpenClaw calls Bander's bounded read tool and answers with minimal schedule or inbox facts; no review Card, approval authority, or mutation is created.
3. The parent asks to change Calendar state, reply to one resolved email, or send one exact message to a connected family member. OpenClaw sends the newest natural request through Bander's proposal tool.
4. Bander makes a separate live `gpt-5.6-sol` call that returns only bounded intent hints. Deterministic code resolves exactly one eligible event and the exact active family-contact pairing.
5. The separate Bander Telegram bot posts one review Card containing the complete Calendar change and the exact deterministic family update, then asks the bound owner to approve or decline.
6. Approval conditionally updates the Calendar first with the stored ETag. Only after confirmed Calendar success does Bander attempt the exact approved family update through its own bot.
7. The family phone receives the exact displayed update, while Bander independently reports the observed combined outcome to the parent. OpenClaw receives only a minimal lifecycle status.
8. A changed-world run shows the other load-bearing result: if the Calendar changed before approval, Bander sends neither effect.

The canonical command is `npm run real`. It supervises both the Bander broker and a fresh real OpenClaw gateway, validates the runtime boundary, and refuses stale/mock coexistence.

## 3. Current real capability

Implemented in real mode:

- conversational OpenClaw for greetings and ordinary chat, with no Bander call unless the model genuinely selects a Bander tool;
- bounded schedule reads from the connected primary Calendar for an explicit range of at most 31 days, including timed, all-day, and recurring occurrences;
- bounded Gmail reads through a separate Gmail token, excluding spam/trash and returning only sanitized sender, subject, received time, and a bounded plain-text excerpt;
- a separate sanitized read DTO with at most 50 events and no Calendar identifiers, descriptions, locations, attendees, links, ETags, or OAuth data;
- natural-language Google Calendar rescheduling;
- natural-language creation of one timed default Calendar event;
- natural-language cancellation of one narrowly eligible Calendar event;
- primary Calendar only;
- timed, non-recurring, owner-organized, attendee-free events only;
- one exact normalized title match, optionally narrowed by a source date;
- a bounded 31-day upcoming search when no source date is supplied;
- required target local date and target local start;
- a disclosed 60-minute create default, with explicit durations limited to 15 minutes through 12 hours;
- a cryptographically strong client-supplied Google event ID generated once per create proposal and committed inside the immutable action;
- complete source/destination disclosure, duration preservation, cross-day moves, and IANA timezone handling;
- owner-bound Telegram approval and decline;
- one exact approved plain-text reply to one resolved inbound Gmail thread, pinned before approval with a stable RFC Message-ID, opaque reconciliation header, and byte-stable MIME;
- one exact approved independent family message, derived from the parent’s request and delivered unchanged through the existing consented route;
- one durable, consented family contact with operator-defined aliases and independent owner/contact revocation;
- one compound Calendar change plus deterministic family update, bound to the exact contact pairing before approval;
- a single Card whose family text is rendered by the same deterministic renderer used for delivery;
- ETag/`If-Match` conditional writes with `sendUpdates: "none"`;
- changed-world refusal with zero Bander mutation and zero family notification;
- replay-safe confirmed family delivery and permanent no-retry reporting after an ambiguous Telegram response; and
- a human-only outcome constructed from observed effect results rather than intended effects.

Schedule and inbox reads create no Card, approval authority, or mutation. Zero or multiple matches, missing action-specific fields, unknown or unconnected family references, unsupported communication shapes, malformed or broadened model output, and provider failures create no authority.

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

> In the Bander-protected OpenClaw profile, the model can converse, request bounded schedule and inbox facts, and propose through five bounded Bander tools. It does not receive Google credentials or family routing, cannot approve its own proposal, and cannot author Bander’s Card or outcome. Bander does not protect a host already compromised at the operating-system/user-account level.

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

Reschedule execution uses the canonical event ID and approved ETag stored in the Draft. It updates only start and end, preserves exact duration, fixes Calendar ID to `primary`, and uses `sendUpdates: "none"`. Create execution inserts one stored timed `default` event with the stored client ID, title, complete interval, and timezone, while deterministically omitting attendees, recurrence, location, description, conferencing, attachments, and custom reminders. Cancellation deletes only the stored event ID under the stored ETag with `sendUpdates: "none"`; it never reissues a dispatched delete or recreates the event. Bander never automatically refetches and executes a different plan after a precondition failure. For compound deals, Calendar execution always precedes family delivery.

If a Google write response is lost, Bander re-reads the exact event. It may report that the approved target was observed, but it does not claim causality it cannot prove. If the target cannot be confirmed, it does not notify the family contact and reports the Calendar result as unconfirmed.

Reconciliation treats provider errors by meaning, never by a generic null result. For cancellation, only an action-specific `404` or `410` proves that the exact event is absent; authorization, rate-limit, timeout, server, network, and malformed-client failures remain ambiguous. Creation likewise never treats an unreadable lookup as proof that the event exists. After dispatch, replay may reread but never issue a second insert or delete.

After a create insert is marked dispatched, Bander never inserts again automatically. It reconciles only by the exact stored client event ID. An exact match becomes an observation-safe success; different content is an identity collision and fails closed; a missing event remains permanently unconfirmed with no family delivery.

After a cancellation delete is marked dispatched, Bander never deletes again automatically. A lost response is reconciled only by reading the exact stored event ID. A cancelled tombstone or definitive absence supports observation-safe state wording without claiming causality; an active, changed, unreadable, or otherwise unclassifiable event remains ambiguous and produces no family delivery. An initial 404/410 is reported as already absent, not as Bander success.

Family delivery is bound to the opaque contact and pairing revision stored in the approved deal. A revoked or replaced contact is never substituted. Telegram has no client idempotency key: confirmed delivery is replay-safe; an ambiguous transport response is recorded permanently, is not retried automatically, and is never described as confirmed. Telegram acceptance is not proof that the human read the update. Owner-facing Card and outcome delivery retain their separately documented at-least-once tradeoff.

## 7. GPT-5.6 Sol's bounded role

Sol's reliability at bounded natural-language interpretation is the capability that makes a parent-facing product feasible; Bander's architecture is what makes it trustworthy. The two claims are deliberately separate.

Real mode uses the exact model ID `gpt-5.6-sol` for conversation/tool selection plus separate bounded Calendar, Gmail-read, and product-action Structured Outputs:

1. OpenClaw uses it for conversation and genuine tool selection.
2. Bander uses a separate Responses API Structured Output call to compile a bounded schedule range.
3. Bander uses another strict Structured Output call to extract writable intent:
   - action kind (`reschedule_event`, `create_event`, or `cancel_event`);
   - `eventTitleHint`;
   - optional `sourceLocalDateHint`;
   - action-specific target date/time for create or reschedule;
   - optional bounded `durationMinutes` for creation;
   - whether a family update was requested; and
   - the human alias used.

The model does not select a Calendar ID, Gmail message/thread ID, event ID, ETag, final end, recipient address, Telegram destination, MIME/header value, effect, authority object, or execution parameter. For an email reply or independent family message it may extract the parent’s requested plain text, but Bander stores, hashes, displays, and later reproduces that exact bounded text unchanged. Calendar-bound family text remains a deterministic rendering of authoritative Calendar state. Model refusal, ambiguity, timeout, malformed JSON, missing fields, invented fields, or broadened intent creates no authority.

## 8. Telegram installation and privacy

The hackathon product has one owner and one bound private group. Pairing uses an expiring high-entropy deep link in a private Bander-bot chat. The first valid claimant is fixed for that pairing attempt, the claimant chooses the group through Telegram's private picker, and the token is consumed after a successful binding.

One family contact may separately consent through a private, expiring Bander link. The contact remains outside the protected owner group, cannot approve or inspect Calendar/conversation data, and can disconnect independently. The technical owner can revoke the contact too. Raw Telegram routing stays inside Bander; the model can name only an operator-configured alias and cannot choose the destination or author the delivered text.

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

`npm run real` means live conversational OpenClaw, live `gpt-5.6-sol`, real Google Calendar, bounded Gmail, and the genuine Bander Telegram Card/outcome/family path. Startup fails unless real mode, both Google adapters, active owner/group pairing, live model provider, exactly five Bander tools, credential separation, and absence of fixture routes all validate.

The five real tools are:

- `bander__list_capabilities`;
- `bander__read_schedule`;
- `bander__read_inbox`;
- `bander__propose_action`; and
- `bander__get_receipt`.

Real authority state is currently process-local, memory-only, and not restart-durable. Telegram installation and delivery bindings are file-backed. This is an explicit prototype limitation.

### Hero sandbox

`npm run hero` is the reproducible Telegram/judge sandbox. It uses a deterministic model provider plus seeded mock Calendar and Messages services. It proves authority, privacy, replay, recovery, standing limits, and presentation without personal accounts. It never claims a Google mutation and is not the canonical parent product.

`npm run demo` is the fully local browser version of the deterministic sandbox. Its seeded email read/reply and independent-family journeys join the existing schedule, Calendar, ambiguity, decline, replay, recovery, and standing proofs without touching Google, Gmail, Telegram, OpenAI, or real people.

The public Pages build is a second backend for the same React experience. It runs the shared authority engine, contracts, canonical hashing, Card renderer and versioned fictional fixtures entirely in the browser. It contains no production adapter, OAuth material, Telegram service, OpenAI/OpenClaw runtime, server, filesystem or process-environment module and makes no runtime network request beyond same-origin static assets. It is explicitly labelled seeded and non-live; it is not evidence of a real integration action.

The sandbox's seeded Messages examples and standing autonomy remain valuable test surfaces. Standing autonomy remains sandbox-only and is not a current real-product capability.

## 10. Verification contract

The implementation is accepted only with executable evidence:

- functional and type checks;
- an authority attack suite whose important mutations were observed failing first;
- idempotent one-time and standing recovery tests through real local HTTP processes;
- a real OpenClaw verifier with exactly five tools and no downstream credentials;
- empirical Telegram owner/non-owner, wrong-chat/message/callback, imitation, replay, decline, delivery-retry, and trajectory-privacy checks;
- Google OAuth, authoritative timezone, conditional write, stale ETag, concurrent ETag, ambiguous matching, unsupported shape, and failure-response tests;
- a real `gpt-5.6-sol` evidence call and malformed/broadened-output tests;
- production build, dependency audit, and tracked secret scan;
- browser/server parity, Pages import-boundary and built-artifact security scans; and
- a manual real Telegram → OpenClaw → Bander → Google journey.

Observed evidence and command outputs live in [BUILD_WITH_CODEX.md](BUILD_WITH_CODEX.md). The public setup and commands live in [README.md](README.md).

## 11. Honest non-claims

Bander does not currently claim:

- arbitrary Calendar search, descriptions, locations, attendee details, or ranges longer than 31 days;
- bulk Calendar deletion, recurring/all-day/attendee-bearing/external-organizer cancellation, recurrence creation, attendee invitations, conferencing, reservations, locations, descriptions, attachments, or custom reminders;
- arbitrary Telegram messages, new outbound email threads, reply-all, forwarding, attachments, additional recipients, or model-controlled routing;
- more than one active family contact;
- reservations, purchases, payments, transportation, medical actions, locks, or smart-home control;
- prompt-injection detection or model-behavior correctness;
- protection from a compromised same-user runtime or operating-system account;
- a production installer for arbitrary existing OpenClaw configurations;
- restart-durable production authority;
- coverage of all personal-agent effects;
- that Telegram acceptance proves the family member read the update;
- exactly-once Telegram delivery; or
- that the zero-account browser sandbox touched Google, Telegram, or OpenAI; or
- that the Telegram Hero sandbox touched Google or OpenAI.

## 12. Build Week submission contract

Bander enters **Apps for Your Life**. As of July 15, Devpost reports submissions close Tuesday, July 21 at 5:00 PM Pacific Time. The submission needs a working project, category, project description, public sub-three-minute YouTube demo with audio explaining Codex and GPT-5.6, repository URL with README and license, and the `/feedback` Session ID from the task where most core functionality was built.

The filmed story opens with a frictionless schedule read, then shows one approved compound Calendar-and-family deal, the family phone receiving the exact approved update, and one changed-world refusal that stops both effects. Hero remains available for deterministic judge access. The repository and Pages are public; final video, sanitized screenshot, Devpost copy, and `/feedback` remain later gates.

## 13. Future roadmap

Future work may add:

- durable transactional production authority storage and startup reconciliation;
- real independently credentialed adapters beyond narrow Calendar creation, rescheduling, and cancellation;
- additional human channels; and
- carefully bounded real standing autonomy.

None of those items is presented as implemented today.
