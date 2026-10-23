import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createProvider} from '../src/provider.js';
import {channel} from '../src/channel.js';

const credentials = {botToken:'12345:abcdefghijklmnopqrstuvwx', ownerId:'123', conversationId:'123'};
const apiResponse = value => new Response(JSON.stringify({ok:true,result:value}));
const suspended = signal => new Promise((_, reject) => signal.aborted ? reject(new Error('abort')) : signal.addEventListener('abort', () => reject(new Error('abort')), {once:true}));
async function until(condition) { for (let i = 0; i < 500; i++) { if (condition()) return; await delay(2); } assert.fail('condition timed out'); }
async function fixture(t, options = {}) {
  const seen = [], calls = [], values = new Map();
  let polled = false;
  const incoming = options.message ?? {message_id:1,from:{id:123,is_bot:false},chat:{id:123,type:'private'},photo:[{file_id:'small',width:10,height:10,file_size:3},{file_id:'large',width:20,height:20,file_size:4}],voice:{file_id:'voice-file',mime_type:'audio/ogg',file_size:4},document:{file_id:'document-file',file_name:'report.pdf',mime_type:'application/pdf',file_size:4}};
  const fetch = async (url, init) => {
    calls.push({url, init});
    assert.equal(init.redirect, 'error');
    assert.equal(new URL(url).origin, 'https://api.telegram.org');
    if (new URL(url).pathname.startsWith('/file/')) return options.download ? options.download(url, init) : new Response(Buffer.from('DATA'), {headers:{'content-type':'application/octet-stream'}});
    const method = url.split('/').at(-1);
    const body = init.body instanceof FormData ? init.body : JSON.parse(init.body);
    if (method === 'getMe') return apiResponse({id:12345,is_bot:true});
    if (method === 'getWebhookInfo') return apiResponse({url:''});
    if (method === 'getUpdates') { if (polled) return suspended(init.signal); polled = true; return apiResponse([{update_id:1,message:incoming}]); }
    if (method === 'getFile') return apiResponse(options.file ?? {file_id:body.file_id,file_path:'photos/file_12.jpg',file_size:4});
    if (['sendPhoto', 'sendVoice', 'sendDocument'].includes(method)) return options.send ? options.send(method, body, init) : apiResponse({message_id:99,chat:{id:123}});
    throw new Error('Unexpected synthetic endpoint');
  };
  const provider = createProvider({credentials, state:{get:key=>values.get(key),set:(key,value)=>values.set(key,value)}, onMessage:async message=>seen.push(message), fetch});
  t.after(() => provider.stop());
  await provider.start(); await until(() => seen.length === 1);
  return {provider, message:seen[0], calls};
}

test('declares only implemented media types and reads matching private file references', async t => {
  const fx = await fixture(t);
  assert.deepEqual(channel.media,{read:['image','audio','file'],reply:['image','audio','file']});
  assert.equal(channel.maxMediaReplyText,1024);
  assert.deepEqual(fx.message.attachments.map(a=>a.kind),['audio','file','image']);
  assert.equal(JSON.stringify(fx.message.attachments).includes('file_id'),false);
  assert.deepEqual(fx.message.replyContext.attachments.map(r=>r.fileId),['voice-file','document-file','large']);
  for (let i = 0; i < 3; i++) assert.deepEqual((await fx.provider.readAttachment({message:fx.message,attachmentIndex:i})).data,Buffer.from('DATA'));
  assert.deepEqual(fx.calls.filter(c=>c.url.endsWith('/getFile')).map(c=>JSON.parse(c.init.body).file_id),['voice-file','document-file','large']);
  for (const call of fx.calls.filter(c=>c.url.includes('/file/'))) assert.equal(call.init.headers,undefined);
});

test('uploads bytes as multipart to the original private chat with one reply per call', async t => {
  const fx = await fixture(t);
  for (const [type,mimeType,field,method] of [['image','image/png','photo','sendPhoto'],['audio','audio/ogg','voice','sendVoice'],['file','application/pdf','document','sendDocument']]) {
    const result = await fx.provider.sendMediaReply({message:fx.message,media:{type,mimeType,name:'example.bin',data:Buffer.from('DATA')},text:'A caption'});
    assert.deepEqual(result,{providerMessageId:'99'});
    const call = fx.calls.find(c=>c.url.endsWith('/'+method));
    assert.ok(call.init.body instanceof FormData);
    assert.equal(call.init.headers,undefined);
    assert.equal(call.init.body.get('chat_id'),'123');
    assert.equal(call.init.body.get('caption'),'A caption');
    assert.equal(call.init.body.get('parse_mode'),null);
    assert.equal(JSON.parse(call.init.body.get('reply_parameters')).message_id,1);
    assert.equal(await call.init.body.get(field).text(),'DATA');
  }
  assert.equal(fx.calls.filter(c=>/\/send(?:Photo|Voice|Document)$/.test(c.url)).length,3);
});

test('rejects altered bindings, invalid index and oversized declared files before network IO', async t => {
  const fx = await fixture(t);
  const count = fx.calls.length;
  await assert.rejects(fx.provider.readAttachment({message:{...fx.message,senderId:'999'},attachmentIndex:0}),/binding/);
  await assert.rejects(fx.provider.readAttachment({message:fx.message,attachmentIndex:-1}),/unavailable/);
  await assert.rejects(fx.provider.readAttachment({message:fx.message,attachmentIndex:10}),/unavailable/);
  const oversized = structuredClone(fx.message); oversized.replyContext.attachments[0].size=8*1024*1024+1;
  await assert.rejects(fx.provider.readAttachment({message:oversized,attachmentIndex:0}),/8 MiB/);
  assert.equal(fx.calls.length,count);
});

test('getFile cannot escape the official per-bot file path', async t => {
  for (const file_path of ['../secret','photos/../secret','/photos/a.jpg','https://evil.invalid/a','photos/x?token=foo','photos/%2e%2e/a','photos/x\\a','photos//x']) {
    const fx = await fixture(t,{file:{file_id:'voice-file',file_path,file_size:4}});
    await assert.rejects(fx.provider.readAttachment({message:fx.message,attachmentIndex:0}),/Telegram request failed/);
    assert.equal(fx.calls.filter(c=>c.url.includes('/file/')).length,0);
    await fx.provider.stop();
  }
});

test('rejects redirects, changed final URL and bodies beyond the 8 MiB limit', async t => {
  for (const download of [
    () => { const r=new Response('DATA');Object.defineProperty(r,'redirected',{value:true});return r; },
    () => { const r=new Response('DATA');Object.defineProperty(r,'url',{value:'https://evil.invalid/a'});return r; },
    () => new Response('DATA',{headers:{'content-length':String(8*1024*1024+1)}}),
    () => new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(8*1024*1024));c.enqueue(new Uint8Array(1));c.close();}}))
  ]) {
    const fx=await fixture(t,{download});
    await assert.rejects(fx.provider.readAttachment({message:fx.message,attachmentIndex:0}),/Telegram request failed/);
    await fx.provider.stop();
  }
});

test('synchronous validation rejects unsafe uploads and oversized captions before queueing', async t => {
  const fx=await fixture(t); const base={type:'file',mimeType:'application/pdf',name:'a.pdf',data:Buffer.from('A')};
  for (const media of [{...base,data:Buffer.alloc(0)},{...base,data:Buffer.alloc(8*1024*1024+1)},{...base,data:'https://evil.invalid/file'},{...base,name:'../x'},{...base,name:'a\r\nb'},{...base,mimeType:'a/b\r\nInjected: value'},{...base,type:'image'},{...base,type:'audio',mimeType:'audio/wav'}]) assert.throws(()=>fx.provider.validateMediaReply({media}));
  assert.throws(()=>fx.provider.validateMediaReply({media:base,text:'x'.repeat(1025)}),/1024/);
  assert.doesNotThrow(()=>fx.provider.validateMediaReply({media:base,text:''}));
});

test('uncertain media POST is never retried and stop drains the upload', async t => {
  let sending=false;
  const fx=await fixture(t,{send:(_method,_body,init)=>{sending=true;return suspended(init.signal);}});
  const pending=assert.rejects(fx.provider.sendMediaReply({message:fx.message,media:{type:'audio',mimeType:'audio/ogg',name:'voice.ogg',data:Buffer.from('A')}}),/Telegram request failed/);
  await until(()=>sending); await fx.provider.stop(); await pending;
  assert.equal(fx.calls.filter(c=>c.url.endsWith('/sendVoice')).length,1);
});

test('revoked authorization blocks media and text before their final provider request',async t=>{
  const fx=await fixture(t),before=fx.calls.length,authorize=()=>{throw new Error('fixture revoked');};
  await assert.rejects(fx.provider.sendMediaReply({message:fx.message,media:{type:'file',mimeType:'application/pdf',name:'a.pdf',data:Buffer.from('A')},authorize}),/revoked/);
  await assert.rejects(fx.provider.sendReply({message:fx.message,text:'A reply',authorize}),/revoked/);
  assert.equal(fx.calls.length,before);
});
