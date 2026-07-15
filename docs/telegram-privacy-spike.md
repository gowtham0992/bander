# Telegram privacy spike

**Gate status:** passed empirically on July 14, 2026 with OpenClaw 2026.7.1.

The live test used one private Telegram group, separate OpenClaw and Bander bot tokens, one bound owner, and one bound non-owner. Raw updates, tokens, and numeric identities remained in ignored local `.bander/` evidence only.

## What must be configured locally

Create a private Telegram test group containing exactly these test participants:

- the bound owner account (“Mum” in the demo),
- one additional non-owner account that can tap a button,
- a dedicated OpenClaw bot,
- a separate dedicated Bander bot.

Configure both bots through the official `@BotFather` interface:

- Keep **Bot-to-Bot Communication Mode disabled** for both bots.
- For the OpenClaw bot, disable **Group Privacy Mode**, then remove and re-add it to the group. This is required for a natural, unmentioned owner message.
- Do not make either bot a group administrator.
- The Bander bot can keep Group Privacy Mode enabled; it needs its own callback updates, not ambient group messages.

Store and export these values only from the ignored local `.env` file—never paste them into Codex or commit them:

```text
OPENCLAW_TELEGRAM_BOT_TOKEN=<OpenClaw bot token>
BANDER_TELEGRAM_BOT_TOKEN=<separate Bander bot token>
BANDER_TELEGRAM_OWNER_ID=<numeric Mum test-user ID>
BANDER_TELEGRAM_CHAT_ID=<negative test group/supergroup ID>
```

The non-owner does not need a configured identity. The callback test must prove that any `CallbackQuery.from.id` other than the single bound owner is rejected.

## Required OpenClaw policy

The spike generates an ignored local OpenClaw config that maps `OPENCLAW_TELEGRAM_BOT_TOKEN` to OpenClaw's `TELEGRAM_BOT_TOKEN` without exposing the Bander token. It allows only the numeric owner in only the configured group, sets that group's `requireMention` to `false`, sets `contextVisibility` to `allowlist`, and sets `historyLimit` to `0`. The effective tool inventory remains exactly:

- `bander__list_capabilities`
- `bander__propose_action`
- `bander__get_receipt`

The Bander bot token, owner ID, and chat ID remain Bander-side configuration. MCP callers cannot choose or replace `ownerRef`.

## Empirical pass conditions

1. Mum sends a natural unmentioned request. OpenClaw receives it and calls Bander's real MCP proposal tool.
2. Bander posts a unique canary and inline control with its own bot token.
3. The complete OpenClaw trajectory contains Mum's request but contains none of the canary, Card, Receipt, conflict explanation, callback data, or Bander-bot messages.
4. The callback update arrives only on Bander's bot-token update stream. Its `from.id`, message chat ID, and Bander-authored message ID are checked against stored bindings.
5. A non-owner click is denied and creates no authority. An OpenClaw imitation creates no authority.
6. A legitimate callback replay produces exactly one Band, Permit, downstream mutation, lifecycle transition, and Receipt.
7. OpenClaw can retrieve only the minimal status already exposed by `get_receipt`.

If any privacy condition fails, the shared group gets only a minimal Bander notification linking to a Bander-owned secure review sheet. The Card and private conflict explanation do not remain in the shared conversation.

## Observed result

- The owner's normal unmentioned request reached OpenClaw and caused one real MCP `propose_action` call.
- MCP returned only `draftId` and `status`; the human Card stayed Bander-side.
- Bander posted the Card and inline control with its own bot identity.
- The non-owner callback was denied before authority existed.
- Two owner callbacks returned one execution and the same Receipt: one Draft, one one-time Band, one Permit, one downstream operation, one consumed Permit, and one Receipt.
- An OpenClaw-authored imitation callback reached OpenClaw but minted no Bander authority and executed nothing.
- The exported complete OpenClaw trajectory contained the human request, the Bander proposal tool, and the OpenClaw imitation callback. It contained zero Bander Card/Receipt/conflict canaries, zero real Bander callback handles, zero Card titles, zero Draft hashes, zero exact effect disclosures, and zero Receipt IDs.

The polished Telegram hero flow may now proceed in a later slice. This spike did not implement it.
