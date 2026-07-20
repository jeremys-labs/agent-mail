import fs from 'fs';
import { createAgentMailStore, resolveAgentMailDbPath, type AgentMailStore } from './index.js';
import type { JobRunResult, ScheduledJob } from './scheduler.js';

/** Last N lines of a job's run log, for the notification body. */
function tailLog(logPath: string, lines = 20): string {
  try {
    const all = fs.readFileSync(logPath, 'utf8').split('\n');
    return all.slice(-lines).join('\n').trim();
  } catch {
    return '(no log output captured)';
  }
}

/**
 * Raise a scheduled job's outcome to a long-running session via agent-mail, so
 * failures and results are visible in a human-attended inbox instead of dying in
 * a log file. Fires only when the job has a notify target and the policy matches
 * (always, or error-only). Best-effort: a mailbox that isn't configured on this
 * box logs a note and does NOT fail the run.
 *
 * `storeFactory` is injectable for tests; production uses the default mailbox.
 */
export function notifyJobResult(
  job: ScheduledJob,
  result: JobRunResult,
  storeFactory: () => AgentMailStore = () => createAgentMailStore(),
): { sent: boolean; reason?: string } {
  if (!job.notifyAgent) return { sent: false, reason: 'no notify target' };
  if (job.notifyOn === 'error' && result.status !== 'error') {
    return { sent: false, reason: 'ok result, notify-on=error' };
  }

  const failed = result.status === 'error';
  const subject = `Scheduled job "${job.name}" ${failed ? 'FAILED' : 'ok'}`;
  const body = [
    `Scheduled job **${job.name}** (${job.id}) ${failed ? 'failed' : 'completed'}.`,
    '',
    `- status: ${result.status}${result.exitCode === null ? '' : ` (exit ${result.exitCode})`}`,
    `- ran at: ${result.ranAt}`,
    job.agent ? `- agent: ${job.agent}` : null,
    `- command: \`${job.command}\``,
    '',
    'Recent log:',
    '```',
    tailLog(result.logPath),
    '```',
  ]
    .filter((l) => l !== null)
    .join('\n');

  let store: AgentMailStore | undefined;
  try {
    store = storeFactory();
    store.send({
      fromAgent: job.agent ?? 'scheduler',
      toAgent: job.notifyAgent,
      type: 'status',
      subject,
      bodyMd: body,
      priority: failed ? 'high' : 'normal',
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: `mailbox unavailable: ${(err as Error).message}` };
  } finally {
    store?.close();
  }
}

/** True when a mailbox is reachable on this box (used for a startup warning). */
export function mailboxConfigured(): boolean {
  try {
    resolveAgentMailDbPath();
    return true;
  } catch {
    return false;
  }
}
