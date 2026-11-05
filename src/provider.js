// Telegram Bot API transport. Shared authorization, inbox and outbox live in core.
import {channel} from './channel.js';
import {conversationRoute,interactionPolicy} from '@dot-bridge/core/channels/experience-policy.js';
import {telegramHTML,splitTelegramHTML,clipText} from '@dot-bridge/core/channels/formatting.js';
import {MAX_MEDIA_BYTES as MAX_MEDIA} from '@dot-bridge/core/channels/media.js';
import {AlbumBuffer} from './album-buffer.js';
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

export function createProvider({credentials, interaction, state, onMessage, onChoice, signal, fetch = globalThis.fetch,albumTiming={}}) {
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
  let selfId,botUsername;
  const policy=interaction??interactionPolicy({},channel);
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
    if (!running || controller.signal.aborted || !conversationRoute({channel,credentials,interaction:policy},message)) throw new Error('Telegram reply binding is invalid.');
    if (!Number.isSafeInteger(message.replyContext?.messageId) || message.replyContext.messageId<=0 || String(message.replyContext.messageId)!==message.id) throw new Error('Telegram reply binding is invalid.');
    if (message.replyContext.threadId!==undefined&&(!Number.isSafeInteger(message.replyContext.threadId)||message.replyContext.threadId<=0)) throw new Error('Telegram reply binding is invalid.');
    return message.conversationId;
  }
  function textPayload(message,text,format='text') {
    const target=binding(message),html=format==='html'?text:telegramHTML(text).html;
    return {chat_id:target,text:html,parse_mode:'HTML',reply_parameters:{message_id:message.replyContext.messageId,allow_sending_without_reply:true},link_preview_options:{is_disabled:true},...(message.replyContext.threadId===undefined?{}:{message_thread_id:message.replyContext.threadId})};
  }
  function checkedMessage(value,target) { if(!Number.isSafeInteger(value?.message_id)||value.message_id<=0||String(value.chat?.id)!==target)throw failure();return value; }

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
    if(update.callback_query){
      const query=update.callback_query,message=query.message;
      if(typeof onChoice!=='function'||typeof query.id!=='string'||query.id.length>256||query.from?.is_bot!==false||!Number.isSafeInteger(query.from.id)||!Number.isSafeInteger(message?.chat?.id)||!Number.isSafeInteger(message.message_id)||message.message_id<=0||String(message.from?.id)!==selfId||typeof query.data!=='string'||!/^db_[A-Za-z0-9_-]{24}$/.test(query.data))return;
      const normalized={id:String(message.message_id),senderId:String(query.from.id),conversationId:String(message.chat.id),botMentioned:true,text:'',replyContext:{messageId:message.message_id},attachments:[]};
      if(Number.isSafeInteger(message.message_thread_id)&&message.message_thread_id>0){normalized.threadId=String(message.message_thread_id);normalized.replyContext.threadId=message.message_thread_id;}
      const result=await onChoice({token:query.data,senderId:normalized.senderId,conversationId:normalized.conversationId,threadId:normalized.threadId,message:normalized});
      await request('answerCallbackQuery',{callback_query_id:query.id,text:result?.accepted?'已选择 '+result.label:'选项已过期或已由原发送者处理',cache_time:0},5000);
      return;
    }
    const message=update.message;
    if(!message||message.from?.is_bot!==false||!Number.isSafeInteger(message.from.id)||!Number.isSafeInteger(message.chat?.id)||!Number.isSafeInteger(message.message_id)||message.message_id<=0)return;
    const chatType=message.chat.type==='private'?'private':['group','supergroup'].includes(message.chat.type)?'group':null;if(!chatType)return;
    const text=typeof message.text==='string'?message.text:typeof message.caption==='string'?message.caption:'';
    if(/^\/start db_[a-f0-9]{32}$/.test(text))return;
    const {attachments,references}=metadata(message);
    if((!text&&!attachments.length)||text.length>20000||!text.isWellFormed()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))return;
    const entities=message.entities??message.caption_entities??[];
    const botMentioned=message.reply_to_message?.from?.id===Number(selfId)&&String(message.reply_to_message?.chat?.id??message.chat.id)===String(message.chat.id)||Array.isArray(entities)&&entities.some(entity=>{
      if(entity.type==='text_mention')return String(entity.user?.id)===selfId;
      if(!Number.isSafeInteger(entity.offset)||!Number.isSafeInteger(entity.length)||entity.offset<0||entity.length<1)return false;
      const value=text.slice(entity.offset,entity.offset+entity.length).toLowerCase();
      return !!botUsername&&(entity.type==='mention'&&value==='@'+botUsername.toLowerCase()||entity.type==='bot_command'&&value.endsWith('@'+botUsername.toLowerCase()));
    });
    const normalized={id:String(message.message_id),senderId:String(message.from.id),conversationId:String(message.chat.id),chatType,botMentioned,text,forwarded:!!(message.forward_origin||message.forward_from||message.forward_from_chat||message.forward_date||message.is_automatic_forward),replyContext:{messageId:message.message_id,attachments:references},attachments};
    if(Number.isSafeInteger(message.message_thread_id)&&message.message_thread_id>0){normalized.replyContext.threadId=message.message_thread_id;normalized.threadId=String(message.message_thread_id);}
    const route=conversationRoute({channel,credentials,interaction:policy},normalized);
    const album=typeof message.media_group_id==='string'&&message.media_group_id.length<=256&&normalized.attachments.length>0;
    const group=policy.groups.find(item=>item.enabled&&item.conversationId===normalized.conversationId);
    const admittedMember=group&&(group.members==='all'||group.members==='owner'&&normalized.senderId===ownerId||group.members==='allowlist'&&group.allowFrom.includes(normalized.senderId));
    if(!route&&!(album&&chatType==='group'&&admittedMember))return;
    const quoted=message.reply_to_message;
    if(quoted&&String(quoted.chat?.id??message.chat.id)===normalized.conversationId){const quote=typeof quoted.text==='string'?quoted.text:typeof quoted.caption==='string'?quoted.caption:'';if(quote&&quote.isWellFormed())normalized.quote={text:clipText(quote,4000),truncated:quote.length>4000};}
    if(Number.isSafeInteger(message.date)&&message.date>0&&Number.isSafeInteger(message.date*1000)&&message.date*1000<=8640000000000000)normalized.timestamp=message.date*1000;
    if(album)await albums.add(normalized,message.media_group_id);
    else await onMessage(normalized);
  }

  const albums=new AlbumBuffer({state,onMessage,authorize:message=>!!conversationRoute({channel,credentials,interaction:policy},message),...albumTiming});

  async function poll() {
    let backoff = 1000;
    while (running && !controller.signal.aborted) {
      try {
        await albums.flushReady();
        const offset = state.get('offset');
        if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw failure(true);
        const updates = await request('getUpdates', {timeout:albums.hasPending()?1:30, limit:100, allowed_updates:typeof onChoice==='function'?['message','callback_query']:['message'], ...(offset !== undefined ? {offset} : {})}, 40000);
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
        await albums.flushReady();
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
        state.set('botId', String(me.id));selfId=String(me.id);botUsername=typeof me.username==='string'?me.username:'';
        if(typeof onChoice==='function'&&policy.management.enabled&&state.get('ownerMenuVersion')!==1){
          try{
            await request('setMyCommands',{scope:{type:'chat',chat_id:conversationId},commands:[{command:'help',description:'查看可用操作'},{command:'status',description:'查看连接与队列状态'},{command:'queue',description:'查看当前待回复消息'},{command:'subscription',description:'查看原 dot 的订阅状态'},{command:'cancel',description:'取消最近一条尚未发送的桥接回复'}]},5000);
            state.set('ownerMenuVersion',1);
          }catch{/* A command-menu failure must not stop the message consumer. */}
        }
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
    async setFeedback({message,active,authorize}) {
      const target=binding(message);authorize();await request('setMessageReaction',{chat_id:target,message_id:message.replyContext.messageId,reaction:active?[{type:'emoji',emoji:'👀'}]:[],is_big:false},5000);return null;
    },
    async setTyping({message,active,authorize}) {
      const target=binding(message);if(!active)return;authorize();await request('sendChatAction',{chat_id:target,action:'typing',...(message.replyContext.threadId===undefined?{}:{message_thread_id:message.replyContext.threadId})},5000);
    },
    canProgressFinal({text,format}) {return (format==='html'?text.replace(/<[^>]*>/g,'').replace(/&(?:amp|lt|gt|quot);/g,'x').length:telegramHTML(text).plain.length)<=channel.nativeMaxReplyText;},
    async sendChoiceReply({message,text,choices,reference,authorize}) {
      const target=binding(message);
      const buttons=choices.map(choice=>({text:choice.label,callback_data:choice.token}));
      const keyboard=[];
      for(let index=0;index<buttons.length;index+=2)keyboard.push(buttons.slice(index,index+2));
      const payload={...textPayload(message,text),reply_markup:{inline_keyboard:keyboard}};
      authorize();
      if(reference){
        if(reference.conversationId!==target||!id(reference.id))throw failure();
        checkedMessage(await request('editMessageText',{chat_id:target,message_id:Number(reference.id),text:payload.text,parse_mode:'HTML',reply_markup:payload.reply_markup},10000),target);
        return reference;
      }
      const sent=checkedMessage(await request('sendMessage',payload),target);
      return {id:String(sent.message_id),conversationId:target};
    },
    async sendProgress({message,text,format,reference,final=false,authorize}) {
      const target=binding(message);
      if(!final&&telegramHTML(text).plain.length>3900)text=clipText(text,3000)+'\n…（完整回答将在完成后发送 / full answer follows）';
      const payload=textPayload(message,text,format);
      authorize();
      if(reference){if(reference.conversationId!==target||!id(reference.id))throw failure();const result=await request('editMessageText',{chat_id:target,message_id:Number(reference.id),text:payload.text,parse_mode:'HTML',link_preview_options:{is_disabled:true}},10000);checkedMessage(result,target);return reference;}
      const result=checkedMessage(await request('sendMessage',{...payload,disable_notification:true},10000),target);return {id:String(result.message_id),conversationId:target};
    },
    async finishProgress({message,reference,cancelled,authorize}) {if(!cancelled)return;const target=binding(message);if(reference.conversationId!==target||!id(reference.id))throw failure();authorize();await request('deleteMessage',{chat_id:target,message_id:Number(reference.id)},10000);},
    planTextReply(text) {return splitTelegramHTML(telegramHTML(text).html).map(text=>({text,format:'html'}));},
    async sendTextPart({message,text,format,authorize}) {const payload=textPayload(message,text,format);authorize();const result=checkedMessage(await request('sendMessage',payload),message.conversationId);return {providerMessageId:String(result.message_id)};},
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
      form.set('chat_id', message.conversationId);
      form.set('reply_parameters', JSON.stringify({message_id:message.replyContext.messageId, allow_sending_without_reply:true}));
      if (message.replyContext.threadId !== undefined) form.set('message_thread_id', String(message.replyContext.threadId));
      if (text) form.set('caption', text);
      form.set(field, new Blob([media.data], {type:media.mimeType}), media.name);
      // No URL uploads and no automatic retry: a failed POST may already have delivered.
      authorize();
      const sent = await request({image:'sendPhoto', audio:'sendVoice', file:'sendDocument'}[media.type], form, 30000);
      if (!Number.isSafeInteger(sent?.message_id) || sent.message_id <= 0 || String(sent.chat?.id) !== message.conversationId) throw failure();
      return {providerMessageId:String(sent.message_id)};
    },
    async sendReply({message, text, idempotencyKey, authorize = () => {}}) {
      binding(message);
      if (typeof text !== 'string' || !text.trim() || !text.isWellFormed() || text.length > channel.maxReplyText || Buffer.byteLength(text) > 60000) throw new Error('Telegram reply must contain 1 to 20,000 characters.');
      if (telegramHTML(text).plain.length > channel.nativeMaxReplyText) {
        const data=Buffer.from(text,'utf8');try{return await provider.sendMediaReply({message,media:{type:'file',data,mimeType:'text/plain',name:'answer.txt'},idempotencyKey,authorize});}finally{data.fill(0);}
      }
      const payload=textPayload(message,text);

      // Bot API sendMessage has no idempotency key. A failed send is never retried here.
      authorize();
      const sent = await request('sendMessage', payload);
      if (!Number.isSafeInteger(sent?.message_id) || String(sent.chat?.id) !== message.conversationId) throw failure();
      return {providerMessageId:String(sent.message_id)};
    }
  };
  return provider;
}
