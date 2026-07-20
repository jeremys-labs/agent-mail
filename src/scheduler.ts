import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { Cron } from 'croner';

export const DEFAULT_AGENT_SCHED_DIR = path.join(os.homedir(), '.agent-comms', 'scheduler');

export type ScheduleKind = 'cron' | 'once';
export type JobRunStatus = 'ok' | 'error';
export type NotifyOn = 'always' | 'error';

export interface ScheduledJob {
  id: string;
  name: string;
  scheduleKind: ScheduleKind;
  cron: string | null;
  runAt: string | null;
  command: string;
  cwd: string | null;
  agent: string | null;
  timeoutMs: number | null;
  notifyAgent: string | null;
  notifyOn: NotifyOn;
  enabled: boolean;
  running: boolean;
  claimedAt: string | null;
  createdAt: string;
  lastRunAt: string | null;
  lastStatus: JobRunStatus | null;
  lastExitCode: number | null;
  nextRunAt: string | null;
}

export interface CreateJobInput {
  name: string;
  cron?: string;
  runAt?: string;
  command: string;
  cwd?: string;
  agent?: string;
  timeoutMs?: number;
  notifyAgent?: string;
  notifyOn?: NotifyOn;
}

export interface JobRunResult {
  jobId: string;
  status: JobRunStatus;
  exitCode: number | null;
  ranAt: string;
  logPath: string;
}

interface JobRow {
  id: string;
  name: string;
  schedule_kind: ScheduleKind;
  cron: string | null;
  run_at: string | null;
  command: string;
  cwd: string | null;
  agent: string | null;
  timeout_ms: number | null;
  notify_agent: string | null;
  notify_on: NotifyOn | null;
  enabled: number;
  running: number;
  claimed_at: string | null;
  created_at: string;
  last_run_at: string | null;
  last_status: JobRunStatus | null;
  last_exit_code: number | null;
  next_run_at: string | null;
}

/**
 * Resolve the scheduler's data directory. Mirrors the mailbox's env contract so
 * the two tools can share one base dir. Order: AGENT_SCHED_DIR, then
 * AGENT_MAIL_DIR (shared base, separate db file), then the default only when
 * explicitly opted into — a silent default would diverge from the real store.
 */
export function resolveSchedulerDir(): string {
  const configured = process.env.AGENT_SCHED_DIR ?? process.env.AGENT_MAIL_DIR;
  if (configured) return configured;
  if (process.env.AGENT_SCHED_ALLOW_DEFAULT === '1' || process.env.AGENT_MAIL_ALLOW_DEFAULT === '1') {
    return DEFAULT_AGENT_SCHED_DIR;
  }
  throw new Error(
    `AGENT_SCHED_DIR is not set (AGENT_MAIL_DIR also works). Refusing to fall back to ` +
      `${DEFAULT_AGENT_SCHED_DIR}, which silently diverges from the real job store. ` +
      'Set AGENT_SCHED_DIR, or set AGENT_SCHED_ALLOW_DEFAULT=1 to opt into the default.',
  );
}

export function resolveSchedulerDbPath(baseDir = resolveSchedulerDir()): string {
  return path.join(baseDir, 'agent_sched.db');
}

export function resolveSchedulerLogDir(baseDir = resolveSchedulerDir()): string {
  return path.join(baseDir, 'logs');
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function mapJobRow(row: JobRow): ScheduledJob {
  return {
    id: row.id,
    name: row.name,
    scheduleKind: row.schedule_kind,
    cron: row.cron,
    runAt: row.run_at,
    command: row.command,
    cwd: row.cwd,
    agent: row.agent,
    timeoutMs: row.timeout_ms,
    notifyAgent: row.notify_agent,
    notifyOn: row.notify_on ?? 'always',
    enabled: Boolean(row.enabled),
    running: Boolean(row.running),
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastExitCode: row.last_exit_code,
    nextRunAt: row.next_run_at,
  };
}

/**
 * Compute the next fire time strictly AFTER `from`. Returns null when there is
 * no future occurrence (a one-time job whose time has passed).
 */
export function computeNextRun(job: Pick<ScheduledJob, 'scheduleKind' | 'cron' | 'runAt'>, from: Date): string | null {
  if (job.scheduleKind === 'once') {
    if (!job.runAt) return null;
    return new Date(job.runAt).getTime() > from.getTime() ? new Date(job.runAt).toISOString() : null;
  }
  if (!job.cron) return null;
  const next = new Cron(job.cron).nextRun(from);
  return next ? next.toISOString() : null;
}

/** Validate a cron expression by attempting to construct it. Throws on bad input. */
export function assertValidCron(expr: string): void {
  // Cron() throws synchronously on an unparseable pattern.
  const c = new Cron(expr);
  if (!c.nextRun()) {
    // A syntactically valid pattern that can never fire again (e.g. a fixed past
    // date) is a user error for a recurring job.
    throw new Error(`Cron expression "${expr}" has no future run time.`);
  }
}

export interface SchedulerStore {
  add(input: CreateJobInput): ScheduledJob;
  list(includeDisabled?: boolean): ScheduledJob[];
  get(id: string): ScheduledJob | null;
  remove(id: string): boolean;
  setEnabled(id: string, enabled: boolean): ScheduledJob | null;
  /** Read-only peek at enabled, due, not-already-running jobs. Does NOT claim. */
  dueJobs(now: Date): ScheduledJob[];
  /**
   * Atomically claim enabled+due+idle jobs (sets running=1, claimed_at). Only
   * claimed jobs should be executed — this is the lease that stops a second
   * daemon (or a double-started launchd job) from firing the same slot twice.
   */
  claimDueJobs(now: Date): ScheduledJob[];
  /**
   * Record a completed run: clear the running lease, advance the cron from the
   * completion time (skipping missed intervals), or retire a one-time job.
   */
  recordRun(id: string, status: JobRunStatus, exitCode: number | null, completedAt: Date): ScheduledJob | null;
  /**
   * Release running leases claimed before `now - staleMs` — recovers jobs whose
   * daemon crashed mid-run so they aren't wedged as running forever.
   */
  reclaimStale(now: Date, staleMs: number): number;
  close(): void;
}

export function createSchedulerStore(dbPath = resolveSchedulerDbPath()): SchedulerStore {
  ensureDir(path.dirname(dbPath));
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      schedule_kind TEXT NOT NULL,
      cron TEXT,
      run_at TEXT,
      command TEXT NOT NULL,
      cwd TEXT,
      agent TEXT,
      timeout_ms INTEGER,
      notify_agent TEXT,
      notify_on TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      running INTEGER NOT NULL DEFAULT 0,
      claimed_at TEXT,
      created_at TEXT NOT NULL,
      last_run_at TEXT,
      last_status TEXT,
      last_exit_code INTEGER,
      next_run_at TEXT
    );
  `);

  // Idempotent migration for stores created before the lease/timeout columns.
  const existingCols = new Set((db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map((c) => c.name));
  for (const [col, ddl] of [
    ['timeout_ms', 'ALTER TABLE jobs ADD COLUMN timeout_ms INTEGER'],
    ['notify_agent', 'ALTER TABLE jobs ADD COLUMN notify_agent TEXT'],
    ['notify_on', 'ALTER TABLE jobs ADD COLUMN notify_on TEXT'],
    ['running', 'ALTER TABLE jobs ADD COLUMN running INTEGER NOT NULL DEFAULT 0'],
    ['claimed_at', 'ALTER TABLE jobs ADD COLUMN claimed_at TEXT'],
  ] as const) {
    if (!existingCols.has(col)) db.exec(ddl);
  }

  return {
    add(input: CreateJobInput): ScheduledJob {
      const hasCron = typeof input.cron === 'string' && input.cron.trim().length > 0;
      const hasAt = typeof input.runAt === 'string' && input.runAt.trim().length > 0;
      if (hasCron === hasAt) {
        throw new Error('Provide exactly one of --cron or --at.');
      }
      const scheduleKind: ScheduleKind = hasCron ? 'cron' : 'once';
      const cron = hasCron ? input.cron!.trim() : null;
      let runAt: string | null = null;
      if (hasAt) {
        const d = new Date(input.runAt!.trim());
        if (Number.isNaN(d.getTime())) throw new Error(`--at is not a valid date: ${input.runAt}`);
        runAt = d.toISOString();
      }
      if (cron) assertValidCron(cron);

      const now = new Date();
      const id = createId('job');
      const nextRunAt = computeNextRun({ scheduleKind, cron, runAt }, now);
      if (!nextRunAt) {
        throw new Error(
          scheduleKind === 'once'
            ? `--at is in the past: ${runAt}`
            : `Cron "${cron}" produced no future run.`,
        );
      }
      if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)) {
        throw new Error(`--timeout-ms must be a positive number: ${input.timeoutMs}`);
      }
      if (input.notifyOn && input.notifyOn !== 'always' && input.notifyOn !== 'error') {
        throw new Error(`--notify-on must be "always" or "error": ${input.notifyOn}`);
      }
      // notify_on only means something with a target; default to "always" when a
      // target is set so results AND failures surface unless narrowed to error.
      const notifyAgent = input.notifyAgent ?? null;
      const notifyOn: NotifyOn | null = notifyAgent ? input.notifyOn ?? 'always' : null;
      db.prepare(
        `INSERT INTO jobs (id, name, schedule_kind, cron, run_at, command, cwd, agent, timeout_ms, notify_agent, notify_on, enabled, running, created_at, next_run_at)
         VALUES (@id, @name, @schedule_kind, @cron, @run_at, @command, @cwd, @agent, @timeout_ms, @notify_agent, @notify_on, 1, 0, @created_at, @next_run_at)`,
      ).run({
        id,
        name: input.name,
        schedule_kind: scheduleKind,
        cron,
        run_at: runAt,
        command: input.command,
        cwd: input.cwd ?? null,
        agent: input.agent ?? null,
        timeout_ms: input.timeoutMs ?? null,
        notify_agent: notifyAgent,
        notify_on: notifyOn,
        created_at: now.toISOString(),
        next_run_at: nextRunAt,
      });
      return this.get(id)!;
    },

    list(includeDisabled = true): ScheduledJob[] {
      const rows = includeDisabled
        ? (db.prepare('SELECT * FROM jobs ORDER BY next_run_at IS NULL, next_run_at').all() as JobRow[])
        : (db.prepare('SELECT * FROM jobs WHERE enabled = 1 ORDER BY next_run_at IS NULL, next_run_at').all() as JobRow[]);
      return rows.map(mapJobRow);
    },

    get(id: string): ScheduledJob | null {
      const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
      return row ? mapJobRow(row) : null;
    },

    remove(id: string): boolean {
      return db.prepare('DELETE FROM jobs WHERE id = ?').run(id).changes > 0;
    },

    setEnabled(id: string, enabled: boolean): ScheduledJob | null {
      const job = this.get(id);
      if (!job) return null;
      // Re-arm next_run_at when re-enabling so a job that was disabled across its
      // window doesn't fire immediately for every missed tick.
      const nextRunAt = enabled ? computeNextRun(job, new Date()) : job.nextRunAt;
      db.prepare('UPDATE jobs SET enabled = ?, next_run_at = ? WHERE id = ?').run(enabled ? 1 : 0, nextRunAt, id);
      return this.get(id);
    },

    dueJobs(now: Date): ScheduledJob[] {
      const rows = db
        .prepare(
          'SELECT * FROM jobs WHERE enabled = 1 AND running = 0 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at',
        )
        .all(now.toISOString()) as JobRow[];
      return rows.map(mapJobRow);
    },

    claimDueJobs(now: Date): ScheduledJob[] {
      // Single atomic statement: only idle, enabled, due rows flip to running and
      // are returned. A concurrent daemon's identical statement can't re-claim a
      // row this one already flipped, so a due slot fires exactly once.
      const nowIso = now.toISOString();
      const rows = db
        .prepare(
          `UPDATE jobs SET running = 1, claimed_at = @now
           WHERE enabled = 1 AND running = 0 AND next_run_at IS NOT NULL AND next_run_at <= @now
           RETURNING *`,
        )
        .all({ now: nowIso }) as JobRow[];
      return rows.map(mapJobRow);
    },

    recordRun(id: string, status: JobRunStatus, exitCode: number | null, completedAt: Date): ScheduledJob | null {
      const job = this.get(id);
      if (!job) return null;
      // Advance the cron from the COMPLETION time, not the start — a long run
      // that overshoots its next slot skips the missed interval instead of
      // firing repeatedly to catch up. Also clears the running lease.
      const nextRunAt = job.scheduleKind === 'once' ? null : computeNextRun(job, completedAt);
      const stillEnabled = job.scheduleKind === 'once' ? 0 : job.enabled ? 1 : 0;
      db.prepare(
        `UPDATE jobs SET last_run_at = @last_run_at, last_status = @last_status,
         last_exit_code = @last_exit_code, next_run_at = @next_run_at, enabled = @enabled,
         running = 0, claimed_at = NULL WHERE id = @id`,
      ).run({
        id,
        last_run_at: completedAt.toISOString(),
        last_status: status,
        last_exit_code: exitCode,
        next_run_at: nextRunAt,
        enabled: stillEnabled,
      });
      return this.get(id);
    },

    reclaimStale(now: Date, staleMs: number): number {
      const cutoff = new Date(now.getTime() - staleMs).toISOString();
      return db
        .prepare('UPDATE jobs SET running = 0, claimed_at = NULL WHERE running = 1 AND (claimed_at IS NULL OR claimed_at < ?)')
        .run(cutoff).changes;
    },

    close(): void {
      db.close();
    },
  };
}

/**
 * Build a headless Claude Code invocation for a scheduled task. This is the
 * default fire command for `--prompt`: a one-shot `claude -p` turn that runs
 * beside any long-running interactive session without disturbing it.
 */
export function buildClaudePromptCommand(prompt: string, extraArgs?: string): string {
  const quoted = `'${prompt.replace(/'/g, `'\\''`)}'`;
  return `claude -p ${quoted}${extraArgs ? ` ${extraArgs}` : ''}`;
}
