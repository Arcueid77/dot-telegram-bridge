# Provider implementation notes

The Telegram transport uses only the official Bot API HTTPS origin, via POST
JSON. There are no SDK dependencies or configurable API hosts. Shared MCP,
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
strings. Attachment records contain only bounded type/name/MIME metadata, not
Telegram file IDs or URLs. Replies use the stored private chat/message binding
and disable link previews. There is no parse mode or automatic split/fallback.
`sendMessage` has no idempotency parameter; no uncertain send is retried.
Stop aborts pending requests and awaits the poll loop, ingestion and sends.

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
