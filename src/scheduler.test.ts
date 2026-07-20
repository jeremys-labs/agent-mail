import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildClaudePromptCommand,
  computeNextRun,
  createSchedulerStore,
  type SchedulerStore,
} from './scheduler.js';

let dir: string;
let store: SchedulerStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sched-'));
  store = createSchedulerStore(path.join(dir, 'agent_sched.db'));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('createSchedulerStore', () => {
  it('adds a cron job and computes a future next run', () => {
    const job = store.add({ name: 'daily', cron: '0 9 * * *', command: 'echo hi' });
    expect(job.scheduleKind).toBe('cron');
    expect(job.enabled).toBe(true);
    expect(job.nextRunAt).not.toBeNull();
    expect(new Date(job.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('adds a one-time job in the future', () => {
    const at = new Date(Date.now() + 60_000).toISOString();
    const job = store.add({ name: 'once', runAt: at, command: 'echo once' });
    expect(job.scheduleKind).toBe('once');
    expect(job.nextRunAt).toBe(new Date(at).toISOString());
  });

  it('rejects a job with both --cron and --at', () => {
    expect(() =>
      store.add({ name: 'bad', cron: '0 9 * * *', runAt: new Date(Date.now() + 1000).toISOString(), command: 'x' }),
    ).toThrow(/exactly one/);
  });

  it('rejects a one-time job in the past', () => {
    expect(() => store.add({ name: 'past', runAt: new Date(Date.now() - 1000).toISOString(), command: 'x' })).toThrow(
      /past/,
    );
  });

  it('rejects an invalid cron expression', () => {
    expect(() => store.add({ name: 'bad', cron: 'not a cron', command: 'x' })).toThrow();
  });

  it('surfaces only enabled due jobs', () => {
    const past = new Date(Date.now() + 60_000).toISOString();
    const job = store.add({ name: 'once', runAt: past, command: 'echo hi' });
    // Not yet due.
    expect(store.dueJobs(new Date()).map((j) => j.id)).not.toContain(job.id);
    // Due once we look from just after its runAt.
    const after = new Date(Date.now() + 120_000);
    expect(store.dueJobs(after).map((j) => j.id)).toContain(job.id);
    // Disabled → not due.
    store.setEnabled(job.id, false);
    expect(store.dueJobs(after).map((j) => j.id)).not.toContain(job.id);
  });

  it('retires a one-time job after it runs', () => {
    const at = new Date(Date.now() + 1000).toISOString();
    const job = store.add({ name: 'once', runAt: at, command: 'echo hi' });
    const updated = store.recordRun(job.id, 'ok', 0, new Date());
    expect(updated?.enabled).toBe(false);
    expect(updated?.nextRunAt).toBeNull();
    expect(updated?.lastStatus).toBe('ok');
  });

  it('advances a cron job to a later slot after it runs', () => {
    const job = store.add({ name: 'daily', cron: '0 9 * * *', command: 'echo hi' });
    const first = job.nextRunAt!;
    const updated = store.recordRun(job.id, 'ok', 0, new Date(first));
    expect(updated?.enabled).toBe(true);
    expect(new Date(updated!.nextRunAt!).getTime()).toBeGreaterThan(new Date(first).getTime());
  });

  it('removes a job', () => {
    const job = store.add({ name: 'x', cron: '0 9 * * *', command: 'echo hi' });
    expect(store.remove(job.id)).toBe(true);
    expect(store.get(job.id)).toBeNull();
  });
});

describe('computeNextRun', () => {
  it('returns null for a past one-time job', () => {
    expect(computeNextRun({ scheduleKind: 'once', cron: null, runAt: new Date(Date.now() - 1000).toISOString() }, new Date())).toBeNull();
  });
});

describe('buildClaudePromptCommand', () => {
  it('wraps the prompt in a headless claude -p call', () => {
    expect(buildClaudePromptCommand('do the thing')).toBe(`claude -p 'do the thing'`);
  });
  it('escapes single quotes safely', () => {
    expect(buildClaudePromptCommand(`it's fine`)).toBe(`claude -p 'it'\\''s fine'`);
  });
  it('appends extra claude args', () => {
    expect(buildClaudePromptCommand('go', '--model opus')).toBe(`claude -p 'go' --model opus`);
  });
});
