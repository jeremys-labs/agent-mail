#!/usr/bin/env node
import {
  buildClaudePromptCommand,
  createSchedulerStore,
  resolveSchedulerLogDir,
  type CreateJobInput,
  type NotifyOn,
} from './scheduler.js';
import { runJob } from './scheduler-runner.js';

interface ParsedArgs {
  command: string;
  options: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const options = new Map<string, string | boolean>();
  for (let i = 0; i < rest.length; i += 1) {
    const current = rest[i];
    if (!current?.startsWith('--')) continue;
    const key = current.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith('--')) {
      options.set(key, true);
      continue;
    }
    options.set(key, next);
    i += 1;
  }
  return { command, options };
}

function getRequired(options: Map<string, string | boolean>, key: string): string {
  const value = options.get(key);
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing required --${key}`);
  return value.trim();
}

function getOptional(options: Map<string, string | boolean>, key: string): string | undefined {
  const value = options.get(key);
  return typeof value === 'string' ? value.trim() : undefined;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const USAGE = `agent-sched — durable local job scheduler for agents

Usage: agent-sched <command> [options]

Commands:
  add      --name <n> (--cron "<expr>" | --at "<iso>")
           (--prompt "<task>" [--claude-args "<args>"] | --command "<shell>")
           [--cwd <path>] [--agent <label>] [--timeout-ms <n>]
           [--notify <agent>] [--notify-on always|error]
             --prompt builds a headless "claude -p <task>" run (default fire).
             --command runs any shell command instead.
             --notify raises the run's result to <agent> via agent-mail so
               failures/results surface in a live session (default: always;
               --notify-on error sends only on failure).
             --timeout-ms kills a run that overruns so it can't wedge the daemon.
  list     [--all]                 List jobs (default: all; --all is a no-op alias)
  get      --id <jobId>            Show one job
  remove   --id <jobId>            Delete a job
  enable   --id <jobId>            Re-arm a disabled job
  disable  --id <jobId>            Pause a job (kept, won't fire)
  run-now  --id <jobId>            Fire a job immediately (for testing)
  help     Show this help

Environment:
  AGENT_SCHED_DIR            Dir holding agent_sched.db + logs (AGENT_MAIL_DIR also works)
  AGENT_SCHED_ALLOW_DEFAULT  Set to 1 to opt into ~/.agent-comms/scheduler when unset
  AGENT_SCHED_TICK_MS        Daemon poll interval, ms (default 30000)

Cron is standard 5-field (min hour dom mon dow), evaluated in system local time.
`;

function isHelpRequest(argv: string[]): boolean {
  return argv.length === 0 || argv.some((a) => a === 'help' || a === '--help' || a === '-h');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (isHelpRequest(argv)) {
    process.stdout.write(USAGE);
    return;
  }
  const { command, options } = parseArgs(argv);
  const store = createSchedulerStore();
  try {
    switch (command) {
      case 'add': {
        const promptText = getOptional(options, 'prompt');
        const rawCommand = getOptional(options, 'command');
        if (!promptText && !rawCommand) throw new Error('Provide --prompt or --command');
        if (promptText && rawCommand) throw new Error('Provide only one of --prompt or --command');
        const finalCommand = promptText
          ? buildClaudePromptCommand(promptText, getOptional(options, 'claude-args'))
          : rawCommand!;
        const timeoutRaw = getOptional(options, 'timeout-ms');
        const input: CreateJobInput = {
          name: getRequired(options, 'name'),
          cron: getOptional(options, 'cron'),
          runAt: getOptional(options, 'at'),
          command: finalCommand,
          cwd: getOptional(options, 'cwd'),
          agent: getOptional(options, 'agent'),
          timeoutMs: timeoutRaw !== undefined ? Number(timeoutRaw) : undefined,
          notifyAgent: getOptional(options, 'notify'),
          notifyOn: getOptional(options, 'notify-on') as NotifyOn | undefined,
        };
        printJson(store.add(input));
        break;
      }
      case 'list': {
        printJson(store.list(true));
        break;
      }
      case 'get': {
        const job = store.get(getRequired(options, 'id'));
        if (!job) throw new Error(`Job not found: ${getOptional(options, 'id')}`);
        printJson(job);
        break;
      }
      case 'remove': {
        const ok = store.remove(getRequired(options, 'id'));
        printJson({ removed: ok });
        break;
      }
      case 'enable': {
        printJson(store.setEnabled(getRequired(options, 'id'), true));
        break;
      }
      case 'disable': {
        printJson(store.setEnabled(getRequired(options, 'id'), false));
        break;
      }
      case 'run-now': {
        const job = store.get(getRequired(options, 'id'));
        if (!job) throw new Error(`Job not found: ${getOptional(options, 'id')}`);
        const result = await runJob(job, store, resolveSchedulerLogDir());
        printJson(result);
        break;
      }
      default:
        throw new Error(`Unsupported command: ${command}`);
    }
  } finally {
    store.close();
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
