# Bander recording plan

Target: 2:40–2:50, one continuous voiceover, public YouTube upload under three minutes.

## Before recording

1. Run `npm install`, then `npm run demo`.
2. In a second terminal, run `npm run verify:demo` and keep the green summary available.
3. Run `npm run openclaw -- mcp probe bander --json` and keep its three-tool result available.
4. If demonstrating the optional compiler, export `OPENAI_API_KEY` before starting the demo and verify the “use your own wording” field appears.
5. Reset to the welcome screen. Record at 1440×900 or larger with browser zoom at 100%.

## Shot and voiceover outline

### 0:00–0:18 — the consumer promise

Show the welcome screen.

> Personal agents can prepare useful real-world work, but the credentials should not live with the agent. Bander holds the keys, shows the person the exact deal, and carries out only what they approve.

### 0:18–0:35 — the actual boundary

Show the OpenClaw probe result with exactly three tools.

> OpenClaw is the reference agent. It can list Bander’s capabilities, propose an action, and read a minimal receipt. It has no Calendar, Messages, browser, shell, generic outbound-action tool, or downstream credential.

### 0:35–1:03 — one-time exact consent

Return to Bander, choose “See the deal,” pause on the Card, then click “Ready” and show the Receipt.

> The agent’s claim is labelled as hearsay. The Card is rendered from one canonical Draft: move this event, send this exact message, and nothing else through Bander. Ready creates one-time authority for that stored Draft, not a fresh set of agent parameters.

### 1:03–1:28 — changed world, no partial action

Choose the changed-calendar scenario, click “Ready,” and show the refusal.

> Approval is not enough if the world changes. Here the Calendar revision changes after approval. The conditional write fails closed, no message is sent, and the agent learns only that the Draft conflicted—not the private new calendar state.

### 1:28–2:05 — bounded standing autonomy

Open the standing-Band Card, pause on its clauses, turn it on, show the focus-block Receipt, then choose “Try a request outside this Band” and show the fallback Card.

> A standing Band is a hashed structural predicate, not model prose: only my solo events, only start time, weekdays in work hours, three per rolling day, no messages or purchases, and revocable anytime. The focus block matches and runs. Dinner has another attendee, so it comes back for one-time review.

### 2:05–2:28 — GPT-5.6’s bounded role

When a key is configured, return home, enter the supported dinner request in the GPT-5.6 field, and show the resulting Card.

> GPT-5.6 uses strict Structured Outputs to select a versioned candidate from natural wording. It cannot author effects, approve, or execute. If it refuses, is ambiguous, times out, or has no key, the deterministic judge flow still works.

### 2:28–2:48 — Codex evidence and close

Show the verifier summary, then briefly show `BUILD_WITH_CODEX.md`.

> I built Bander with Codex in verified slices. This ledger records the human decisions, tests, attack mutations that were observed failing, OpenClaw probe, and exact commands. Bander does not judge what an agent wants; it ensures nothing happens through Bander beyond the deal the person saw and agreed to.

## Recording guardrails

- Do not claim that OpenClaw has zero network access; it may reach its model provider and Bander’s MCP endpoint.
- Do not call Bander a prompt-injection detector or imply it controls tools that bypass it.
- Keep the OpenAI key, mock-service token, environment output, and personal OpenClaw state off screen.
- Use the deterministic fixture flow as the canonical demonstration even if the GPT-5.6 compiler is also shown.
- End before 2:50 to leave upload/transcoding margin under the three-minute limit.
