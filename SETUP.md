# Set up Bander for a parent or family member

This guide is for the person setting up Bander on a computer for a parent or family member. When setup is complete, the parent can ask OpenClaw about their real Google Calendar, approve one exact appointment move, and optionally approve the exact appointment update sent to one connected family member.

## Keep the three participants straight

| Participant | What they do |
| --- | --- |
| **Setup computer** | Holds the Bander bot token, Google OAuth files, local state, and starts Bander/OpenClaw. |
| **Parent/owner phone** | Talks to OpenClaw in the protected group and approves or declines Bander Cards. |
| **Family-contact phone** | Privately accepts an invitation and can receive only an exact update the parent approved. It stays outside the protected group. |

## What becomes real

- The parent can ask what is coming up on their connected primary Calendar.
- The parent may approve a real move of one narrowly eligible Calendar event.
- The parent may approve one timed Calendar event after seeing its exact title and complete interval; Bander uses a disclosed 60-minute default unless the parent states a duration.
- One connected family member may receive only the deterministic appointment update shown on the same approval Card.

Bander does not provide arbitrary messaging, email, purchases, reservations, payments, smart-home control, or general Calendar editing.

## Fast judge sandbox: no accounts or keys

```bash
git clone https://github.com/gowtham0992/bander.git
cd bander
npm ci
npm run demo
```

Open <http://127.0.0.1:4310>. This is a deterministic, seeded sandbox. It does not connect to Google, Telegram, or OpenAI and must not be presented as evidence of a live account mutation. It exercises the same Card, approval, outcome, and replay rules as the real product, including secondary add and remove journeys.

## Real setup

### 1. Prepare the setup computer

Current verified environment:

- macOS (the first OAuth flow uses the macOS browser launcher);
- Node.js 22.12 or newer; and
- the OpenClaw version pinned in this repository. No global OpenClaw install is required.

```bash
git clone https://github.com/gowtham0992/bander.git
cd bander
npm ci
cp .env.example .env
```

Edit `.env` in a local editor. Never paste secret values into chat, screenshots, issue reports, documentation, or shell history.

### 2. Create two visually distinct Telegram bots

Use Telegram’s BotFather to create:

- an **OpenClaw bot**, which converses with the parent; and
- a **Bander bot**, which posts approval Cards and outcomes.

Create a private protected group containing the parent and both bots. Neither bot needs to be an administrator.

Configure and empirically verify:

| Setting | OpenClaw bot | Bander bot |
| --- | --- | --- |
| Bot-to-Bot Communication | Off | Off |
| Group Privacy | Off | On |

After changing Group Privacy, remove that bot from the group and add it again so Telegram applies the new setting. Put only the corresponding token names into `.env`: `OPENCLAW_TELEGRAM_BOT_TOKEN` and `BANDER_TELEGRAM_BOT_TOKEN`.

Telegram’s Bot API cannot prove every BotFather privacy setting. `npm run doctor` therefore reports a warning rather than a false pass. Run:

```bash
npm run verify:telegram-privacy
```

Follow its empirical owner/non-owner/imitation procedure. The parent’s natural group messages should reach OpenClaw; Bander must not ambient-listen to them.

### 3. Configure OpenAI

Create a project key with access to exact model `gpt-5.6-sol`. Store it as `OPENAI_API_KEY` in `.env`. Bander uses the model only for bounded intent compilation; the model cannot select Calendar IDs, ETags, recipient routing, notification text, approval, or execution authority.

### 4. Configure narrow Google Desktop OAuth

On the **setup computer**:

1. Create or select a dedicated Google Cloud project.
2. Enable the Google Calendar API.
3. Configure an External OAuth consent screen in Testing and add the dedicated Calendar account as a test user.
4. Create an OAuth client of type **Desktop app**.
5. Download the client JSON into ignored local storage, such as `.bander/google-oauth-client.json`.
6. Set `GOOGLE_OAUTH_CLIENT_PATH` to that file and `GOOGLE_OAUTH_TOKEN_PATH` to an ignored path such as `.bander/google-oauth-token.json`.
7. Restrict both files to the local user (`chmod 600 …`).

Bander requests only:

```text
https://www.googleapis.com/auth/calendar.events.owned
```

It fixes Calendar access to `primary`. Set `BANDER_RUNTIME_MODE=real` and set `BANDER_CALENDAR_TIME_ZONE` to the primary Calendar’s authoritative IANA timezone, such as `America/Denver`.

### 5. Pair the parent and protected group

```bash
npm run pair:real
```

If Google authorization opens, finish it with the dedicated Calendar account. Open the expiring Bander link from the ignored local pairing file on the **parent/owner phone**, in a private chat with Bander. Claim the link and choose the protected group. The first valid claimant is locked to the attempt; the link expires and is consumed after binding.

Stop the pairing process with `Ctrl-C` after Bander confirms the group.

### 6. Optionally connect one family member

The operator chooses the display label and aliases locally. OpenClaw and the model cannot create or redirect this relationship.

```bash
npm run pair:family -- --name Gil --alias "my son" --alias son
```

Remote handoff is the normal flow:

1. The technical owner creates the link on the **setup computer**.
2. Send that link privately to the invited family member.
3. The family member opens it on their own **family-contact phone** and in their own Telegram account.
4. They read the limited-role disclosure and tap **OK, keep me posted**.
5. They remain outside the protected parent group.

The same-device account-switch topology is useful for testing but is not required for a real family invitation.

### 7. Check setup, then start

```bash
npm run doctor
npm run doctor -- --live
npm run real
```

The default doctor is offline and safe to run before setup is complete. `--live` performs read-only reachability and exact-tool checks. Neither command sends Telegram messages, changes Calendar data, creates authority, or modifies pairing state.

## What each person can see

- **Parent:** their protected Telegram conversation, bounded schedule answers, Bander Cards, refusals, and outcomes.
- **Family member:** only the exact deterministic appointment update approved on a Card. They cannot approve, query or inspect the Calendar, see the protected conversation, call OpenClaw, or add a contact.
- **OpenClaw/model:** bounded schedule facts by design so it can answer a schedule question. It does not receive Cards, callbacks, Bander outcomes, Google credentials, writable identifiers/ETags, or contact routing.

Telegram confirming acceptance of a family update does not prove the person read it.

## Recovery

### A port is already running

Run `npm run doctor`. It reports busy ports without killing anything. Stop the existing Bander/OpenClaw stack normally with `Ctrl-C`; do not run two gateways against one OpenClaw bot token. If the intended real stack is already running, use `npm run doctor -- --live`.

### The wrong Telegram group was selected

Stop Bander, preserve the current ignored state for diagnosis, and repeat the authenticated owner pairing with the intended private group. Do not edit Telegram IDs by hand.

### OpenClaw hears only mentions

Confirm OpenClaw Group Privacy is off in BotFather. Remove OpenClaw from the group, add it again, and rerun `npm run verify:telegram-privacy`. Do not turn Bander’s Group Privacy off.

### A pairing link expired

- Owner/group: stop the pairing process and rerun `npm run pair:real` to create a new expiring link.
- Family contact: run `npm run revoke:family`, then create a new link with `npm run pair:family -- --name NAME --alias ALIAS`.

Old links remain invalid.

### The invited family member is still in the protected group

Have them leave the group, then create a new family link. Membership in the protected group is a permanent rejection condition, not a warning to bypass.

### Revoke or reconnect family

The family member may use `/disconnect` in their private Bander chat. The owner may use Bander’s disconnect control. With the product stopped, the operator may run:

```bash
npm run revoke:family
```

Revocation is idempotent and removes the routable Telegram destination. Reconnection requires a fresh explicit invitation.

### Google OAuth expired or was revoked

Stop the real stack. Preserve the client file, remove only the ignored expired token after confirming the path, and rerun `npm run pair:real` to authorize again. Never copy token contents into a bug report.

### The Calendar timezone is wrong

Run `npm run doctor -- --live`. Set `BANDER_CALENDAR_TIME_ZONE` to the authoritative timezone the primary Calendar reports, then restart. Do not use the setup computer’s implicit timezone as a substitute.

### Doctor reports a failure

Follow the exact **Next action** for the failed row. Expected missing configuration is reported without a stack trace. `WARN` means the stated limitation or optional setup remains; it is not a hidden pass.

### Clean stop and restart

Use `Ctrl-C` once in the terminal running `npm run real`, wait for both supervised processes to stop, then run `npm run real` again. Telegram installation and delivery bindings persist. In-flight production authority does not.

## Honest current limitations

- Real writes are limited to adding one timed default event or moving or cancelling one timed, non-recurring, owner-organized, attendee-free event in the connected primary Calendar. Creation has no attendees, recurrence, location, description, conferencing, attachments, custom reminders, or reservation; rescheduling preserves exact duration; cancellation removes only the exact event version shown on the Card and never contacts an external clinic, restaurant, or service.
- Schedule reads are capped at 31 days and 50 sanitized events. Calendar titles remain untrusted model input; sanitization and prompting reduce but do not eliminate prompt-injection or mis-summary risk.
- Exactly one family contact is supported. Bander can send only the deterministic appointment update shown on the approved compound Card.
- Telegram delivery is not exactly once. A confirmed response is replay-safe; an ambiguous response is reported as unconfirmed and never retried automatically. Acceptance is not proof of reading.
- Core production authority is process-local and not restart-durable. Do not approve while intentionally restarting the broker.
- The Streamable HTTP MCP endpoint is loopback-only and has no application-level authentication. Do not expose it to a LAN or the public internet.
- The repository does not install additively into arbitrary pre-existing OpenClaw configurations and does not claim mass-market or cross-platform setup.
- Bander does not protect against compromise of the same operating-system user account or host.
- Standing autonomy is a deterministic sandbox proof only, not a real Google capability.

For implementation-level boundaries, see [the architecture decisions](docs/architecture.md). For reproducible checks, see [the evidence ledger](BUILD_WITH_CODEX.md).
