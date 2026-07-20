import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AGENT_MAIL_DIR,
  createAgentMailStore,
  formatAgentMailForRuntime,
  resolveAgentMailDir,
} from './index.js';

describe('agent mail', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mail-'));
    dbPath = path.join(tmpDir, 'agent_mail.db');
  });

  afterEach(() => {
    delete process.env.AGENT_MAIL_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves AGENT_MAIL_DIR at call time', () => {
    process.env.AGENT_MAIL_DIR = tmpDir;

    expect(resolveAgentMailDir()).toBe(tmpDir);
  });

  it('sends, acknowledges, replies to, and closes agent mail', () => {
    const store = createAgentMailStore(dbPath);
    const message = store.send({
      fromAgent: 'eli',
      toAgent: 'marcus',
      type: 'question',
      subject: 'Need API owner',
      bodyMd: 'Who owns the next API cut?',
      relatedProject: 'mhc',
      requiresResponse: true,
    });

    expect(store.listInbox({ agent: 'marcus', status: 'new' })).toHaveLength(1);

    const acked = store.ackMessage('marcus', message.id);
    expect(acked.status).toBe('acked');

    const reply = store.reply({
      actorAgent: 'marcus',
      messageId: message.id,
      bodyMd: 'Wilber owns it.',
    });
    expect(reply.toAgent).toBe('eli');
    expect(reply.correlationId).toBe(message.correlationId);

    const closed = store.closeMessage('marcus', message.id);
    expect(closed.status).toBe('closed');
    expect(store.getThread(message.correlationId)).toHaveLength(2);
    expect(store.listEvents(message.id).map((event) => event.eventType)).toContain('replied');

    store.close();
  });

  it('formats agent mail for runtime injection', () => {
    const prompt = formatAgentMailForRuntime({
      id: 'msg_123',
      correlationId: 'corr_123',
      fromAgent: 'eli',
      toAgent: 'marcus',
      type: 'question',
      priority: 'high',
      subject: 'Need API owner',
      bodyMd: 'Who owns the next API cut?',
      relatedProject: 'mhc',
      requiresResponse: true,
      status: 'new',
      createdAt: '2026-04-24T00:00:00.000Z',
      ackedAt: null,
      closedAt: null,
    });

    expect(prompt).toContain('[Agent Mail]');
    expect(prompt).toContain('type=question');
    expect(prompt).toContain('project: mhc');
    expect(prompt).toContain('Who owns the next API cut?');
  });
});

describe('agent mail hardening', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mail-'));
    dbPath = path.join(tmpDir, 'agent_mail.db');
  });

  afterEach(() => {
    delete process.env.AGENT_MAIL_DIR;
    delete process.env.AGENT_MAIL_ALLOW_DEFAULT;
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // C1: unset AGENT_MAIL_DIR must not silently divert to a private default DB.
  it('throws when AGENT_MAIL_DIR is unset and the default is not opted into', () => {
    delete process.env.AGENT_MAIL_DIR;
    delete process.env.AGENT_MAIL_ALLOW_DEFAULT;
    expect(() => resolveAgentMailDir()).toThrow(/AGENT_MAIL_DIR/);
    expect(() => createAgentMailStore()).toThrow(/AGENT_MAIL_DIR/);
  });

  it('allows the default dir only when AGENT_MAIL_ALLOW_DEFAULT=1', () => {
    delete process.env.AGENT_MAIL_DIR;
    process.env.AGENT_MAIL_ALLOW_DEFAULT = '1';
    expect(resolveAgentMailDir()).toBe(DEFAULT_AGENT_MAIL_DIR);
  });

  it('is unaffected for callers that pass an explicit db path', () => {
    delete process.env.AGENT_MAIL_DIR;
    delete process.env.AGENT_MAIL_ALLOW_DEFAULT;
    const store = createAgentMailStore(dbPath);
    expect(() =>
      store.send({ fromAgent: 'eli', toAgent: 'marcus', type: 'note', subject: 's', bodyMd: 'b' }),
    ).not.toThrow();
    store.close();
  });

  // M1: reply insert and the `replied` event must commit atomically.
  it('rolls back the reply message if the replied event insert fails', () => {
    const store = createAgentMailStore(dbPath);
    const original = store.send({
      fromAgent: 'eli',
      toAgent: 'marcus',
      type: 'question',
      subject: 'Need owner',
      bodyMd: 'who?',
    });

    // Force the `replied` event insert (the second write) to abort, mid-reply.
    const raw = new Database(dbPath);
    raw.exec(
      "CREATE TRIGGER fail_replied BEFORE INSERT ON message_events " +
        "WHEN NEW.event_type = 'replied' BEGIN SELECT RAISE(ABORT, 'boom'); END;",
    );
    raw.close();

    expect(() => store.reply({ actorAgent: 'marcus', messageId: original.id, bodyMd: 'x' })).toThrow();
    // The reply row must not survive the failed replied-event insert.
    expect(store.getThread(original.correlationId)).toHaveLength(1);
    store.close();
  });

  // M2: reject type/priority values outside the known unions.
  it('rejects unknown type and priority on send', () => {
    const store = createAgentMailStore(dbPath);
    expect(() =>
      // @ts-expect-error deliberately invalid type
      store.send({ fromAgent: 'eli', toAgent: 'marcus', type: 'quesion', subject: 's', bodyMd: 'b' }),
    ).toThrow(/type/i);
    expect(() =>
      store.send({
        fromAgent: 'eli',
        toAgent: 'marcus',
        type: 'note',
        subject: 's',
        bodyMd: 'b',
        // @ts-expect-error deliberately invalid priority
        priority: 'urgent',
      }),
    ).toThrow(/priority/i);
    store.close();
  });

  it('rejects unknown priority on reply', () => {
    const store = createAgentMailStore(dbPath);
    const original = store.send({ fromAgent: 'eli', toAgent: 'marcus', type: 'note', subject: 's', bodyMd: 'b' });
    expect(() =>
      // @ts-expect-error deliberately invalid priority
      store.reply({ actorAgent: 'marcus', messageId: original.id, bodyMd: 'x', priority: 'urgent' }),
    ).toThrow(/priority/i);
    store.close();
  });

  // M3: ids are collision-resistant (UUID-based), not short Math.random tokens.
  it('generates UUID-based message ids', () => {
    const store = createAgentMailStore(dbPath);
    const message = store.send({ fromAgent: 'eli', toAgent: 'marcus', type: 'note', subject: 's', bodyMd: 'b' });
    expect(message.id).toMatch(/^msg_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(message.correlationId).toMatch(/^corr_[0-9a-f]{8}-/);
    store.close();
  });

  // L2: same-timestamp messages deliver in insertion order via a rowid tiebreak.
  it('orders same-timestamp messages by rowid in inbox and thread', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-07T00:00:00.000Z'));
    const store = createAgentMailStore(dbPath);
    const first = store.send({ fromAgent: 'eli', toAgent: 'marcus', type: 'note', subject: 'first', bodyMd: 'b' });
    const second = store.reply({ actorAgent: 'marcus', messageId: first.id, bodyMd: 'second' });
    const third = store.reply({ actorAgent: 'eli', messageId: second.id, bodyMd: 'third' });

    const thread = store.getThread(first.correlationId).map((m) => m.id);
    expect(thread).toEqual([first.id, second.id, third.id]);
    store.close();
  });

  // L3: re-acking an already-acked message must not append a duplicate event.
  it('records the acked event only on the transition, not on re-ack', () => {
    const store = createAgentMailStore(dbPath);
    const message = store.send({ fromAgent: 'eli', toAgent: 'marcus', type: 'note', subject: 's', bodyMd: 'b' });
    store.ackMessage('marcus', message.id);
    store.ackMessage('marcus', message.id);
    const ackedEvents = store.listEvents(message.id).filter((e) => e.eventType === 'acked');
    expect(ackedEvents).toHaveLength(1);
    store.close();
  });

  // QoL: inbox excludes closed by default; explicit --status includes them.
  it('excludes closed messages from the inbox unless a status is given', () => {
    const store = createAgentMailStore(dbPath);
    const open = store.send({ fromAgent: 'eli', toAgent: 'marcus', type: 'note', subject: 'open', bodyMd: 'b' });
    const done = store.send({ fromAgent: 'eli', toAgent: 'marcus', type: 'note', subject: 'done', bodyMd: 'b' });
    store.closeMessage('marcus', done.id);

    const defaultInbox = store.listInbox({ agent: 'marcus' }).map((m) => m.id);
    expect(defaultInbox).toEqual([open.id]);
    expect(store.listInbox({ agent: 'marcus', status: 'closed' }).map((m) => m.id)).toEqual([done.id]);
    store.close();
  });
});
