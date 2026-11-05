# Connect Telegram

[中文](setup.md) · [English](setup.en.md)

Create or reuse a bot in [BotFather](https://t.me/BotFather). Store its token in a protected file on the runtime host. Use Node.js >=24.15 and <25, then install the lockfile with `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`.

## Pair the owner DM

Use the final service account and stop the previous consumer. Keep an existing verified binding during an upgrade.

Save the token alone in a private text file, such as `/var/lib/dot-bridge/private/telegram/bot-token.txt`. Linux directories are 0700 and files 0600, owned by the runtime user; Windows uses private ACLs. Prepare the destination directory first.

```sh
node scripts/pair-owner.js \
  --token-file /var/lib/dot-bridge/private/telegram/bot-token.txt \
  --credentials-file /var/lib/dot-bridge/private/telegram/credentials.json \
  --confirm-stopped --confirm-private-storage
```

Send the complete temporary `/start db_…` command from your own account within two minutes. A normal greeting or the Start button alone does not complete this pairing. The command saves only a verified binding, leaves existing credentials intact and prints no token or private identity.

An existing webhook, another consumer or an excessive backlog stops pairing. Coordinate migration or outstanding work first. Pairing preserves the update queue and sends no bot reply.

## Connect the original dot

1. Point `TELEGRAM_CREDENTIALS_FILE` to the binding and configure the [environment example](telegram.env.example).
2. Start this backend through the unified service entry. Refresh the existing Tunnel plugin's tools.
3. Reuse/renew the existing `telegram.message.created` task with `conversation=owner`. Create a task only when none exists.
4. Obtain the exact callback hostname from the real subscription flow, approve it, and configure `CALLBACK_HOSTS`.
5. Send a normal owner DM and verify one reply in that DM. Then test the media formats you need.

For component operation:

```sh
node --env-file=/var/lib/dot-bridge/private/telegram.env scripts/run-live.js --confirm-live
```

## Interaction and recovery

The [README](../README.en.md#feedback-context-and-owner-commands) covers the protected feedback/context policy, cumulative progressive edits, owner commands and opt-in groups/forum topics. New groups remain disabled until their exact rules and platform visibility are approved, with the existing subscription coordinated to the configured scope.

Complete answers are limited to 20,000 characters. Above 4,096 native characters, the default delivers one full `answer.txt`; optional durable chunks are available. Attachments are at most 5 MiB, captions at most 1,024 characters. Voice accepts OGG/Opus, MP3 or M4A. Protected Linux processing provides optional document excerpts and local transcription.

Keep one consumer, the original storage key and database. Review gateway state and the real dot subscription separately. The original dot/platform renews subscriptions. Unknown sends remain `uncertain` across restart and are reviewed before any manual recovery.
