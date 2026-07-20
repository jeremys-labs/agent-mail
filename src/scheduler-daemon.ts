#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { tickOnce } from './scheduler-runner.js';
import { createSchedulerStore, resolveSchedulerDbPath } from './scheduler.js';
import { mailboxConfigured } from './scheduler-notify.js';

/**
 * Long-running tick loop. Wakes every AGENT_SCHED_TICK_MS (default 30s), fires
 * any due jobs, sleeps again. Keep one of these alive per machine (launchd,
 * systemd, or `nohup agent-sched-daemon &`).
 *
 * The store is the source of truth, so a daemon restart loses nothing: jobs and
 * their next_run_at persist in SQLite. On startup we release stale running
 * leases (older than AGENT_SCHED_STALE_CLAIM_MS) so a job whose daemon crashed
 * mid-run isn't wedged as "running" forever.
 *
 * Each tick writes a heartbeat file — "launchd alive but tick stopped" is a real
 * failure mode, so liveness needs proof the LOOP is still turning, not just that
 * the process exists.
 */
const TICK_MS = Number(process.env.AGENT_SCHED_TICK_MS ?? 30_000);
const STALE_CLAIM_MS = Number(process.env.AGENT_SCHED_STALE_CLAIM_MS ?? 60 * 60 * 1000); // 1h

function log(msg: string): void {
  process.stdout.write(`[agent-sched ${new Date().toISOString()}] ${msg}\n`);
}

function writeHeartbeat(dbPath: string, tickCount: number, lastError: string | null): void {
  const hbPath = path.join(path.dirname(dbPath), '.agent-sched-heartbeat');
  const payload = { lastTickAt: new Date().toISOString(), tickCount, lastError };
  try {
    fs.writeFileSync(hbPath, JSON.stringify(payload, null, 2));
  } catch {
    // A heartbeat write failure must not kill the loop.
  }
}

async function loop(): Promise<void> {
  // Resolve once up front so a misconfigured env fails loudly at startup.
  const dbPath = resolveSchedulerDbPath();
  log(`daemon started — db=${dbPath} tick=${TICK_MS}ms`);
  if (!mailboxConfigured()) {
    log('warning: no mailbox configured (AGENT_MAIL_DIR/AGENT_SCHED_DIR) — job --notify will be skipped');
  }

  // Recover leases stranded by a prior crash before the first tick.
  const recovery = createSchedulerStore(dbPath);
  try {
    const reclaimed = recovery.reclaimStale(new Date(), STALE_CLAIM_MS);
    if (reclaimed > 0) log(`reclaimed ${reclaimed} stale running lease(s) from a prior run`);
  } finally {
    recovery.close();
  }

  let running = true;
  const stop = () => {
    running = false;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  let tickCount = 0;
  while (running) {
    let lastError: string | null = null;
    try {
      const results = await tickOnce(new Date(), dbPath);
      for (const r of results) {
        log(`fired ${r.jobId} → ${r.status}${r.exitCode === null ? '' : ` (exit ${r.exitCode})`} → ${r.logPath}`);
      }
    } catch (err) {
      lastError = (err as Error).message;
      log(`tick error: ${lastError}`);
    }
    tickCount += 1;
    writeHeartbeat(dbPath, tickCount, lastError);
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }
  log('daemon stopped');
}

loop().catch((err) => {
  process.stderr.write(`[agent-sched] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
