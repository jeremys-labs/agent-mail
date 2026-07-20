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
import { notifyJobResult } from './scheduler-notify.js';

/**
 * Run one job's command to completion, appending stdout+stderr to a per-job log,
 * and record the result in the store (which clears the running lease). Firing is
 * a plain shell exec — the default command is a headless `claude -p` turn, but
 * any command works.
 *
 * If the job has a `timeoutMs`, the child is SIGTERM'd (then SIGKILL'd) when it
 * overruns, recorded as an error, so a hung `claude -p` can't wedge the daemon's
 * sequential loop forever.
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

    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let escalateTimer: NodeJS.Timeout | undefined;

    if (job.timeoutMs && job.timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        logStream.write(`\n----- timeout after ${job.timeoutMs}ms — sending SIGTERM -----\n`);
        child.kill('SIGTERM');
        // Hard-kill if it ignores SIGTERM.
        escalateTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      }, job.timeoutMs);
    }

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (escalateTimer) clearTimeout(escalateTimer);
      const status = timedOut || exitCode !== 0 ? 'error' : 'ok';
      const completedAt = new Date();
      // Advance the schedule from completion time and release the lease.
      store.recordRun(job.id, status, exitCode, completedAt);
      const result: JobRunResult = { jobId: job.id, status, exitCode, ranAt: ranAt.toISOString(), logPath };
      // Close the log FIRST, then notify — so the mailbox body's log tail
      // includes the final exit line instead of racing the flush.
      logStream.end(`----- exit ${exitCode}${timedOut ? ' (timed out)' : ''} (${status}) -----\n`, () => {
        // Raise the outcome to a long-running session via agent-mail (best-effort;
        // a missing mailbox never fails the run).
        const notified = notifyJobResult(job, result);
        if (job.notifyAgent) {
          fs.appendFileSync(
            logPath,
            notified.sent ? `notified ${job.notifyAgent}\n` : `notify skipped: ${notified.reason}\n`,
          );
        }
        resolve(result);
      });
    };

    child.on('error', (err) => {
      logStream.write(`spawn error: ${err.message}\n`);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

/**
 * Derive the log dir that sits next to a given db file, so a store opened with
 * an explicit dbPath logs beside its own db instead of wherever the env points.
 */
function logDirForDb(dbPath?: string): string {
  return dbPath ? path.join(path.dirname(dbPath), 'logs') : resolveSchedulerLogDir();
}

/**
 * Claim and fire every job due at `now`, sequentially. Claiming is atomic, so
 * two overlapping ticks (or two daemons) never fire the same slot twice.
 */
export async function tickOnce(now = new Date(), dbPath?: string): Promise<JobRunResult[]> {
  const store = dbPath ? createSchedulerStore(dbPath) : createSchedulerStore();
  const logDir = logDirForDb(dbPath);
  try {
    const claimed = store.claimDueJobs(now);
    const results: JobRunResult[] = [];
    for (const job of claimed) {
      results.push(await runJob(job, store, logDir));
    }
    return results;
  } finally {
    store.close();
  }
}
