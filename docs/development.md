# Provider implementation notes

The Telegram transport uses only the official Bot API HTTPS origin, via POST
JSON or bytes-only multipart uploads. There are no SDK dependencies or configurable API hosts. Shared MCP,
storage, callback policy and outbox are supplied by `@dot-bridge/core/channels`.

Initialization calls `getMe` and `getWebhookInfo`; a configured webhook blocks
startup without changing platform settings. Polls use `getUpdates` with a
30-second server timeout, 40-second request deadline, at most 100 updates and
`allowed_updates: ["message"]`. Persistent offset is advanced for each update
only after awaited ingestion succeeds. Filtered updates can be acknowledged;
an ingestion exception stops the batch without skipping that update or later
updates. Network recovery uses capped backoff; authentication errors or a 409
polling conflict block automatic recovery. A small wait avoids an empty-poll
busy loop.

HTTP refuses redirects and limits responses to 2 MiB. Errors contain fixed
strings. Public attachment records contain only bounded type/name/MIME metadata.
File IDs and declared sizes are retained in the encrypted private replyContext,
aligned with metadata indexes. `getFile` and the constructed official per-bot
download path are validated; redirects and media larger than 5 MiB are rejected.
Replies use the stored private chat/message binding
and disable link previews. There is no parse mode or multi-send splitting.
`sendReply` accepts at most 20,000 well-formed UTF-16 characters / 60,000 UTF-8
bytes; above the native 4,096-character threshold it chooses one `sendDocument`
with the complete `answer.txt` before sending anything. There is no alternate
path after an uncertain upload/send.
`sendMessage` has no idempotency parameter; no uncertain send is retried.
Stop aborts pending requests and awaits the poll loop, ingestion and sends.

Media replies use `sendPhoto`, `sendVoice` or `sendDocument` with bytes-only
FormData. Synchronous validation rejects unsupported formats or captions before
outbox queueing. Voice-note OGG data must be Opus encoded. Downloads and uploads
are fixture-tested; this repository does not claim real-account media acceptance
from synthetic fixtures alone.

Owner pairing requires explicit stopped-consumer confirmation and a fresh
128-bit nonce in the same user's one-to-one private chat. Pairing never sends
messages, acknowledges updates, removes webhooks or overwrites credentials.
The operator CLI reads through core private-file protection and writes a new
file with the existing core directory/Windows primitives only after approval.

Fixture tests cover durable offset ordering/redelivery, scope filtering,
attachment metadata, stored reply binding, limits, uncertain sends, abort/drain,
webhook migration refusal, polling conflict and response bounds. Run
`npm run check` and `npm test` with a supported Node release. Real Telegram
accounts and dot subscription acceptance remain separate live steps.

Protocol references:

- https://core.telegram.org/bots/api#getupdates
- https://core.telegram.org/bots/api#getwebhookinfo
- https://core.telegram.org/bots/api#sendmessage

The adapter layout was compared with cc-connect at
`2dec7173bdd44ec598c3c7e5c7ff00407acfdedf`; implementation is original and follows
this project's single-owner durable-ingestion contract.
