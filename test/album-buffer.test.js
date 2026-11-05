import test from 'node:test';
import assert from 'node:assert/strict';
import { AlbumBuffer } from '../src/album-buffer.js';

function fixture() {
  const values = new Map(),
    messages = [];
  let now = 1000;
  const state = {
    get: (key) => values.has(key) ? structuredClone(values.get(key)) : undefined,
    set: (key, value) => values.set(key, structuredClone(value)),
  };
  const options = {
    state,
    onMessage: async (message) => {
      messages.push(message);
    },
    authorize: (message) => message.senderId === 'owner' && message.conversationId === 'chat',
    clock: () => now,
  };
  return {
    options,
    messages,
    state,
    time: (value) => {
      now = value;
    },
  };
}
const part = (id, caption = '') => ({
  id: String(id),
  senderId: 'owner',
  conversationId: 'chat',
  text: caption,
  attachments: [{ kind: 'image' }],
  replyContext: { messageId: id, attachments: [{ fileId: 'synthetic-' + id }] },
});

test('a failed durable album write is retried instead of acknowledging an in-memory duplicate', async () => {
  const f=fixture(),save=f.state.set;
  let fail=false;
  f.state.set=(key,value)=>{
    if(fail){fail=false;throw Error('synthetic storage failure');}
    return save(key,value);
  };
  const buffer=new AlbumBuffer(f.options);
  await buffer.add(part(1),'group');fail=true;
  await assert.rejects(buffer.add(part(2),'group'));
  assert.equal(buffer.pending[0].messages.length,1);
  await buffer.add(part(2),'group');f.time(2000);await buffer.flushReady();
  assert.equal(f.messages.length,1);assert.equal(f.messages[0].attachments.length,2);
});

test('Telegram media groups combine images and captions after a quiet window and retain attachment order', async () => {
  const f = fixture(),
    buffer = new AlbumBuffer(f.options);
  await buffer.add(part(11, 'caption'), 'group');
  await buffer.add(part(12), 'group');
  await buffer.flushReady();
  assert.equal(f.messages.length, 0);
  f.time(2000);
  await buffer.flushReady();
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].id, '11');
  assert.equal(f.messages[0].text, 'caption');
  assert.equal(f.messages[0].attachments.length, 2);
  assert.deepEqual(
    f.messages[0].replyContext.attachments.map((v) => v.fileId),
    ['synthetic-11', 'synthetic-12'],
  );
});

test('a persisted album survives restart after the polling offset advanced and identical parts deduplicate', async () => {
  const f = fixture(),
    first = new AlbumBuffer(f.options);
  await first.add(part(21, 'saved'), 'group');
  await first.add(part(21, 'saved'), 'group');
  f.state.set('offset', 42);
  const reopened = new AlbumBuffer(f.options);
  await reopened.add(part(22), 'group');
  f.time(2000);
  await reopened.flushReady();
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].attachments.length, 2);
});

test('album authorization stays per sender/chat/topic and a failed durable ingest retains pending parts', async () => {
  const f = fixture(),
    buffer = new AlbumBuffer({
      ...f.options,
      onMessage: async () => {
        throw Error('storage unavailable');
      },
    });
  await buffer.add(part(31), 'same-group');
  f.time(2000);
  await assert.rejects(buffer.flushReady());
  assert.equal(f.state.get('albumBuffer').pending.length, 1);
  const recovered = new AlbumBuffer(f.options);
  await recovered.add({ ...part(32), senderId: 'other' }, 'same-group');
  await recovered.flushReady();
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].attachments.length, 1);
});
