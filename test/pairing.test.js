import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createOwnerPairing} from '../src/pairing.js';
import {runPairOwner} from '../scripts/pair-owner.js';

const botToken='12345:abcdefghijklmnopqrstuvwx',nonce='a'.repeat(32),now=1800000000000;
const command=`/start db_${nonce}`;
const message={message_id:77,text:command,date:now/1000,from:{id:123,is_bot:false},chat:{id:123,type:'private'}};
function fixture({updates=[{update_id:1,message}],webhook='',status=200}={}){
  const calls=[];
  const fetch=async(url,init)=>{
    const method=url.split('/').at(-1),body=JSON.parse(init.body);calls.push({method,body});
    assert.equal(new URL(url).origin,'https://api.telegram.org');assert.equal(init.redirect,'error');
    const result=method==='getMe'?{id:12345,is_bot:true}:method==='getWebhookInfo'?{url:webhook}:updates;
    return new Response(JSON.stringify(status===200?{ok:true,result}:{ok:false,error_code:status,description:'secret test response'}),{status});
  };
  return {fetch,calls};
}

test('pairing requires an explicit stopped-consumer confirmation before any network request',async()=>{
  await assert.rejects(createOwnerPairing({botToken,fetch:()=>assert.fail('must not fetch')}),e=>e.reason==='confirm_stopped_required');
});

test('binds only the exact fresh private nonce without acknowledging or sending messages',async()=>{
  const fx=fixture();const pairing=await createOwnerPairing({botToken,confirmStopped:true,...fx,clock:()=>now,nonce:()=>nonce});
  assert.equal(pairing.command,command);assert.equal(pairing.expiresAt,now+120000);
  assert.deepEqual(await pairing.waitForOwner(),{botToken,ownerId:'123',conversationId:'123'});
  assert.deepEqual(fx.calls.map(c=>c.method),['getMe','getWebhookInfo','getUpdates']);
  assert.equal(fx.calls.at(-1).body.offset,undefined);
  await assert.rejects(pairing.waitForOwner(),e=>e.reason==='pairing_already_waited');
});

test('never adopts the first sender, forwarded commands, bots, groups or stale commands',async()=>{
  const bad=[{...message,text:'/start'},{...message,text:'/start db_'+'b'.repeat(32)},{...message,forward_origin:{type:'user'}},{...message,via_bot:{id:55}},{...message,from:{id:123,is_bot:true}},{...message,chat:{id:123,type:'group'}},{...message,date:now/1000-300},{...message,chat:{id:999,type:'private'}}];
  const fx=fixture({updates:bad.map((message,i)=>({update_id:i+1,message}))});
  let current=now;
  const fetch=async(...args)=>{const result=await fx.fetch(...args);if(args[0].endsWith('/getUpdates'))current=now+120001;return result;};
  const pairing=await createOwnerPairing({botToken,confirmStopped:true,fetch,clock:()=>current,nonce:()=>nonce});
  await assert.rejects(pairing.waitForOwner(),e=>e.reason==='pairing_expired');
});

test('preserves existing webhook and pending backlog instead of deleting or advancing updates',async()=>{
  const webhook=fixture({webhook:'https://example.invalid/private'});
  await assert.rejects(createOwnerPairing({botToken,confirmStopped:true,...webhook}),e=>e.reason==='existing_webhook_preserved');
  assert.deepEqual(webhook.calls.map(c=>c.method),['getMe','getWebhookInfo']);
  const pending=fixture({updates:Array.from({length:100},(_,i)=>({update_id:i,message:{...message,text:'ordinary message'}}))});
  const pairing=await createOwnerPairing({botToken,confirmStopped:true,...pending,clock:()=>now,nonce:()=>nonce});
  await assert.rejects(pairing.waitForOwner(),e=>e.reason==='pending_updates_require_review');
  assert.equal(pending.calls.at(-1).body.offset,undefined);
});

test('rejects ambiguous nonce messages and redacts authentication/conflict failures',async()=>{
  const fx=fixture({updates:[{update_id:1,message},{update_id:2,message:{...message,message_id:78}}]});
  const pairing=await createOwnerPairing({botToken,confirmStopped:true,...fx,clock:()=>now,nonce:()=>nonce});
  await assert.rejects(pairing.waitForOwner(),e=>e.reason==='ambiguous_pairing_messages');
  for(const status of [401,409])await assert.rejects(createOwnerPairing({botToken,confirmStopped:true,...fixture({status})}),error=>!error.message.includes('secret')&&!error.message.includes(botToken)&&['bot_token_rejected','another_consumer_or_webhook'].includes(error.reason));
});

const paths={token:path.resolve('synthetic-private','bot-token.txt'),credentials:path.resolve('synthetic-private','credentials.json')};
const args=['--token-file',paths.token,'--credentials-file',paths.credentials,'--confirm-stopped','--confirm-private-storage'];
function cliFixture(){
  const output=[],writes=[];
  return {output:value=>output.push(value),outputLines:output,writes,read:()=>Buffer.from(botToken),write:(file,value)=>writes.push({file,value}),exists:()=>false,assertDestination:()=>{},pairing:async()=>({command,expiresAt:Date.now()+120000,waitForOwner:async()=>({botToken,ownerId:'123',conversationId:'123'})})};
}
test('operator CLI refuses missing confirmation, existing credentials and unsafe paths before polling',async()=>{
  const fx=cliFixture();fx.pairing=async()=>assert.fail('must not poll');
  await assert.rejects(runPairOwner(args.filter(v=>v!=='--confirm-stopped'),fx),/Confirm/);
  await assert.rejects(runPairOwner(args.filter(v=>v!=='--confirm-private-storage'),fx),/Confirm/);
  await assert.rejects(runPairOwner(args,{...fx,exists:()=>true}),/preserved/);
  await assert.rejects(runPairOwner(['--token-file','relative','--credentials-file',paths.credentials,'--confirm-stopped','--confirm-private-storage'],fx),/absolute/);
  assert.equal(fx.writes.length,0);
});

test('operator saves verified credentials once; output contains no token or identity values',async()=>{
  const fx=cliFixture();const result=await runPairOwner(args,fx);
  assert.deepEqual(result,{paired:true,credentialsSaved:true});assert.equal(fx.writes.length,1);assert.equal(fx.writes[0].file,paths.credentials);
  assert.deepEqual(fx.writes[0].value,{botToken,ownerId:'123',conversationId:'123'});
  assert.ok(fx.outputLines.includes(command));assert.equal(fx.outputLines.join('\n').includes(botToken),false);assert.equal(fx.outputLines.join('\n').includes('ownerId'),false);
});

test('operator preserves a racing credentials file and refuses an expired proof',async()=>{
  const fx=cliFixture();let checks=0;
  await assert.rejects(runPairOwner(args,{...fx,exists:()=>++checks>1}),/preserved/);
  await assert.rejects(runPairOwner(args,{...fx,pairing:async()=>({command,expiresAt:Date.now()-1,waitForOwner:async()=>({botToken,ownerId:'123',conversationId:'123'})})}),/expired/);
  assert.equal(fx.writes.length,0);
});
