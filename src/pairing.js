import {randomBytes} from 'node:crypto';

const API = 'https://api.telegram.org';
const tokenValid = value => typeof value === 'string' && /^[1-9][0-9]{0,19}:[A-Za-z0-9_-]{20,200}$/.test(value);
const reject = reason => Object.assign(new Error('Telegram owner pairing did not complete.'), {reason});

// The helper returns verified credentials in memory. It never writes credentials,
// acknowledges an update, removes a webhook, or sends a Telegram message.
export async function createOwnerPairing({botToken, confirmStopped = false, signal, fetch = globalThis.fetch, clock = Date.now, nonce = () => randomBytes(16).toString('hex')} = {}) {
  if (!confirmStopped) throw reject('confirm_stopped_required');
  if (!tokenValid(botToken)) throw reject('invalid_token');
  const request = async (method, body, remaining = 15000) => {
    if (signal?.aborted) throw reject('pairing_cancelled');
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), Math.max(1, Math.min(15000, remaining)));
    timer.unref?.();
    try {
      const url=`${API}/bot${botToken}/${method}`;
      const response = await fetch(url, {method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:signal ? AbortSignal.any([signal,deadline.signal]) : deadline.signal});
      if (response.redirected || !response.body || (response.url && response.url !== url)) throw reject('telegram_response_invalid');
      const chunks = []; let size = 0;
      const reader = response.body.getReader();
      let value;
      try {
        for (;;) { const {done,value:chunk} = await reader.read(); if (done) break; size += chunk.byteLength; if (size > 2*1024*1024) throw reject('telegram_response_invalid'); chunks.push(Buffer.from(chunk)); }
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if ([401,403].includes(response.status) || [401,403].includes(value?.error_code)) throw reject('bot_token_rejected');
      if (response.status === 409 || value?.error_code === 409) throw reject('another_consumer_or_webhook');
      if (!response.ok || value?.ok !== true) throw reject('telegram_request_failed');
      return value.result;
    } catch (error) { const reasons=['telegram_response_invalid','bot_token_rejected','another_consumer_or_webhook','telegram_request_failed'];throw reject(reasons.includes(error?.reason) ? error.reason : signal?.aborted ? 'pairing_cancelled' : 'telegram_request_failed'); }
    finally { clearTimeout(timer); deadline.abort(); }
  };
  const bot = await request('getMe', {});
  if (bot?.is_bot !== true || !Number.isSafeInteger(bot.id) || String(bot.id) !== botToken.split(':')[0]) throw reject('bot_identity_mismatch');
  const hook = await request('getWebhookInfo', {});
  if (!hook || hook.url !== '') throw reject('existing_webhook_preserved');
  const code = nonce();
  if (typeof code !== 'string' || !/^[a-f0-9]{32}$/.test(code)) throw reject('invalid_pairing_nonce');
  const started = clock(), expiresAt = started + 120000, command = `/start db_${code}`;
  let waiting = false;
  return {
    command, expiresAt,
    async waitForOwner() {
      if (waiting) throw reject('pairing_already_waited');
      waiting = true;
      while (clock() < expiresAt && !signal?.aborted) {
        // Omitting offset intentionally leaves every update pending. Normal live
        // ingestion will acknowledge it only after durable persistence.
        const updates = await request('getUpdates', {timeout:Math.min(10,Math.floor((expiresAt-clock())/1000)),limit:100,allowed_updates:['message']}, expiresAt-clock());
        if (!Array.isArray(updates) || updates.length > 100) throw reject('telegram_response_invalid');
        if(signal?.aborted)throw reject('pairing_cancelled');
        const matches = updates.map(update=>update?.message).filter(message =>
          message?.text === command && message.chat?.type === 'private' && message.from?.is_bot === false && !message.forward_origin && !message.via_bot &&
          Number.isSafeInteger(message.from.id) && message.from.id > 0 && message.from.id !== bot.id && message.chat.id === message.from.id &&
          Number.isSafeInteger(message.message_id) && message.message_id > 0 && Number.isSafeInteger(message.date) &&
          message.date*1000 >= started-1000 && message.date*1000 <= Math.min(expiresAt,clock()+5000));
        if (clock() >= expiresAt) throw reject('pairing_expired');
        if (matches.length > 1) throw reject('ambiguous_pairing_messages');
        if (matches.length === 1) return {botToken,ownerId:String(matches[0].from.id),conversationId:String(matches[0].chat.id)};
        if (updates.length === 100) throw reject('pending_updates_require_review');
        await new Promise(resolve => {
          if (signal?.aborted) return resolve();
          const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();};
          const timer=setTimeout(done,250);signal?.addEventListener('abort',done,{once:true});
        });
      }
      throw reject(signal?.aborted ? 'pairing_cancelled' : 'pairing_expired');
    }
  };
}
