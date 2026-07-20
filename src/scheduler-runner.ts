import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import {
  createSchedulerStore,
  resolveSchedulerLogDir,
  type JobRunResult,
  type ScheduledJob,
  type SchedulerStore,
} from './scheduler.js';

/**
 * Run one job's command to completion, appending stdout+stderr to a per-job log,
 * and record the result in the store. Firing is a plain shell exec — the default
 * command is a headless `claude -p` turn, but any command works.
 */
export function runJob(job: ScheduledJob, store: SchedulerStore, logDir: string): Promise<JobRunResult> {
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${job.id}.log`);
  const ranAt = new Date();
  const header = `\n===== ${ranAt.toISOString()} — ${job.name} (${job.id}) =====\n$ ${job.command}\n`;
  fs.appendFileSync(logPath, header);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  return new Promise<JobRunResult>((resolve) => {
    const child = spawn(job.command, {
      shell: true,
      cwd: job.cwd ?? undefined,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(logStream, { end: false });
    child.stderr.pipe(logStream, { end: false });

    const finish = (exitCode: number | null) => {
      const status = exitCode === 0 ? 'ok' : 'error';
      logStream.end(`----- exit ${exitCode} (${status}) -----\n`);
      store.recordRun(job.id, status, exitCode, ranAt);
      resolve({ jobId: job.id, status, exitCode, ranAt: ranAt.toISOString(), logPath });
    };

    child.on('error', (err) => {
      logStream.write(`spawn error: ${err.message}\n`);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

/** Fire every job due at `now`, sequentially. Returns each run's result. */
export async function tickOnce(now = new Date(), dbPath?: string): Promise<JobRunResult[]> {
  const store = dbPath ? createSchedulerStore(dbPath) : createSchedulerStore();
  const logDir = resolveSchedulerLogDir();
  try {
    const due = store.dueJobs(now);
    const results: JobRunResult[] = [];
    for (const job of due) {
      results.push(await runJob(job, store, logDir));
    }
    return results;
  } finally {
    store.close();
  }
}
