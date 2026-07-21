# Set up Bander for a parent or family member

This guide is for the person setting up Bander on a computer for a parent or family member. When setup is complete, the parent can ask OpenClaw about their real Google Calendar and bounded Gmail inbox, approve exact Calendar changes or one exact Gmail reply, and optionally approve one exact message to a connected family member.

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
- The parent can read one bounded matching Gmail message and approve one exact plain-text reply in its existing thread.
- The parent can approve one exact plain-text message to the connected family member.

Bander does not provide new outbound email threads, reply-all, forwarding, attachments, arbitrary recipients, purchases, reservations, payments, smart-home control, or general Calendar editing.

## Fast judge sandbox: no accounts or keys

```bash
git clone https://github.com/gowtham0992/bander.git
cd bander
npm ci
npm run demo
```

Open <http://127.0.0.1:4310>. This is a deterministic, seeded sandbox. It does not connect to Google, Telegram, or OpenAI and must not be presented as evidence of a live account mutation. It exercises the same Card, approval, outcome, and replay rules as the real product, including secondary add and remove journeys.

On the development machine, both completed clean-clone runs took 13 seconds with a warm npm cache (observed range: 13–13 seconds). A cold network/package download can take materially longer; Bander does not promise a fixed five-minute install time.

## Real setup

`npm run setup` is a repository-local setup guide and verifier, not an installer. It never reads or modifies `~/.openclaw` or an existing OpenClaw. It creates an ignored 0600 `.env` template when needed, asks you to edit it in a local editor, and records only versioned milestones, configuration digests, and names of template keys it created. It never collects, prints, or stores secret values and never overwrites a differing existing value.

### 1. Prepare the setup computer

Current verified environment:

- macOS on Apple Silicon;
- Node.js 22.12 or newer (Node 24 in CI and the isolated runtime);
- npm through the committed lockfile; and
- repository-pinned OpenClaw 2026.7.1. No global OpenClaw install is required.

Intel macOS and Linux deterministic tests are expected but unverified. Windows real mode, Docker, remote/headless deployment, other OpenClaw versions, additive modification of an existing OpenClaw, and durable authority across broker restarts are unsupported. The sandbox requires a modern evergreen browser.

Supported and empirically verified OAuth topology: a dedicated Google OAuth Desktop client in External/Testing mode with configured test accounts. Broad production-grade OAuth onboarding for arbitrary public accounts is unsupported.

```bash
git clone https://github.com/gowtham0992/bander.git
cd bander
npm ci
npm run setup
```

If setup created `.env`, edit it in a local editor and rerun `npm run setup`. Never paste secret values into chat, screenshots, issue reports, documentation, or shell history. Calendar and Gmail token paths must be separate and confined under this repository's ignored `.bander/`; setup verifies existence and 0600 permissions without printing values.

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

Follow its empirical owner/non-owner/imitation procedure. A successful run writes a fresh signed local artifact bound to setup's current challenge and configuration digest. Boolean, stale, mismatched, or manually substituted evidence is rejected. The parent’s natural group messages should reach OpenClaw; Bander must not ambient-listen to them.

### 3. Configure OpenAI

Create a project key with access to exact model `gpt-5.6-sol`. Store it as `OPENAI_API_KEY` in `.env`. Bander uses the model only for bounded intent compilation; the model cannot select Calendar IDs, ETags, recipient routing, notification text, approval, or execution authority.

### 4. Configure separate narrow Google Desktop OAuth clients

On the **setup computer**:

1. Create or select a dedicated Google Cloud project.
2. Enable the Google Calendar API and Gmail API in the same Cloud project as the Desktop OAuth client. A valid Gmail token still returns `accessNotConfigured` until the Gmail API itself is enabled.
3. Configure an External OAuth consent screen in Testing and add the dedicated Calendar account as a test user.
4. Create an OAuth client of type **Desktop app**.
5. Configure a separate Gmail token path. The same Desktop client JSON may be reused, but the Calendar and Gmail token files must never be the same file.
6. Store client JSON and generated tokens only in ignored local storage, then configure `GOOGLE_OAUTH_CLIENT_PATH`, `GOOGLE_OAUTH_TOKEN_PATH`, `GMAIL_OAUTH_CLIENT_PATH`, and `GMAIL_OAUTH_TOKEN_PATH`.
7. Restrict all four files to the local user (`chmod 600 …`).

Bander requests only:

```text
https://www.googleapis.com/auth/calendar.events.owned
```

It fixes Calendar access to `primary`. Set `BANDER_RUNTIME_MODE=real` and set `BANDER_CALENDAR_TIME_ZONE` to the primary Calendar’s authoritative IANA timezone, such as `America/Denver`.

The separate Gmail consent requests only:

```text
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.send
```

If scopes, account, or test-user configuration changes, stop Bander, remove only the ignored Gmail token file, rerun `npm run real`, and complete consent again. Never delete or replace the Calendar token as part of Gmail rotation.

Authorize Gmail separately before starting the full stack:

```bash
npm run oauth:gmail
```

This opens Google's consent flow and writes only the ignored Gmail token file. It does not read a message, send a reply, create authority, or change Calendar state.

### 5. Pair the parent and protected group

```bash
npm run pair:real
```

If Google authorization opens, finish it with the dedicated Calendar account. Open the expiring Bander link from the ignored local pairing file on the **parent/owner phone**, in a private chat with Bander. Claim the link and choose the protected group. The first valid claimant is locked to the attempt; the link expires and is consumed after binding.

Stop the pairing process with `Ctrl-C` after Bander confirms the group.

### 6. Optionally connect one family member

The operator chooses the display label and aliases locally. OpenClaw and the model cannot create or redirect this relationship.

```bash
npm run pair:family -- --name Jason --alias "my son" --alias son
```

Remote handoff is the normal flow:

1. The technical owner creates the link on the **setup computer**.
2. Send that link privately to the invited family member.
3. The family member opens it on their own **family-contact phone** and in their own Telegram account.
4. They read the limited-role disclosure and tap **OK, keep me posted**.
5. They remain outside the protected parent group.

The same-device account-switch topology is useful for testing but is not required for a real family invitation.

### 7. Check setup, then start

In one terminal, start the isolated repository-pinned product. In a second terminal, rerun setup so its final milestone can execute the read-only live doctor, including the exact five-tool inventory:

```bash
# Terminal A
npm run real

# Terminal B
npm run setup
npm run doctor
npm run doctor -- --live
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

Stop the real stack, then use exactly one bounded command:

```bash
npm run reauthorize:google -- --calendar
npm run reauthorize:google -- --gmail
npm run reauthorize:google -- --all
```

It removes only the selected configured token under `.bander/`, preserves OAuth client JSON, and starts the matching Desktop OAuth flow. Cloud-side consent revocation remains manual. Never copy token contents into a bug report.

### Reset owner/group pairing

Stop the real service, then run `npm run reset:pairing`. It invalidates repository-local pairing state without changing bot credentials. If an active family contact exists, the command refuses; review the consequence and explicitly run `npm run reset:pairing -- --include-family` to detach the contact before removing its owning installation.

### Remove local Bander state

`npm run uninstall:local` prints a manifest-driven dry run. Confirm interactively or pass `--yes` only after review. It removes only recorded Bander-owned ignored state and unchanged `.env` keys originally created by setup; unrelated files and changed/user-supplied values survive. OAuth client JSON is preserved unless `--include-oauth-clients` is also explicitly supplied and confirmed. It never touches `~/.openclaw` or revokes a cloud account.

Corrupt or unknown setup/ownership state fails closed. Preserve it for diagnosis and follow the command's recovery guidance; Bander never silently infers that a security gate passed.

### The Calendar timezone is wrong

Run `npm run doctor -- --live`. Set `BANDER_CALENDAR_TIME_ZONE` to the authoritative timezone the primary Calendar reports, then restart. Do not use the setup computer’s implicit timezone as a substitute.

### Doctor reports a failure

Follow the exact **Next action** for the failed row. Expected missing configuration is reported without a stack trace. `WARN` means the stated limitation or optional setup remains; it is not a hidden pass.

### Clean stop and restart

Use `Ctrl-C` once in the terminal running `npm run real`, wait for both supervised processes to stop, then run `npm run real` again. Telegram installation and delivery bindings persist. In-flight production authority does not.

## Honest current limitations

- Real writes are limited to adding one timed default event or moving or cancelling one timed, non-recurring, owner-organized, attendee-free event in the connected primary Calendar. Creation has no attendees, recurrence, location, description, conferencing, attachments, custom reminders, or reservation; rescheduling preserves exact duration; cancellation removes only the exact event version shown on the Card and never contacts an external clinic, restaurant, or service.
- Schedule reads are capped at 31 days and 50 sanitized events. Calendar titles remain untrusted model input; sanitization and prompting reduce but do not eliminate prompt-injection or mis-summary risk.
- Exactly one family contact is supported. Bander can send a deterministic appointment update or one independent plain-text message only when its exact content appears on the approved Card.
- Gmail reply is limited to one resolved inbound thread, one valid Reply-To/From address, plain text, and no CC/BCC/reply-all/forwarding/attachments/new thread. Email contents enter OpenClaw’s model trajectory only when the parent asks for a bounded inbox read; sanitization and prompting do not constitute prompt-injection detection.
- Gmail and Telegram have permanent no-automatic-retry behavior after an ambiguous dispatched send. A provider acceptance is not proof the human read the message.
- Telegram delivery is not exactly once. A confirmed response is replay-safe; an ambiguous response is reported as unconfirmed and never retried automatically. Acceptance is not proof of reading.
- Core production authority is process-local and not restart-durable. Do not approve while intentionally restarting the broker.
- The Streamable HTTP MCP endpoint is loopback-only and has no application-level authentication. Do not expose it to a LAN or the public internet.
- The repository does not install additively into arbitrary pre-existing OpenClaw configurations and does not claim mass-market or cross-platform setup.
- Bander does not protect against compromise of the same operating-system user account or host.
- Standing autonomy is a deterministic sandbox proof only, not a real Google capability.

For implementation-level boundaries, see [the architecture decisions](docs/architecture.md). For reproducible checks, see [the evidence ledger](BUILD_WITH_CODEX.md).
