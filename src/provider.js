// Telegram Bot API transport. Shared authorization, inbox and outbox live in core.
import {channel} from './channel.js';
import {MAX_MEDIA_BYTES as MAX_MEDIA} from '@dot-bridge/core/channels/media.js';
const API = 'https://api.telegram.org';
const MAX_BODY = 2 * 1024 * 1024;
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const fileId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,1024}$/.test(value);
const mime = value => typeof value === 'string' && /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(value) && value.length <= 127;

function validateMediaReply({media, text = ''} = {}) {
  if (!media || !['image', 'audio', 'file'].includes(media.type) || !Buffer.isBuffer(media.data) || media.data.length < 1 || media.data.length > MAX_MEDIA) throw new Error('Telegram media must contain 1 byte to 5 MiB.');
  if (!mime(media.mimeType) || typeof media.name !== 'string' || !media.name || media.name.length > 255 || /[\u0000-\u001f\u007f/\\]|\p{Surrogate}/u.test(media.name) || ['.', '..'].includes(media.name)) throw new Error('Telegram media name or MIME type is invalid.');
  if (media.type === 'image' && !['image/jpeg', 'image/png'].includes(media.mimeType)) throw new Error('Telegram image replies require JPEG or PNG; send other formats as a file.');
  if (media.type === 'audio' && !['audio/ogg', 'audio/mpeg', 'audio/mp4'].includes(media.mimeType)) throw new Error('Telegram voice replies require OGG/Opus, MP3 or M4A; send other formats as a file.');
  if (typeof text !== 'string' || text.length > 1024 || /\p{Surrogate}|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new Error('Telegram media caption must contain at most 1024 characters.');
}

function failure(fatal = false) {
  return Object.assign(new Error('Telegram request failed.'), {fatal});
}

function optionalMetadata(value, limit) {
  if (typeof value !== 'string' || !value.length || /\p{Surrogate}|[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  let result = '';
  for (const character of value) {
    if (result.length + character.length > limit) break;
    result += character;
  }
  return result || undefined;
}

async function readJson(response) {
  if (!response.body || response.redirected) throw failure();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY) throw failure();
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function metadata(message) {
  const result = [];
  const references = [];
  const add = (value, kind, defaultMime) => {
    const item = {kind};
    const name = optionalMetadata(value.file_name, 255);
    const mimeType = optionalMetadata(value.mime_type, 127);
    if (name !== undefined) item.name = name;
    if (mimeType !== undefined) item.mimeType = mimeType;
    result.push(item);
    // File IDs are stored only inside core's encrypted, private replyContext.
    references.push(fileId(value.file_id) ? {fileId:value.file_id, ...(Number.isSafeInteger(value.file_size) && value.file_size >= 0 ? {size:value.file_size} : {}), ...(defaultMime ? {defaultMime} : {})} : null);
  };
  for (const [field, kind] of Object.entries({voice:'audio', audio:'audio', video:'video', video_note:'video', animation:'video', document:'file', sticker:'image'})) {
    const value = message[field];
    if (!value || typeof value !== 'object') continue;
    add(value, kind, field === 'voice' ? 'audio/ogg' : undefined);
  }
  if (Array.isArray(message.photo) && message.photo.length) {
    const photos = message.photo.filter(value => value && typeof value === 'object');
    const photo = photos.reduce((largest, value) => ((value.width * value.height || 0) >= (largest?.width * largest?.height || 0) ? value : largest), undefined);
    if (photo) add(photo, 'image', 'image/jpeg');
  }
  return {attachments:result.slice(0, 10), references:references.slice(0, 10)};
}

export function createProvider({credentials, state, onMessage, signal, fetch = globalThis.fetch}) {
  const {botToken, ownerId, conversationId} = credentials ?? {};
  if (typeof botToken !== 'string' || !/^[1-9][0-9]{0,19}:[A-Za-z0-9_-]{20,200}$/.test(botToken) || !id(ownerId) || !id(conversationId)) {
    throw new Error('Telegram credentials require a bot token and numeric owner/private chat IDs.');
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, {once:true});
  if (signal?.aborted) abort();
  let running = false;
  let connected = false;
  let blocked = false;
  let started = false;
  let loop = Promise.resolve();
  const requests = new Set();

  function request(method, payload = {}, timeout = 15000) {
    const task = (async () => {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), timeout);
      timer.unref?.();
      try {
        const response = await fetch(`${API}/bot${botToken}/${method}`, {
          method:'POST', redirect:'error',
          signal:AbortSignal.any([controller.signal, deadline.signal]),
          ...(payload instanceof FormData ? {body:payload} : {headers:{'content-type':'application/json'}, body:JSON.stringify(payload)})
        });
        const value = await readJson(response);
        if (!response.ok || value?.ok !== true) throw failure([401, 403, 409].includes(response.status) || [401, 403, 409].includes(value?.error_code));
        return value.result;
      } catch (error) {
        throw failure(error?.fatal === true);
      } finally {
        clearTimeout(timer);
      }
    })();
    requests.add(task);
    task.then(() => requests.delete(task), () => requests.delete(task));
    return task;
  }

  function binding(message) {
    if (!running || controller.signal.aborted) throw new Error('Telegram provider is not running.');
    if (message?.senderId !== ownerId || message?.conversationId !== conversationId || !Number.isSafeInteger(message.replyContext?.messageId) || message.replyContext.messageId <= 0 || String(message.replyContext.messageId) !== message.id) throw new Error('Telegram reply binding is invalid.');
    const thread = message.replyContext.threadId;
    if (thread !== undefined && (!Number.isSafeInteger(thread) || thread <= 0)) throw new Error('Telegram reply binding is invalid.');
  }

  function download(path) {
    // getFile supplies the path, but it must remain under this bot's official file endpoint.
    if (typeof path !== 'string' || path.length > 1024 || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(path)) throw failure();
    const task = (async () => {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), 30000);
      timer.unref?.();
      try {
        const url = `${API}/file/bot${botToken}/${path}`;
        const response = await fetch(url, {redirect:'error', signal:AbortSignal.any([controller.signal, deadline.signal])});
        if (!response.ok || response.redirected || !response.body || (response.url && response.url !== url)) throw failure();
        const size = response.headers.get('content-length');
        if (size !== null && (!/^\d+$/.test(size) || Number(size) > MAX_MEDIA)) throw failure();
        const reader = response.body.getReader();
        const chunks = [];
        let length = 0;
        try {
          for (;;) {
            const {done, value} = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_MEDIA || controller.signal.aborted || deadline.signal.aborted) throw failure();
            chunks.push(Buffer.from(value));
          }
          if (!length) throw failure();
          return {data:Buffer.concat(chunks), mimeType:response.headers.get('content-type')?.split(';')[0]?.trim()};
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } catch { throw failure(); }
      finally { clearTimeout(timer); deadline.abort(); }
    })();
    requests.add(task);
    task.then(() => requests.delete(task), () => requests.delete(task));
    return task;
  }

  function wait(milliseconds) {
    return new Promise(resolve => {
      if (controller.signal.aborted) return resolve();
      const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, milliseconds);
      controller.signal.addEventListener('abort', done, {once:true});
    });
  }

  async function ingest(update) {
    const message = update.message;
    if (!message || message.chat?.type !== 'private' || message.from?.is_bot !== false || String(message.from.id) !== ownerId || String(message.chat.id) !== conversationId) return;
    if (!Number.isSafeInteger(message.message_id) || message.message_id <= 0) return;
    const text = typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : '';
    if (/^\/start db_[a-f0-9]{32}$/.test(text)) return;
    const {attachments, references} = metadata(message);
    if ((!text && !attachments.length) || text.length > 20000 || /\p{Surrogate}|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return;
    const normalized = {
      id:String(message.message_id), senderId:ownerId, conversationId, text,
      replyContext:{messageId:message.message_id, attachments:references}, attachments
    };
    if (Number.isSafeInteger(message.date) && message.date > 0 && Number.isSafeInteger(message.date * 1000) && message.date * 1000 <= 8640000000000000) normalized.timestamp = message.date * 1000;
    if (Number.isSafeInteger(message.message_thread_id) && message.message_thread_id > 0) normalized.replyContext.threadId = message.message_thread_id;
    await onMessage(normalized);
  }

  async function poll() {
    let backoff = 1000;
    while (running && !controller.signal.aborted) {
      try {
        const offset = state.get('offset');
        if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw failure(true);
        const updates = await request('getUpdates', {timeout:30, limit:100, allowed_updates:['message'], ...(offset !== undefined ? {offset} : {})}, 40000);
        if (!Array.isArray(updates) || updates.length > 100 || updates.some(u => !Number.isSafeInteger(u?.update_id) || u.update_id < 0 || !Number.isSafeInteger(u.update_id + 1))) throw failure();
        connected = true;
        for (const update of [...updates].sort((a,b) => a.update_id - b.update_id)) {
          if (!running || controller.signal.aborted) break;
          const cursor = state.get('offset');
          if (cursor !== undefined && update.update_id < cursor) continue;
          await ingest(update);
          state.set('offset', update.update_id + 1);
        }
        backoff = 1000;
        // Avoid a hot loop if an upstream proxy answers empty long polls early.
        if (updates.length === 0) await wait(100);
      } catch (error) {
        connected = false;
        if (!running || controller.signal.aborted) break;
        if (error?.fatal) { blocked = true; running = false; break; }
        await wait(backoff);
        backoff = Math.min(30000, backoff * 2);
      }
    }
    connected = false;
  }

  const provider = {
    async start() {
      if (started || controller.signal.aborted) throw new Error('Telegram provider cannot be started.');
      started = true;
      try {
        const me = await request('getMe');
        if (me?.is_bot !== true || !Number.isSafeInteger(me.id) || String(me.id) !== botToken.split(':')[0] || String(me.id) === ownerId) throw failure(true);
        const webhook = await request('getWebhookInfo');
        if (!webhook || typeof webhook.url !== 'string' || webhook.url !== '') throw new Error('Telegram already has a webhook; coordinate its removal before polling.');
        const storedBot = state.get('botId');
        if (storedBot !== undefined && storedBot !== String(me.id)) throw failure(true);
        state.set('botId', String(me.id));
        if (controller.signal.aborted) throw failure();
        running = true;
        loop = poll().catch(() => { running = false; connected = false; blocked = true; });
      } catch (error) {
        blocked = true;
        if (error?.message === 'Telegram already has a webhook; coordinate its removal before polling.') throw error;
        throw new Error('Telegram initialization failed.');
      }
    },
    async stop() {
      running = false;
      connected = false;
      controller.abort();
      signal?.removeEventListener('abort', abort);
      await loop;
      await Promise.allSettled([...requests]);
    },
    status() { return {connected, running, blocked}; },
    async sendOwnerMessage({text, authorize}) {
      if (!running || controller.signal.aborted || typeof text !== 'string' || !text.trim() || !text.isWellFormed() || text.length > 2000) throw failure();
      authorize();
      const sent = await request('sendMessage', {chat_id:conversationId, text, link_preview_options:{is_disabled:true}});
      if (!Number.isSafeInteger(sent?.message_id) || sent.message_id <= 0 || String(sent.chat?.id) !== conversationId) throw failure();
      return {};
    },
    validateMediaReply,
    async readAttachment({message, attachmentIndex}) {
      binding(message);
      if (!Number.isSafeInteger(attachmentIndex) || attachmentIndex < 0 || attachmentIndex >= (message.attachments?.length ?? 0) || attachmentIndex >= 10) throw new Error('Telegram attachment is unavailable.');
      const ref = message.replyContext.attachments?.[attachmentIndex];
      const item = message.attachments[attachmentIndex];
      if (!fileId(ref?.fileId) || !['image', 'audio', 'file'].includes(item.kind) || (ref.size !== undefined && (!Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size > MAX_MEDIA))) throw new Error('Telegram attachment is unavailable or exceeds 5 MiB.');
      const file = await request('getFile', {file_id:ref.fileId});
      if (file?.file_id !== ref.fileId || (file.file_size !== undefined && (!Number.isSafeInteger(file.file_size) || file.file_size < 0 || file.file_size > MAX_MEDIA))) throw failure();
      const result = await download(file.file_path);
      return {...result, mimeType:mime(result.mimeType) && result.mimeType !== 'application/octet-stream' ? result.mimeType : mime(item.mimeType) ? item.mimeType : ref.defaultMime ?? 'application/octet-stream', ...(item.name ? {name:item.name} : {})};
    },
    async sendMediaReply({message, media, text = '', authorize = () => {}}) {
      binding(message);
      validateMediaReply({media, text});
      const field = {image:'photo', audio:'voice', file:'document'}[media.type];
      const form = new FormData();
      form.set('chat_id', conversationId);
      form.set('reply_parameters', JSON.stringify({message_id:message.replyContext.messageId, allow_sending_without_reply:true}));
      if (message.replyContext.threadId !== undefined) form.set('message_thread_id', String(message.replyContext.threadId));
      if (text) form.set('caption', text);
      form.set(field, new Blob([media.data], {type:media.mimeType}), media.name);
      // No URL uploads and no automatic retry: a failed POST may already have delivered.
      authorize();
      const sent = await request({image:'sendPhoto', audio:'sendVoice', file:'sendDocument'}[media.type], form, 30000);
      if (!Number.isSafeInteger(sent?.message_id) || sent.message_id <= 0 || String(sent.chat?.id) !== conversationId) throw failure();
      return {providerMessageId:String(sent.message_id)};
    },
    async sendReply({message, text, idempotencyKey, authorize = () => {}}) {
      binding(message);
      if (typeof text !== 'string' || !text.trim() || !text.isWellFormed() || text.length > channel.maxReplyText || Buffer.byteLength(text) > 60000) throw new Error('Telegram reply must contain 1 to 20,000 characters.');
      if (text.length > channel.nativeMaxReplyText) {
        const data = Buffer.from(text, 'utf8');
        try { return await provider.sendMediaReply({message, media: {type: 'file', data, mimeType: 'text/plain', name: 'answer.txt'}, idempotencyKey, authorize}); }
        finally { data.fill(0); }
      }
      const payload = {chat_id:conversationId, text, reply_parameters:{message_id:message.replyContext.messageId, allow_sending_without_reply:true}, link_preview_options:{is_disabled:true}};
      const thread = message.replyContext.threadId;
      if (thread !== undefined) {
        if (!Number.isSafeInteger(thread) || thread <= 0) throw new Error('Telegram reply binding is invalid.');
        payload.message_thread_id = thread;
      }
      // Bot API sendMessage has no idempotency key. A failed send is never retried here.
      authorize();
      const sent = await request('sendMessage', payload);
      if (!Number.isSafeInteger(sent?.message_id) || String(sent.chat?.id) !== conversationId) throw failure();
      return {providerMessageId:String(sent.message_id)};
    }
  };
  return provider;
}
