import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createAgentMailStore } from './index.js';
import { createSchedulerStore, type ScheduledJob, type SchedulerStore } from './scheduler.js';
import { notifyJobResult } from './scheduler-notify.js';
import type { JobRunResult } from './scheduler.js';

let dir: string;
let store: SchedulerStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sched-notify-'));
  store = createSchedulerStore(path.join(dir, 'agent_sched.db'));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeResult(job: ScheduledJob, status: 'ok' | 'error', exitCode: number | null): JobRunResult {
  const logPath = path.join(dir, `${job.id}.log`);
  fs.writeFileSync(logPath, 'line one\nline two\nfinal line\n');
  return { jobId: job.id, status, exitCode, ranAt: new Date().toISOString(), logPath };
}

describe('notifyJobResult', () => {
  const mailboxFactory = () => createAgentMailStore(path.join(dir, 'agent_mail.db'));

  it('sends a mail on success when notify-on=always', () => {
    const job = store.add({ name: 'j', cron: '0 9 * * *', command: 'echo hi', agent: 'agentA', notifyAgent: 'agentB' });
    const out = notifyJobResult(job, makeResult(job, 'ok', 0), mailboxFactory);
    expect(out.sent).toBe(true);
    const inbox = mailboxFactory().list ? [] : []; // list not on store; read via a fresh store
    const mail = createAgentMailStore(path.join(dir, 'agent_mail.db'));
    const got = mail.listInbox({ agent: 'agentB', status: 'new' });
    mail.close();
    expect(got).toHaveLength(1);
    expect(got[0].subject).toContain('ok');
    expect(got[0].fromAgent).toBe('agentA');
    void inbox;
  });

  it('skips a success mail when notify-on=error', () => {
    const job = store.add({ name: 'j', cron: '0 9 * * *', command: 'x', notifyAgent: 'agentB', notifyOn: 'error' });
    const out = notifyJobResult(job, makeResult(job, 'ok', 0), mailboxFactory);
    expect(out.sent).toBe(false);
    expect(out.reason).toMatch(/notify-on=error/);
  });

  it('sends a high-priority mail on failure with notify-on=error', () => {
    const job = store.add({ name: 'j', cron: '0 9 * * *', command: 'x', notifyAgent: 'agentB', notifyOn: 'error' });
    const out = notifyJobResult(job, makeResult(job, 'error', 3), mailboxFactory);
    expect(out.sent).toBe(true);
    const mail = createAgentMailStore(path.join(dir, 'agent_mail.db'));
    const got = mail.listInbox({ agent: 'agentB', status: 'new' });
    mail.close();
    expect(got[0].subject).toContain('FAILED');
    expect(got[0].priority).toBe('high');
  });

  it('does nothing when no notify target', () => {
    const job = store.add({ name: 'j', cron: '0 9 * * *', command: 'x' });
    expect(notifyJobResult(job, makeResult(job, 'error', 1), mailboxFactory).sent).toBe(false);
  });

  it('never throws when the mailbox factory fails', () => {
    const job = store.add({ name: 'j', cron: '0 9 * * *', command: 'x', notifyAgent: 'agentB' });
    const out = notifyJobResult(job, makeResult(job, 'error', 1), () => {
      throw new Error('no mailbox on this box');
    });
    expect(out.sent).toBe(false);
    expect(out.reason).toMatch(/mailbox unavailable/);
  });
});
