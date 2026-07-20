import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createSchedulerStore, type SchedulerStore } from './scheduler.js';
import { runJob } from './scheduler-runner.js';

let dir: string;
let logDir: string;
let store: SchedulerStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sched-run-'));
  logDir = path.join(dir, 'logs');
  store = createSchedulerStore(path.join(dir, 'agent_sched.db'));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('runJob', () => {
  it('runs a command, captures output to a log, and records ok', async () => {
    const marker = path.join(dir, 'ran.txt');
    const job = store.add({ name: 'touch', runAt: new Date(Date.now() + 1000).toISOString(), command: `echo hello && echo written > ${marker}` });
    const result = await runJob(job, store, logDir);

    expect(result.status).toBe('ok');
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.readFileSync(result.logPath, 'utf8')).toContain('hello');

    const updated = store.get(job.id);
    expect(updated?.lastStatus).toBe('ok');
    expect(updated?.enabled).toBe(false); // one-time retired
  });

  it('records error on non-zero exit', async () => {
    const job = store.add({ name: 'fail', runAt: new Date(Date.now() + 1000).toISOString(), command: 'exit 3' });
    const result = await runJob(job, store, logDir);
    expect(result.status).toBe('error');
    expect(result.exitCode).toBe(3);
    expect(store.get(job.id)?.lastStatus).toBe('error');
  });

  it('kills a job that overruns its timeout and records error', async () => {
    const job = store.add({
      name: 'hang',
      runAt: new Date(Date.now() + 1000).toISOString(),
      command: 'sleep 30',
      timeoutMs: 300,
    });
    const result = await runJob(job, store, logDir);
    expect(result.status).toBe('error');
    expect(fs.readFileSync(result.logPath, 'utf8')).toContain('timeout');
    expect(store.get(job.id)?.lastStatus).toBe('error');
  }, 10_000);
});
