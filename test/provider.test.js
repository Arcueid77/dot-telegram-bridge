import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createProvider} from '../src/provider.js';

const credentials = {botToken:'12345:abcdefghijklmnopqrstuvwx', ownerId:'123', conversationId:'123'};
function memory() { const data = new Map(); return {get:k => data.get(k), set:(k,v) => data.set(k,structuredClone(v)), delete:k => data.delete(k)}; }
const response = (result, status = 200) => new Response(JSON.stringify({ok:status === 200, result}), {status});
const update = (update_id, text = 'hello') => ({update_id, message:{message_id:update_id, date:1720000000, from:{id:123,is_bot:false}, chat:{id:123,type:'private'}, text}});
async function until(condition) { for (let i=0;i<500;i++) { if (condition()) return; await delay(5); } assert.fail('condition timed out'); }
function suspended(signal) { return new Promise((_, reject) => { if (signal.aborted) reject(new Error('abort')); else signal.addEventListener('abort', () => reject(new Error('abort')), {once:true}); }); }
function api(poll, send = () => response({message_id:88,chat:{id:123}}), webhook = '') {
  const calls = [];
  const fetch = async (url, init) => {
    assert.equal(new URL(url).origin, 'https://api.telegram.org');
    assert.equal(init.redirect, 'error');
    const method = url.split('/').at(-1);
    const body = JSON.parse(init.body);
    calls.push({method,body});
    if (method === 'getMe') return response({id:12345,is_bot:true});
    if (method === 'getWebhookInfo') return response({url:webhook});
    if (method === 'getUpdates') return poll(body, init.signal);
    if (method === 'sendMessage') return send(body, init.signal);
    throw new Error('unexpected endpoint');
  };
  return {fetch,calls};
}

test('long polling returns from start and commits offset only after durable ingestion', async t => {
  const state = memory();
  let release;
  let entered = false;
  const gate = new Promise(resolve => { release=resolve; });
  const seen = [];
  let polls = 0;
  const fixture = api((body, signal) => ++polls === 1 ? response([update(5),update(6)]) : suspended(signal));
  const provider = createProvider({credentials,state,fetch:fixture.fetch,onMessage:async message => { seen.push(message); entered=true; if (message.id === '5') await gate; }});
  t.after(() => provider.stop());
  await provider.start();
  await until(() => entered);
  assert.equal(state.get('offset'), undefined);
  assert.equal(seen.length, 1);
  release();
  await until(() => polls === 2);
  assert.equal(state.get('offset'), 7);
  assert.equal(fixture.calls.findLast(c=>c.method==='getUpdates').body.offset, 7);
  assert.deepEqual(fixture.calls.find(c=>c.method==='getUpdates').body.allowed_updates, ['message']);
  assert.equal(seen.length, 2);
  await provider.stop();
  assert.deepEqual(provider.status(), {connected:false,running:false,blocked:false});
});

test('failed ingestion is redelivered without acknowledging it or later updates', async t => {
  const state = memory();
  state.set('offset',5);
  let polls = 0;
  let attempts = 0;
  const fixture = api((body,signal) => ++polls <= 2 ? response([update(5),update(6)]) : suspended(signal));
  const provider = createProvider({credentials,state,fetch:fixture.fetch,onMessage:async () => { if (++attempts === 1) throw new Error('synthetic failure'); }});
  t.after(() => provider.stop());
  await provider.start();
  await until(() => attempts === 1);
  assert.equal(state.get('offset'),5);
  await until(() => polls === 3);
  assert.equal(fixture.calls.filter(c=>c.method==='getUpdates')[1].body.offset,5);
  assert.equal(attempts,3);
  assert.equal(state.get('offset'),7);
});

test('filters other users, groups, bot messages and service events; retains attachment metadata only', async t => {
  const updates = [update(1),update(2),update(3),update(4),update(5),update(6)];
  updates[0].message.from.id=456;
  updates[1].message.chat.type='group';
  updates[2].message.from.is_bot=true;
  delete updates[3].message.text;
  updates[4].message.voice={file_id:'never-exposed',mime_type:'audio/ogg'};
  delete updates[4].message.text;
  const state = memory();
  let polls=0;
  const seen=[];
  const fixture=api((body,signal)=>++polls===1?response(updates):suspended(signal));
  const provider=createProvider({credentials,state,fetch:fixture.fetch,onMessage:async m=>seen.push(m)});
  t.after(()=>provider.stop());
  await provider.start();
  await until(()=>polls===2);
  assert.equal(state.get('offset'),7);
  assert.deepEqual(seen.map(m=>m.id),['5','6']);
  assert.deepEqual(seen[0].attachments,[{kind:'audio',mimeType:'audio/ogg'}]);
  assert.equal(JSON.stringify(seen).includes('never-exposed'),false);
});

test('reply is bound to stored chat, sends plain text once and rejects oversized or altered binding', async t => {
  let polls=0;
  let message;
  const fixture=api((body,signal)=>++polls===1?response([update(1)]):suspended(signal));
  const provider=createProvider({credentials,state:memory(),fetch:fixture.fetch,onMessage:async m=>{message=m;}});
  t.after(()=>provider.stop());
  await provider.start();
  await until(()=>message);
  assert.deepEqual(await provider.sendReply({message,text:'answer',idempotencyKey:'stable'}),{providerMessageId:'88'});
  const sent=fixture.calls.find(c=>c.method==='sendMessage').body;
  assert.equal(sent.chat_id,'123');
  assert.equal(sent.parse_mode,undefined);
  assert.equal(sent.reply_parameters.message_id,1);
  await assert.rejects(provider.sendReply({message:{...message,conversationId:'999'},text:'no'}),/binding/);
  await assert.rejects(provider.sendReply({message,text:'x'.repeat(4097)}),/4096/);
  assert.equal(fixture.calls.filter(c=>c.method==='sendMessage').length,1);
});

test('uncertain send is never retried and stop aborts/drains a pending send', async t => {
  let message;
  let polls=0;
  let sending=false;
  const fixture=api((body,signal)=>++polls===1?response([update(1)]):suspended(signal),async (body,signal)=>{sending=true;return suspended(signal);});
  const provider=createProvider({credentials,state:memory(),fetch:fixture.fetch,onMessage:async m=>{message=m;}});
  t.after(()=>provider.stop());
  await provider.start();
  await until(()=>message);
  const send=provider.sendReply({message,text:'answer'});
  const rejected=assert.rejects(send,/Telegram request failed/);
  await until(()=>sending);
  await provider.stop();
  await rejected;
  assert.equal(fixture.calls.filter(c=>c.method==='sendMessage').length,1);
});

test('existing webhook blocks initialization without deleting webhook or dropping updates', async () => {
  const fixture=api(()=>assert.fail('must not poll'),undefined,'https://example.invalid/private');
  const provider=createProvider({credentials,state:memory(),fetch:fixture.fetch,onMessage:async()=>{}});
  await assert.rejects(provider.start(),/already has a webhook/);
  await provider.stop();
  assert.deepEqual(fixture.calls.map(c=>c.method),['getMe','getWebhookInfo']);
});

test('fatal polling conflict stops recovery and raw errors are not exposed', async t => {
  const fixture=api(()=>new Response(JSON.stringify({ok:false,error_code:409,description:'sensitive detail'}),{status:409}));
  const provider=createProvider({credentials,state:memory(),fetch:fixture.fetch,onMessage:async()=>{}});
  t.after(()=>provider.stop());
  await provider.start();
  await until(()=>provider.status().blocked);
  assert.equal(provider.status().running,false);
  assert.equal(fixture.calls.filter(c=>c.method==='getUpdates').length,1);
  assert.equal(JSON.stringify(provider.status()).includes('sensitive'),false);
});

test('rejects unsafe credentials and bounded response failures before polling', async () => {
  assert.throws(()=>createProvider({credentials:{...credentials,botToken:'token/redirect'},state:memory()}),/credentials/);
  const provider=createProvider({credentials,state:memory(),fetch:async()=>new Response('x'.repeat(2*1024*1024+1)),onMessage:async()=>{}});
  await assert.rejects(provider.start(),/initialization failed/);
  await provider.stop();
});

test('changing bot on the same persistent cursor is rejected before polling', async () => {
  const state=memory();state.set('botId','999');state.set('offset',77);
  const fixture=api(()=>assert.fail('must not poll'));
  const provider=createProvider({credentials,state,fetch:fixture.fetch,onMessage:async()=>{}});
  await assert.rejects(provider.start(),/initialization failed/);
  await provider.stop();
  assert.equal(state.get('offset'),77);
  assert.equal(state.get('botId'),'999');
});

test('invalid optional metadata is omitted and unsupported raw text cannot poison the polling cursor', async t => {
  const updates=[update(1),update(2,'text\u0000control'),update(3,'text\ud800surrogate'),update(4),update(5,'中文\n\t消息😀'),update(6),update(7)];
  updates[0].message.document={file_name:'bad\u0000name',mime_type:'bad\u007fmime'};
  delete updates[3].message.text;
  updates[3].message.caption='bad\u000bcaption';
  updates[3].message.voice={mime_type:'audio/ogg'};
  updates[5].message.document={file_name:'a'.repeat(254)+'😀suffix',mime_type:'m'.repeat(126)+'😀suffix'};
  updates[6].message.document={file_name:'',mime_type:'\udfff'};
  const state=memory();const seen=[];let polls=0;
  const fixture=api((body,signal)=>++polls===1?response(updates):suspended(signal));
  const provider=createProvider({credentials,state,fetch:fixture.fetch,onMessage:async message=>seen.push(message)});
  t.after(()=>provider.stop());
  await provider.start();await until(()=>polls===2);
  assert.equal(state.get('offset'),8);
  assert.deepEqual(seen.map(message=>message.id),['1','5','6','7']);
  assert.deepEqual(seen[0].attachments,[{kind:'file'}]);
  assert.equal(seen[1].text,'中文\n\t消息😀');
  assert.deepEqual(seen[2].attachments,[{kind:'file',name:'a'.repeat(254),mimeType:'m'.repeat(126)}]);
  assert.deepEqual(seen[3].attachments,[{kind:'file'}]);
});
