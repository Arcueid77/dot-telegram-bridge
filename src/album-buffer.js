import { createHash } from 'node:crypto';

const keyFor = (message, group) =>
  createHash('sha256')
    .update(
      JSON.stringify([message.senderId, message.conversationId, message.threadId ?? null, group]),
    )
    .digest('hex');

export class AlbumBuffer {
  constructor({ state, onMessage, authorize, clock = Date.now, quietMs = 800 }) {
    Object.assign(this, { state, onMessage, authorize, clock, quietMs });
    const saved = state.get('albumBuffer');
    if (
      saved !== undefined &&
      (saved.version !== 1 || !Array.isArray(saved.pending) || !Array.isArray(saved.completed))
    )
      throw Error('Telegram album state is invalid');
    this.pending = saved?.pending ?? [];
    this.completed = saved?.completed ?? [];
  }
  save() {
    const value = { version: 1, pending: this.pending, completed: this.completed.slice(-256) };
    if (JSON.stringify(value).length > 110000) throw Error('Telegram album state capacity reached');
    try {
      this.state.set('albumBuffer', value);
    } catch (error) {
      const previous = this.state.get('albumBuffer');
      this.pending = previous?.pending ?? [];
      this.completed = previous?.completed ?? [];
      throw error;
    }
  }
  hasPending() {
    return this.pending.length > 0;
  }
  combined(entry) {
    const messages = [...entry.messages].sort((a, b) => Number(a.id) - Number(b.id));
    const first = messages[0];
    const captions = [...new Set(messages.map((message) => message.text).filter(Boolean))];
    return {
      ...first,
      text: captions.join('\n'),
      botMentioned: messages.some((message) => message.botMentioned),
      attachments: messages.flatMap((message) => message.attachments),
      replyContext: {
        ...first.replyContext,
        attachments: messages.flatMap((message) => message.replyContext.attachments),
        albumGroup: entry.key,
      },
    };
  }
  async flush(entry) {
    const combined = this.combined(entry);
    const admitted = this.authorize(combined) === true;
    if (admitted) await this.onMessage(combined);
    this.pending = this.pending.filter((item) => item !== entry);
    this.completed.push({ key: entry.key, admitted });
    this.completed = this.completed.slice(-256);
    this.save();
  }
  async add(message, group) {
    const key = keyFor(message, group);
    const complete = this.completed.find((item) => item.key === key);
    if (complete) {
      const continuation = {
        ...message,
        botMentioned: complete.admitted || message.botMentioned,
        text: message.text || '[相册续图]',
      };
      if (this.authorize(continuation)) await this.onMessage(continuation);
      return;
    }
    let entry = this.pending.find((item) => item.key === key);
    if (entry?.messages.some((item) => item.id === message.id)) return;
    const total = this.pending.reduce((sum, item) => sum + item.messages.length, 0);
    if (
      this.pending.length >= 20 ||
      total >= 100 ||
      JSON.stringify(this.pending).length + JSON.stringify(message).length > 95000
    ) {
      if (this.pending.length) await this.flush(this.pending[0]);
      entry = this.pending.find((item) => item.key === key);
    }
    if (
      entry &&
      (entry.messages.reduce((sum, item) => sum + item.attachments.length, 0) +
        message.attachments.length >
        10 ||
        entry.messages.reduce((sum, item) => sum + item.text.length, 0) + message.text.length >
          20000)
    ) {
      await this.flush(entry);
      await this.add(message, group);
      return;
    }
    if (!entry) {
      entry = { key, messages: [], lastAt: this.clock() };
      this.pending.push(entry);
    }
    entry.messages.push(message);
    entry.lastAt = this.clock();
    this.save();
  }
  async flushReady() {
    for (const entry of [...this.pending])
      if (this.clock() - entry.lastAt >= this.quietMs || this.clock() < entry.lastAt)
        await this.flush(entry);
  }
}
