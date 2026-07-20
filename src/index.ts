import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

export const DEFAULT_AGENT_MAIL_DIR = path.join(os.homedir(), '.agent-comms', 'mailbox');

export type AgentMailType = 'question' | 'decision_request' | 'handoff' | 'status' | 'artifact' | 'note';
export type AgentMailPriority = 'low' | 'normal' | 'high';
export type AgentMailStatus = 'new' | 'acked' | 'closed';
export type AgentMailEventType = 'created' | 'acked' | 'replied' | 'closed';

const AGENT_MAIL_TYPES: readonly AgentMailType[] = [
  'question',
  'decision_request',
  'handoff',
  'status',
  'artifact',
  'note',
];
const AGENT_MAIL_PRIORITIES: readonly AgentMailPriority[] = ['low', 'normal', 'high'];

export interface AgentMailLinkInput {
  label: string;
  target: string;
}

export interface AgentMailMessage {
  id: string;
  correlationId: string;
  fromAgent: string;
  toAgent: string;
  type: AgentMailType;
  priority: AgentMailPriority;
  subject: string;
  bodyMd: string;
  relatedProject: string | null;
  requiresResponse: boolean;
  status: AgentMailStatus;
  createdAt: string;
  ackedAt: string | null;
  closedAt: string | null;
}

export interface AgentMailEvent {
  id: string;
  messageId: string;
  eventType: AgentMailEventType;
  actorAgent: string;
  payloadJson: string | null;
  createdAt: string;
}

export interface SendAgentMailInput {
  fromAgent: string;
  toAgent: string;
  type: AgentMailType;
  subject: string;
  bodyMd: string;
  relatedProject?: string;
  requiresResponse?: boolean;
  priority?: AgentMailPriority;
  correlationId?: string;
  links?: AgentMailLinkInput[];
}

export interface ReplyAgentMailInput {
  actorAgent: string;
  messageId: string;
  bodyMd: string;
  subject?: string;
  requiresResponse?: boolean;
  priority?: AgentMailPriority;
  links?: AgentMailLinkInput[];
}

export interface ListAgentMailInput {
  agent: string;
  status?: AgentMailStatus;
}

export interface AgentMailStore {
  send(input: SendAgentMailInput): AgentMailMessage;
  reply(input: ReplyAgentMailInput): AgentMailMessage;
  listInbox(input: ListAgentMailInput): AgentMailMessage[];
  getMessage(messageId: string): AgentMailMessage | null;
  getThread(correlationId: string): AgentMailMessage[];
  listEvents(messageId: string): AgentMailEvent[];
  ackMessage(actorAgent: string, messageId: string): AgentMailMessage;
  closeMessage(actorAgent: string, messageId: string): AgentMailMessage;
  close(): void;
}

interface MessageRow {
  id: string;
  correlation_id: string;
  from_agent: string;
  to_agent: string;
  type: AgentMailType;
  priority: AgentMailPriority;
  subject: string;
  body_md: string;
  related_project: string | null;
  requires_response: number;
  status: AgentMailStatus;
  created_at: string;
  acked_at: string | null;
  closed_at: string | null;
}

interface EventRow {
  id: string;
  message_id: string;
  event_type: AgentMailEventType;
  actor_agent: string;
  payload_json: string | null;
  created_at: string;
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function resolveAgentMailDir(): string {
  const configured = process.env.AGENT_MAIL_DIR;
  if (configured) return configured;
  if (process.env.AGENT_MAIL_ALLOW_DEFAULT === '1') return DEFAULT_AGENT_MAIL_DIR;
  throw new Error(
    `AGENT_MAIL_DIR is not set. Refusing to fall back to ${DEFAULT_AGENT_MAIL_DIR}, ` +
      'which silently diverges from the shared mailbox. Set AGENT_MAIL_DIR to the ' +
      'shared mailbox directory, or set AGENT_MAIL_ALLOW_DEFAULT=1 to opt into the default.',
  );
}

export function resolveAgentMailDbPath(baseDir = resolveAgentMailDir()): string {
  return path.join(baseDir, 'agent_mail.db');
}

function mapMessageRow(row: MessageRow): AgentMailMessage {
  return {
    id: row.id,
    correlationId: row.correlation_id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    type: row.type,
    priority: row.priority,
    subject: row.subject,
    bodyMd: row.body_md,
    relatedProject: row.related_project,
    requiresResponse: Boolean(row.requires_response),
    status: row.status,
    createdAt: row.created_at,
    ackedAt: row.acked_at,
    closedAt: row.closed_at,
  };
}

function mapEventRow(row: EventRow): AgentMailEvent {
  return {
    id: row.id,
    messageId: row.message_id,
    eventType: row.event_type,
    actorAgent: row.actor_agent,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
  };
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function validateType(type: AgentMailType): AgentMailType {
  if (!AGENT_MAIL_TYPES.includes(type)) {
    throw new Error(`Invalid type: ${type}. Expected one of ${AGENT_MAIL_TYPES.join(', ')}.`);
  }
  return type;
}

function validatePriority(priority: AgentMailPriority): AgentMailPriority {
  if (!AGENT_MAIL_PRIORITIES.includes(priority)) {
    throw new Error(`Invalid priority: ${priority}. Expected one of ${AGENT_MAIL_PRIORITIES.join(', ')}.`);
  }
  return priority;
}

export function formatAgentMailForRuntime(message: AgentMailMessage): string {
  const lines = [
    `[Agent Mail] New message from ${message.fromAgent} | type=${message.type} | priority=${message.priority} | subject=${message.subject} | id=${message.id} | requires_response=${String(message.requiresResponse)}`,
  ];
  if (message.relatedProject) {
    lines.push(`project: ${message.relatedProject}`);
  }
  lines.push('');
  lines.push(message.bodyMd.trim());
  return `${lines.join('\n')}\n`;
}

export function createAgentMailStore(dbPath = resolveAgentMailDbPath()): AgentMailStore {
  ensureDir(path.dirname(dbPath));
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      correlation_id TEXT NOT NULL,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      type TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      subject TEXT NOT NULL,
      body_md TEXT NOT NULL,
      related_project TEXT,
      requires_response INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL,
      acked_at TEXT,
      closed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_mail_inbox ON messages(to_agent, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_mail_thread ON messages(correlation_id, created_at);

    CREATE TABLE IF NOT EXISTS message_links (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      target TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message_events (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      actor_agent TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_mail_events ON message_events(message_id, created_at);
  `);

  const insertMessage = db.prepare(`
    INSERT INTO messages (
      id, correlation_id, from_agent, to_agent, type, priority, subject, body_md,
      related_project, requires_response, status, created_at, acked_at, closed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertLink = db.prepare(
    'INSERT INTO message_links (id, message_id, label, target) VALUES (?, ?, ?, ?)'
  );
  const insertEvent = db.prepare(
    'INSERT INTO message_events (id, message_id, event_type, actor_agent, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const selectMessage = db.prepare('SELECT * FROM messages WHERE id = ?');
  const selectInbox = db.prepare(`
    SELECT * FROM messages
    WHERE to_agent = ?
      AND (? IS NULL OR status = ?)
      AND (? IS NOT NULL OR status != 'closed')
    ORDER BY created_at ASC, rowid ASC
  `);
  const selectThread = db.prepare('SELECT * FROM messages WHERE correlation_id = ? ORDER BY created_at ASC, rowid ASC');
  const selectEvents = db.prepare('SELECT * FROM message_events WHERE message_id = ? ORDER BY created_at ASC');
  const updateAck = db.prepare(`
    UPDATE messages
    SET status = CASE WHEN status = 'new' THEN 'acked' ELSE status END,
        acked_at = COALESCE(acked_at, ?)
    WHERE id = ? AND to_agent = ?
  `);
  const updateClose = db.prepare(`
    UPDATE messages
    SET status = 'closed',
        closed_at = COALESCE(closed_at, ?)
    WHERE id = ? AND to_agent = ?
  `);

  const insertMessageWithMetadata = db.transaction((input: SendAgentMailInput) => {
    const id = createId('msg');
    const correlationId = input.correlationId ?? createId('corr');
    const now = new Date().toISOString();
    insertMessage.run(
      id,
      correlationId,
      input.fromAgent,
      input.toAgent,
      validateType(input.type),
      validatePriority(input.priority ?? 'normal'),
      input.subject.trim(),
      input.bodyMd.trim(),
      input.relatedProject ?? null,
      input.requiresResponse ? 1 : 0,
      'new',
      now,
      null,
      null,
    );

    for (const link of input.links ?? []) {
      insertLink.run(createId('lnk'), id, link.label, link.target);
    }
    insertEvent.run(createId('evt'), id, 'created', input.fromAgent, null, now);
    return mapMessageRow(selectMessage.get(id) as MessageRow);
  });

  const insertReplyWithEvent = db.transaction((input: ReplyAgentMailInput, original: MessageRow) => {
    const reply = insertMessageWithMetadata({
      fromAgent: input.actorAgent,
      toAgent: original.from_agent,
      type: 'note',
      subject: input.subject?.trim() || `Re: ${original.subject}`,
      bodyMd: input.bodyMd,
      relatedProject: original.related_project ?? undefined,
      requiresResponse: input.requiresResponse ?? false,
      priority: input.priority ?? 'normal',
      correlationId: original.correlation_id,
      links: input.links,
    });
    insertEvent.run(
      createId('evt'),
      input.messageId,
      'replied',
      input.actorAgent,
      JSON.stringify({ replyMessageId: reply.id }),
      new Date().toISOString(),
    );
    return reply;
  });

  const ackMessageTransaction = db.transaction((actorAgent: string, messageId: string) => {
    const before = selectMessage.get(messageId) as MessageRow | undefined;
    if (!before || before.to_agent !== actorAgent) {
      throw new Error(`Message not found for agent ${actorAgent}: ${messageId}`);
    }
    const now = new Date().toISOString();
    updateAck.run(now, messageId, actorAgent);
    // Only record the event when the ack actually transitions the row; a re-ack
    // of an already-acked message is idempotent and must not append duplicates.
    if (before.status === 'new') {
      insertEvent.run(createId('evt'), messageId, 'acked', actorAgent, null, now);
    }
    return mapMessageRow(selectMessage.get(messageId) as MessageRow);
  });

  return {
    send(input) {
      return insertMessageWithMetadata(input);
    },

    reply(input) {
      const original = selectMessage.get(input.messageId) as MessageRow | undefined;
      if (!original) throw new Error(`Message not found: ${input.messageId}`);
      return insertReplyWithEvent(input, original);
    },

    listInbox(input) {
      const status = input.status ?? null;
      return (selectInbox.all(input.agent, status, status, status) as MessageRow[]).map(mapMessageRow);
    },

    getMessage(messageId) {
      const row = selectMessage.get(messageId) as MessageRow | undefined;
      return row ? mapMessageRow(row) : null;
    },

    getThread(correlationId) {
      return (selectThread.all(correlationId) as MessageRow[]).map(mapMessageRow);
    },

    listEvents(messageId) {
      return (selectEvents.all(messageId) as EventRow[]).map(mapEventRow);
    },

    ackMessage(actorAgent, messageId) {
      return ackMessageTransaction(actorAgent, messageId);
    },

    closeMessage(actorAgent, messageId) {
      // Lifecycle side effects such as Open Brain raw_capture cleanup belong
      // in the mcc-tmux wrapper/CLI. This package remains a storage primitive.
      const now = new Date().toISOString();
      const result = updateClose.run(now, messageId, actorAgent);
      if (result.changes === 0) throw new Error(`Message not found for agent ${actorAgent}: ${messageId}`);
      insertEvent.run(createId('evt'), messageId, 'closed', actorAgent, null, now);
      return mapMessageRow(selectMessage.get(messageId) as MessageRow);
    },

    close() {
      db.close();
    },
  };
}
