import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createProvider} from '../src/provider.js';
import {channel} from '../src/channel.js';
import {interactionPolicy} from '@dot-bridge/core/channels/experience-policy.js';

const credentials={botToken:'999:abcdefghijklmnopqrstuvwx',ownerId:'111',conversationId:'111'};
const memory=()=>{const map=new Map();return {get:key=>map.get(key),set:(key,value)=>map.set(key,structuredClone(value)),delete:key=>map.delete(key)};};
const response=value=>new Response(JSON.stringify({ok:true,result:value}));
const pending=signal=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));
const update=(id,other={})=>({update_id:id,message:{message_id:id,from:{id:111,is_bot:false},chat:{id:111,type:'private'},text:'hello',...other}});
async function fixture(t,updates,settings={},fail){
  const calls=[],seen=[];let polls=0,number=100;
  const provider=createProvider({credentials,interaction:interactionPolicy(settings,channel),state:memory(),onMessage:async value=>seen.push(value),fetch:async(url,input)=>{
    const method=url.split('/').at(-1),body=JSON.parse(input.body);calls.push({method,body});
    if(method==='getMe')return response({id:999,is_bot:true,username:'FixtureBot'});
    if(method==='getWebhookInfo')return response({url:''});
    if(method==='getUpdates')return ++polls===1?response(updates):pending(input.signal);
    if(fail?.(method,body))throw Error('private raw SDK error');
    if(['setMessageReaction','sendChatAction','deleteMessage'].includes(method))return response(true);
    if(['sendMessage','editMessageText'].includes(method))return response({message_id:body.message_id??number++,chat:{id:Number(body.chat_id)}});
    throw Error('Unexpected fixture API');
  }});
  t.after(()=>provider.stop());await provider.start();for(let index=0;polls<2&&index<100;index++)await delay(5);assert.equal(polls,2);return {provider,calls,seen};
}

test('real mentions, forum topics and quoted context route only configured groups back to their original topic',async t=>{
  const base={chat:{id:-1001,type:'supergroup'},from:{id:222,is_bot:false},message_thread_id:42};
  const f=await fixture(t,[update(1,{...base,text:'@FixtureBot plain spoof'}),update(2,{...base,text:'@FixtureBot actual',entities:[{type:'mention',offset:0,length:11}],reply_to_message:{message_id:1,chat:{id:-1001},from:{id:333},text:'quoted group context'}}),update(3,{...base,chat:{id:-9999,type:'supergroup'},text:'@FixtureBot no',entities:[{type:'mention',offset:0,length:11}]})],{groups:[{conversation_id:'-1001',members:'all'}]});
  assert.equal(f.seen.length,1);assert.equal(f.seen[0].conversationId,'-1001');assert.equal(f.seen[0].threadId,'42');assert.equal(f.seen[0].quote.text,'quoted group context');
  await f.provider.sendReply({message:f.seen[0],text:'**group answer**',idempotencyKey:'group',authorize:()=>{}});
  const body=f.calls.find(value=>value.method==='sendMessage').body;assert.equal(body.chat_id,'-1001');assert.equal(body.message_thread_id,42);assert.equal(body.reply_parameters.message_id,2);assert.equal(body.text,'<b>group answer</b>');
});
test('allowlisted group members and keyword/all triggers do not widen private-message ownership',async t=>{
  const base={chat:{id:-1001,type:'group'},text:'please respond'};
  const f=await fixture(t,[update(1,{...base,from:{id:222,is_bot:false}}),update(2,{...base,from:{id:333,is_bot:false}}),update(3,{from:{id:222,is_bot:false}})],{groups:[{conversation_id:'-1001',members:'allowlist',allow_from:['222'],mention:false,auto_reply:'keywords',keywords:['please']}]});
  assert.deepEqual(f.seen.map(value=>value.id),['1']);
});
test('native typing, reactions and progress operate on the original private message and edit one acknowledged reply',async t=>{
  const f=await fixture(t,[update(1)]),message=f.seen[0];
  await f.provider.setFeedback({message,active:true,authorize:()=>{}});await f.provider.setTyping({message,active:true,authorize:()=>{}});
  const reference=await f.provider.sendProgress({message,text:'**first**',idempotencyKey:'progress',authorize:()=>{}});
  await f.provider.sendProgress({message,text:'**first and final**',reference,final:true,idempotencyKey:'final',authorize:()=>{}});
  await f.provider.setFeedback({message,active:false,authorize:()=>{}});
  assert.equal(f.calls.filter(value=>value.method==='sendMessage').length,1);assert.equal(f.calls.filter(value=>value.method==='editMessageText').length,1);
  assert.deepEqual(f.calls.find(value=>value.method==='setMessageReaction').body.reaction,[{type:'emoji',emoji:'👀'}]);
  assert.deepEqual(f.calls.filter(value=>value.method==='setMessageReaction').at(-1).body.reaction,[]);
  const before=f.calls.length;await assert.rejects(f.provider.sendProgress({message,text:'no',reference:{...reference,conversationId:'222'},authorize:()=>{}}));assert.equal(f.calls.length,before);
});
test('generated long HTML plans are bounded and revoked progress never reaches a provider mutation',async t=>{
  const f=await fixture(t,[update(1)]),message=f.seen[0],parts=f.provider.planTextReply('**'+('long 🙂 '.repeat(1500)).trimEnd()+'**');
  assert.ok(parts.length>2);for(const part of parts){assert.equal(part.format,'html');assert.ok(part.text.isWellFormed());}
  const before=f.calls.length;await assert.rejects(f.provider.setTyping({message,active:true,authorize:()=>{throw Error('revoked');}}),/revoked/);assert.equal(f.calls.length,before);
});
test('an ambiguous progress creation is one POST and does not retry or expose SDK details',async t=>{
  const f=await fixture(t,[update(1)],{},method=>method==='sendMessage');
  await assert.rejects(f.provider.sendProgress({message:f.seen[0],text:'partial',idempotencyKey:'uncertain',authorize:()=>{}}),error=>!error.message.includes('private raw'));
  assert.equal(f.calls.filter(value=>value.method==='sendMessage').length,1);
});
