#!/usr/bin/env node
import { tickOnce } from './scheduler-runner.js';
import { resolveSchedulerDbPath } from './scheduler.js';

/**
 * Long-running tick loop. Wakes every AGENT_SCHED_TICK_MS (default 30s), fires
 * any due jobs, sleeps again. Keep one of these alive per machine (launchd,
 * systemd, or `nohup node dist/scheduler-daemon.js &`).
 *
 * The store is the source of truth, so a daemon restart loses nothing: jobs and
 * their next_run_at persist in SQLite.
 */
const TICK_MS = Number(process.env.AGENT_SCHED_TICK_MS ?? 30_000);

function log(msg: string): void {
  process.stdout.write(`[agent-sched ${new Date().toISOString()}] ${msg}\n`);
}

async function loop(): Promise<void> {
  // Resolve once up front so a misconfigured env fails loudly at startup.
  const dbPath = resolveSchedulerDbPath();
  log(`daemon started — db=${dbPath} tick=${TICK_MS}ms`);
  let running = true;
  const stop = () => {
    running = false;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (running) {
    try {
      const results = await tickOnce(new Date(), dbPath);
      for (const r of results) {
        log(`fired ${r.jobId} → ${r.status}${r.exitCode === null ? '' : ` (exit ${r.exitCode})`} → ${r.logPath}`);
      }
    } catch (err) {
      log(`tick error: ${(err as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }
  log('daemon stopped');
}

loop().catch((err) => {
  process.stderr.write(`[agent-sched] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
