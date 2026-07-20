#!/usr/bin/env node
import fs from 'fs';
import {
  createAgentMailStore,
  formatAgentMailForRuntime,
  type AgentMailPriority,
  type AgentMailStatus,
  type AgentMailType,
} from './index.js';
import { validateSingleRecipient } from './recipients.js';

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
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing required --${key}`);
  }
  return value.trim();
}

function getOptional(options: Map<string, string | boolean>, key: string): string | undefined {
  const value = options.get(key);
  return typeof value === 'string' ? value.trim() : undefined;
}

function getBoolean(options: Map<string, string | boolean>, key: string): boolean {
  return options.get(key) === true;
}

function readBody(options: Map<string, string | boolean>): string {
  const body = getOptional(options, 'body');
  const bodyFile = getOptional(options, 'body-file');
  if (bodyFile) return fs.readFileSync(bodyFile, 'utf8');
  if (body) return body;
  throw new Error('Missing body content. Use --body or --body-file');
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const USAGE = `agent-mail — durable local mailbox for agent-to-agent coordination

Usage: agent-mail <command> [options]

Commands:
  send    --from <agent> --to <agent> --type <type> --subject <s> (--body <md> | --body-file <path>)
          [--project <p>] [--priority low|normal|high] [--requires-response]
  inbox   --agent <agent> [--status new|acked|closed] [--format prompt]
          (closed excluded unless --status given; --format prompt emits
           runtime-injection blocks, or nothing when the inbox is empty)
  ack     --agent <agent> --id <messageId>
  reply   --agent <agent> --id <messageId> (--body <md> | --body-file <path>)
          [--subject <s>] [--priority low|normal|high] [--requires-response]
  close   --agent <agent> --id <messageId>
  thread  (--id <messageId> | --correlation-id <corrId>)
  help    Show this help

Environment:
  AGENT_MAIL_DIR            Directory holding the shared agent_mail.db (required)
  AGENT_MAIL_ALLOW_DEFAULT  Set to 1 to opt into the default dir when AGENT_MAIL_DIR is unset

Types: question, decision_request, handoff, status, artifact, note
`;

function isHelpRequest(argv: string[]): boolean {
  return argv.length === 0 || argv.some((arg) => arg === 'help' || arg === '--help' || arg === '-h');
}

function main(): void {
  const argv = process.argv.slice(2);

  // Detect help before opening the store: `--help`/`-h` land in the command
  // position, so the store must not be constructed (its AGENT_MAIL_DIR guard
  // would turn a plain help request into an env-var error).
  if (isHelpRequest(argv)) {
    process.stdout.write(USAGE);
    return;
  }

  const { command, options } = parseArgs(argv);
  const store = createAgentMailStore();

  try {
    switch (command) {
      case 'send': {
        const message = store.send({
          fromAgent: getRequired(options, 'from'),
          toAgent: validateSingleRecipient(getRequired(options, 'to')),
          type: getRequired(options, 'type') as AgentMailType,
          subject: getRequired(options, 'subject'),
          bodyMd: readBody(options),
          relatedProject: getOptional(options, 'project'),
          requiresResponse: getBoolean(options, 'requires-response'),
          priority: (getOptional(options, 'priority') as AgentMailPriority | undefined) ?? 'normal',
        });
        printJson(message);
        break;
      }
      case 'inbox': {
        const messages = store.listInbox({
          agent: getRequired(options, 'agent'),
          status: getOptional(options, 'status') as AgentMailStatus | undefined,
        });
        if (getOptional(options, 'format') === 'prompt') {
          // Runtime-injection format: one [Agent Mail] block per message, or
          // nothing at all when the inbox is empty (so a SessionStart hook that
          // pipes this in adds zero noise when there's no mail).
          if (messages.length > 0) {
            process.stdout.write(messages.map(formatAgentMailForRuntime).join('\n'));
          }
          break;
        }
        printJson(messages);
        break;
      }
      case 'ack': {
        const message = store.ackMessage(getRequired(options, 'agent'), getRequired(options, 'id'));
        printJson(message);
        break;
      }
      case 'reply': {
        const message = store.reply({
          actorAgent: getRequired(options, 'agent'),
          messageId: getRequired(options, 'id'),
          bodyMd: readBody(options),
          subject: getOptional(options, 'subject'),
          requiresResponse: getBoolean(options, 'requires-response'),
          priority: getOptional(options, 'priority') as AgentMailPriority | undefined,
        });
        printJson(message);
        break;
      }
      case 'close': {
        const message = store.closeMessage(getRequired(options, 'agent'), getRequired(options, 'id'));
        printJson(message);
        break;
      }
      case 'thread': {
        const messageId = getOptional(options, 'id');
        const correlationId = getOptional(options, 'correlation-id');
        if (!messageId && !correlationId) {
          throw new Error('Missing --id or --correlation-id');
        }
        const resolvedCorrelationId = correlationId ?? store.getMessage(messageId!)?.correlationId;
        if (!resolvedCorrelationId) throw new Error(`Message not found: ${messageId}`);
        printJson(store.getThread(resolvedCorrelationId));
        break;
      }
      default:
        throw new Error(`Unsupported command: ${command}`);
    }
  } finally {
    store.close();
  }
}

main();
