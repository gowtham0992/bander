# Bander

**Bander holds the keys. Your agent can only ask.**<br>
OpenAI Build Week — **Apps for Your Life** track.

Bander is a confidence layer for personal agents. It lets an agent prepare useful real-world work, makes the exact outcome understandable, and is the only service allowed to carry out the approved action.

**Built for MCP-capable personal agents. Demonstrated end-to-end with OpenClaw.**

This is deliberately not a generic permission pop-up. Consent causes authority: Bander cannot execute an action until the person approves the exact immutable action that will be carried out.

---

## 1. The product in one sentence

**Before an agent changes a person’s life, Bander shows the exact deal, lets the person approve it, and carries out only that deal—nothing more.**

The agent may reason, suggest, and ask. It does not hold Calendar or Messages credentials. Bander owns those demo credentials and is the only route to the seeded mock services.

### Product language

Use these five nouns everywhere—in the UI, README, video, and code:

| Term | Meaning |
| --- | --- |
| **Draft** | An immutable, canonical description of the proposed external effects and their preconditions. |
| **Card** | The human-readable rendering of a Draft. Bander-authored chrome and agent-supplied content are visibly distinct. |
| **Band** | The user’s approved authorization: either one-time or a bounded standing rule. |
| **Permit** | A short-lived, single-use execution credential issued only after a valid Band is checked. It is scoped to Bander’s executor, never the agent. |
| **Receipt** | The immutable record of an outcome. Human and agent receipts intentionally reveal different amounts of detail. |

---

## 2. The moment that sells it

The user asks their personal agent:

> “Move dinner with Sarah to 7:30 and tell her I’ll be 20 minutes late.”

The agent can only submit a request to Bander. Bander resolves the seeded calendar event and Sarah’s canonical contact identity, then produces a Draft. The user sees its Card:

```text
                  HERE’S THE DEAL

  Your agent says your request was:
  “Move Dinner with Sarah to 7:30 PM
  and send Sarah one message.”

  With this Band, Bander may only:
  • move Dinner with Sarah to 7:30 PM
  • send one message to Sarah

  Bander does not control tools or accounts
  outside these Bander-managed connections.

  Calendar  •  Messages                 Expires in 10 min

             [ Ready ]  [ Change it ]  [ Not now ]
```

When the user selects **Ready**, Bander records a one-time Band over the exact Draft hash. At execution time, Bander mints a short-lived Permit for its own executor. The executor receives no agent-provided parameters: it runs the stored Draft, subject to the stored preconditions.

Afterward the person sees a Receipt:

```text
                     DONE

  Completed as agreed: Dinner moved to 7:30 PM.
  Sarah was notified.
```

---

## 3. The user experience

### Exact consent without consent fatigue

One-time external actions get a Card. Purely conversational help is not interrupted. The Card is warm and specific, not a technical policy editor.

Bander does not decide whether the agent’s proposed action is good or malicious. It makes invisible external effects impossible within its boundary: **no Bander-mediated effect occurs beyond the one-time Draft or standing Band the person saw and agreed to.** If an agent proposes an injected or unsanctioned effect, Bander displays that effect in a Card; it does not pretend to detect the agent’s motive.

The Card always says:

- **This Band allows:** the exact effect, target, recipient, and expiry.
- **Not allowed:** other Bander-managed effects outside this Draft.
- **Bander does not control:** tools, credentials, or accounts that bypass Bander.

When Bander only receives a proposal through an agent, it labels the premise as hearsay: **“Your agent says your request was: …”** It must never label agent-supplied text as a verified user request. Future direct integrations may render stronger provenance, but the canonical MCP demo does not claim it.

Agent-provided event titles, message bodies, and request summaries are untrusted content. They are HTML-escaped and rendered only in a labelled, quoted preview region. Bander-owned labels, status, icons, limits, and promises come from deterministic templates; an agent cannot make its own prose appear to be Bander speaking.

The last line is an honest boundary, not a disclaimer hidden in documentation.

### Standing Bands: autonomy that remains bounded

A person can approve a small recurring rule rather than seeing a Card for routine, low-impact work. Example:

> “Reschedule my own appointments during work hours. Do not message anyone. Maximum 3 actions per day. Expires in 30 days.”

That sentence is only a rendering. The actual Band is an **enumerated predicate**, not prose:

```text
allowed action type:    calendar.update_event
resource selector:      organizer == self AND attendees == [self]
allowed changed fields: start_time only
time constraint:        weekday, 09:00–17:00 local time
aggregate limits:       max 3 actions / rolling day; 0 new recipients; $0 spend
lifecycle:              30-day expiry; user can revoke immediately
```

If a proposed Draft does not match structurally—cancelling, changing duration, touching an event with other attendees, or moving it outside the time window—it cannot silently run. It falls back to a new Card.

At standing-Band approval, the person reviews a deterministic clause-by-clause rendering of the enforced predicate—not a model-written paraphrase:

```text
Only appointments where you are the only attendee
Only the start time may change; never cancel or change duration
Only Monday–Friday, 09:00–17:00 local time
Never send a message or make a purchase
At most 3 actions per day · expires 12 August · revoke anytime
```

GPT-5.6 may propose the candidate predicate, but it cannot author these clauses. The clauses are generated from the same validated schema the executor enforces, so the display cannot drift from the stored rule.

Silent does not mean invisible. Every auto-executed action creates a plain-language Receipt line. A daily digest is a later presentation of those receipts, not a substitute for them.

### Changed-world protection

Approval covers not just the words in a Draft but the world the user saw when approving it. Every Draft includes preconditions such as:

- Calendar event ID and expected revision / ETag
- Expected current fields that matter to the action
- Canonical recipient ID and expected identity revision

The executor uses conditional writes. If the calendar or contact changed after approval, Bander fails closed:

> “Your calendar changed after you approved this. I didn’t act.”

The human may see the before/after diff and a fresh Card. The agent receives only `{ status: "conflict", draft_id }`—not the changed value, a diff, or another read channel.

### Revocation is ordered with execution

“Pause external actions” is not merely a check before Permit minting. In the mock demo, revoke and execute are serialized under the same per-Band transaction/lock, including the conditional mock-service write. The executor rechecks that the Band is active while acquiring its execution transition; a revoke that linearizes first prevents the write.

This is a deliberately scoped guarantee: Bander does not claim it can undo an external write that already committed. The proof is that no write occurs when revocation commits before execution commits.

---

## 4. The security model

### Load-bearing invariant

```text
Draft hash + approved Band + live preconditions
                    │
                    ▼
        one Permit for Bander's executor
                    │
                    ▼
       execute stored Draft, and nothing else
```

1. Bander canonicalizes the requested effect into an immutable Draft **D** and hashes it.
2. The Card renders **D** in plain language.
3. A person approves by authorizing `hash(D)` as a Band.
4. Only then can Bander mint a short-lived, nonce-bound Permit containing `hash(D)`, expiry, and executor scope.
5. Bander’s executor fetches the stored **D**. It accepts **zero parameters from the agent** at execution time.
6. The executor checks the Band, Draft hash, nonce, expiry, aggregate limits, and live preconditions, then serializes its final active-Band check and conditional mock-service write with revocation.

An agent cannot add a recipient, substitute a restaurant, alter a payload, replay a Permit, or expand the plan after approval. Those changes require a different Draft, hence a different Card and Band.

### Trust boundaries

OpenClaw is Bander’s reference integration, not its security boundary or a product lock-in. Bander’s broker exposes the same narrow MCP contract to any compatible agent; the authority path remains independent of the agent runtime. The hackathon claim is deliberately bounded: Bander is demonstrated end-to-end with OpenClaw, not asserted to work perfectly with every agent without testing.

```text
OpenClaw / personal agent
  ├─ may call: bander.propose_action
  ├─ may call: bander.list_capabilities
  └─ may call: bander.get_receipt (minimal result only)
                         │
                         ▼
                    Bander broker
                         │
     owns mock Calendar + Messages credentials
                         │
                         ▼
               mock Calendar / Messages services
```

For the canonical demo, the OpenClaw process has **no Calendar or Messages credentials** and no direct Calendar, Messages, browser, shell, or generic outbound-action tool. OpenClaw may use network transport to reach its model provider and Bander's MCP endpoint, but it receives no downstream credentials. This must be demonstrated by credential absence and an allowlisted tool manifest, not merely a deny policy. Bander is the only path to the two seeded mock services.

This is a scoped claim, not a global one: Bander controls only effects routed through Bander. It does not protect a compromised host, an integration with separately accessible credentials, or tools outside this configured boundary.

### Model role and deterministic authority

GPT-5.6 may turn fuzzy user language into a candidate structured Draft, explain the result plainly, and flag ambiguity or unusual context. It is not the authority and it is not a prompt-injection detector.

- Deterministic code validates Draft schemas, scopes, identities, limits, hashes, lifecycle, and preconditions.
- GPT-5.6 may escalate an action to a Card; it may never lower the required level of review or enlarge authority.
- The Card is rendered from the canonical Draft. The model’s prose cannot expand its meaning, and a model flag is an attention aid—not a security control.
- Model-driven escalations are visibly labelled as Bander’s caution and rate-limited so they cannot become a nagging attack.

### Receipts and conflict privacy

The **human receipt** can say what happened: “Dinner moved; Sarah notified.” The **agent receipt** is deliberately minimal: Draft ID plus `proposed`, `approved`, `executed`, `blocked`, `expired`, `revoked`, or `conflict` status. It contains no message bodies, calendar details, current values, or conflict diffs.

Data-returning actions are a separate future capability with their own Band; a Receipt is never a side door to read private data.

### Proposal flood control

A sequence of individually honest Cards can still create consent fatigue. Bander applies a deterministic per-agent rolling proposal cap and surfaces the count in the UI, for example: **“Your agent has asked 12 times in 10 minutes.”** Once the cap is reached, Bander stops accepting further proposals until the window resets or the user deliberately resumes them. This is a safety mechanism, not a polish feature.

---

## 5. What Bander proves—and does not claim

### In scope for the hackathon prototype

- Exact, approved calendar and message effects execute once, only through Bander.
- An agent-proposed extra recipient or helpful-but-unsanctioned effect is disclosed in the Card and cannot execute without a newly approved Band.
- A changed calendar resource causes a conditional write failure; no action occurs.
- A standing Band permits only its enumerated action/resource/field predicate and aggregate limits; the user reviews deterministic clauses generated from that predicate.
- Expired, revoked, mismatched, and replayed authority fails closed, with revocation ordered against an in-flight mock execution.
- Agent-facing receipts and conflicts do not leak downstream data.

### Out of scope

- Arbitrary browser, shell, network, payment, or OAuth mediation.
- A guarantee over any tool or credential that bypasses Bander.
- Prompt-injection detection, perfect intent verification from an agent-provided request summary, or protection outside Bander’s mediated path.
- A general policy language, enterprise administration console, or family dashboard.
- A polished daily digest, delegated-review experience, or a second integration before the core is proven.

The point is not that Bander makes agents harmless. It gives a normal person a reliable, understandable boundary around the useful actions Bander mediates.

---

## 6. Canonical demo: three tight beats

The video stays under three minutes. The central story is useful help made trustworthy, not a security-horror montage.

1. **Exact consent.** The user asks to move dinner and message Sarah. Bander labels the agent’s claimed request, renders the proposed effects in the Card, and approval leads to exactly the stored calendar change and message. An injected or unexpected added recipient appears as a new proposed effect; it cannot happen invisibly, and the user declines the new Card.
2. **Changed-world refusal.** After approval, a collaborator changes the calendar event. Bander’s conditional write fails. The human sees “Your calendar changed after you approved this. I didn’t act”; the agent sees only `conflict`.
3. **Bounded standing autonomy.** A standing Band handles an eligible self-owned appointment inside work hours. It produces a visible Receipt line. An adjacent non-enumerated change falls back to a Card.

Thread the required narration through these scenes:

- **Codex** accelerated the reviewed app, broker, mock adapters, policy tests, and attack suite.
- **GPT-5.6** compiles natural-language requests into candidate Drafts and optional plain-language explanations; deterministic templates, not GPT-5.6, render the authoritative Card clauses, and deterministic code issues and enforces authority.

Do not lead with a real unsafe action, personal data, or a “without Bander” stunt. Do not include delegated review in the video; it may appear as a brief future direction in the README only.

---

## 7. Build sequence: risk first

| Order | Thin slice | Done when |
| --- | --- | --- |
| 1 | Credential-isolated mock boundary | OpenClaw has no Calendar/Messages credentials or direct action tools; only Bander's broker/executor receives the internal mock-service credential. |
| 2 | Draft → Card → Band → Permit → Receipt | A user-approved Draft hashes, receives one Permit after approval, and Bander’s executor runs stored data with no agent execution parameters; agent-claimed request text is explicitly labelled. |
| 3 | Conditional writes and conflicts | ETag/revision mismatch prevents an action; human gets a fresh review path and agent gets only a minimal conflict status. |
| 4 | Exact-scope enforcement | Extra recipient, altered field/payload, substituted target, replay, expiry, and revoke all fail closed; revoke and execute have defined transaction ordering. |
| 5 | Standing Band + proposal flood control | Deterministically rendered predicate clauses; rolling action, recipient, spend, and proposal caps; expiry, revoke, and visible auto-execution Receipt. |
| 6 | OpenClaw MCP wiring | Remote Streamable HTTP MCP exposes only `propose_action`, `list_capabilities`, and minimal `get_receipt`; verify with `openclaw mcp doctor … --probe`. |
| 7 | GPT-5.6 compiler and Card copy | A model proposes validated structured data; model output cannot grant or enlarge authority. |
| 8 | Product polish and capture | Polish the Card and Receipt states; record the changed-world beat the moment it passes. |
| 9 | Submission evidence | Add README, `BUILD_WITH_CODEX.md`, `/feedback` Session ID, seeded demo, and the real test output. |

No slice is “done” because a screen looks right. It is done only when the associated test passes and its claim is supportable on camera.

---

## 8. The attack suite: claims must be executable

`npm run attack` must run deterministic seeded scenarios. A claim that lacks a test does not appear in the video or README.

| Test name | Property proved |
| --- | --- |
| `rejects_extra_recipient_after_approval` | A recipient absent from the approved Draft cannot receive a message through the approved authority. |
| `rejects_payload_or_field_drift` | An altered message payload or calendar field cannot use the original authority. |
| `rejects_substitution` | A different target cannot replace an approved target. |
| `rejects_unrequested_helpful_action` | A locally sensible extra action is still denied. |
| `rejects_permit_replay` | A consumed nonce cannot execute a second time. |
| `rejects_expired_band` | Expiry denies execution. |
| `rejects_revoked_band` | A Band revoked before execution cannot mint or use authority. |
| `revocation_linearizes_before_execution_commit` | When revocation commits before execution’s final transition, the conditional write does not occur. |
| `fails_closed_on_etag_mismatch` | Changed-world preconditions block the conditional write. |
| `standing_band_rejects_non_enumerated_draft` | Standing authority is structural, not prose interpretation. |
| `rendered_standing_band_clauses_match_predicate` | The approved standing-Band clauses are deterministically generated from the exact enforced predicate. |
| `conflict_leaks_nothing_to_agent` | A conflict exposes no changed state or private service data through the agent receipt. |
| `agent_claimed_request_is_rendered_with_provenance` | An agent cannot present an MCP-supplied request summary as a verified user request. |
| `renders_agent_text_only_in_quoted_preview` | Agent-supplied strings cannot render as Bander-owned chrome, status, or approval language. |
| `rate_limits_proposal_flood` | A compromised or looping agent cannot create unlimited Cards in the configured rolling window. |

Use actual result counts only. If a known scenario is not covered or fails, say so plainly rather than inventing a benchmark.

Each critical test must be deliberately made to fail once during implementation, then restored, so the suite proves it can catch the condition it names.

---

## 9. How this fits the Build Week rubric

| Criterion | Bander’s evidence |
| --- | --- |
| Technological implementation | A real credential boundary; content-addressed Drafts; one-time, executor-scoped Permits; conditional writes; deterministic attack tests; controlled GPT-5.6 use. |
| Design | Five understandable nouns, one calm Card, visible Receipts, and practical standing autonomy for a nontechnical person. |
| Potential impact | Personal agents become more useful when people can grant bounded autonomy without surrendering broad, forgotten access. |
| Quality of idea | Bander treats consent as the cause of authority and renders the exact same canonical action to people and enforcement code. |

Enter **Apps for Your Life**. The broker is technical proof; the product is help without surprises for people who should not need to understand permissions, agents, or security controls.

### Difference from task-scoped authorization frameworks

Task-scoped authorization research and developer tools prove that narrow grants are useful. Bander’s product contribution is different: a person’s consent is the cause of authority; one canonical artifact is rendered both as a calm human Card and as deterministic executor input; preconditions protect the world that existed at approval; and the person never needs to learn the word “scope.”

---

## 10. Submission contract

- Build with **Codex** and **GPT-5.6**.
- Submit by **July 21, 2026, 5:00 PM PT** with a public YouTube video under three minutes that explicitly explains both Codex and GPT-5.6 use.
- Provide a public repo with a suitable license, or a private repo shared with `testing@devpost.com` and `build-week-event@openai.com`.
- Include one-command setup, seeded mock data, judge demo instructions, architecture boundaries, and attack-suite instructions in the README.
- Maintain `BUILD_WITH_CODEX.md` from the first implementation checkpoint: actual Codex contribution, human decisions, exact GPT-5.6 role, deliberately invalidated critical tests, and real test output. Do not reconstruct this story on the final day.
- Add the `/feedback` Codex Session ID from the task where most core functionality was built.
- Keep the self-contained mock path available for the judging period; it needs no real accounts, OAuth, payment, or personal data.

### README boundary statement (use verbatim)

> In the canonical demo, the OpenClaw process has no Calendar or Messages credentials and no direct tool path to Bander’s mock Calendar or Messages services. Bander is the only route to those effects. This guarantee applies only to services mediated by Bander; it does not protect tools, credentials, or hosts outside that configured boundary.

---

## 11. Brand and interaction language

- **Product:** Bander
- **Hero line:** Bander holds the keys. Your agent can only ask.
- **Supporting line:** Help without surprises.
- **Card title:** Here’s the deal
- **Approve:** Ready
- **Edit:** Change it
- **Decline:** Not now
- **Completion:** Done / Completed as agreed
- **Changed-world refusal:** Your calendar changed after you approved this. I didn’t act.
- **Scope drift:** This needs you: it would change the deal you approved.
- **Emergency control:** Pause external actions

Avoid “Safe Mode,” “zero trust,” “policy engine,” “firewall,” and alarmist language in the product UI. The experience should feel capable and calm, not restrictive or childish.

---

## Research basis

- [OpenAI Build Week](https://openai.com/build-week/)
- [OpenAI Build Week official rules](https://openai.devpost.com/rules)
- [OpenAI Build Week resources](https://openai.devpost.com/resources)
- [Build Week submission update](https://openai.devpost.com/updates/45282-openai-build-week-submissions-are-open-plugin-launch)
- [OpenClaw MCP documentation](https://docs.openclaw.ai/cli/mcp)
- [OpenClaw plugin permission requests](https://docs.openclaw.ai/plugins/plugin-permission-requests)
- [OpenClaw security documentation](https://docs.openclaw.ai/gateway/security)
- [OpenClaw threat-model atlas](https://github.com/openclaw/openclaw/blob/main/docs/security/THREAT-MODEL-ATLAS.md)
- [Peter Steinberger: OpenClaw, OpenAI and the future](https://steipete.me/posts/2026/openclaw)
- [OpenAI: Introducing ChatGPT agent](https://openai.com/index/introducing-chatgpt-agent/)
- [PAuth: Precise Task-Scoped Authorization for Agents](https://arxiv.org/abs/2603.17170)
