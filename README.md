# agent-mail

Durable local coordination primitives for agents. **Zero infra — SQLite files plus CLIs.** Two tools ship here:

- **`agent-mail`** — a mailbox so agents can message each other (below).
- **`agent-sched`** — a job scheduler so agents can run recurring/one-time tasks. See **[SCHEDULER.md](SCHEDULER.md)**.

---

Durable local mailbox for agent-to-agent coordination. **Zero infra — the whole system is one SQLite file plus a CLI.**

Two (or more) agents can talk if they share:
1. A **rendezvous point** both can reach — the mailbox DB (a file path).
2. A **way to notice new mail** — poll on a timer, or a SessionStart hook that injects unread messages into the session.

That's the whole trick. This package is exactly that: a SQLite-backed store + `send`/`inbox`/`ack`/`reply`/`close` verbs + prompt-formatting helpers for runtime injection. No server, no daemon, no orchestration.

## Install

```bash
git clone git@github.com:jeremys-labs/agent-mail.git
cd agent-mail
npm install
npm run build      # compiles to ./dist, exposes the `agent-mail` bin
```

Verify it works:

```bash
npm test           # runs the full vitest suite
```

## Point your machine at a mailbox

The mailbox DB defaults to:

```text
~/.agent-comms/mailbox/agent_mail.db
```

Override the location with `AGENT_MAIL_DIR` — set this to wherever you want the two agents to rendezvous:

```bash
export AGENT_MAIL_DIR=/path/to/shared/mailbox
```

- **Two agents on the same machine** → point both at the same `AGENT_MAIL_DIR`. Done.
- **Two agents on different machines** → put `AGENT_MAIL_DIR` on shared storage both can reach (a synced folder, a network mount), or run one shared box. The DB is a plain file; anything that can read/write the same path works.

## CLI

Your agent key is just a name you pick (e.g. `agentA`, `agentB`). Both sides use the same DB via `AGENT_MAIL_DIR`.

```bash
# send a message
agent-mail send \
  --from agentA \
  --to agentB \
  --type question \
  --subject "Need a decision" \
  --body "Ship the migration today or wait?" \
  --requires-response

# read your inbox
agent-mail inbox --agent agentB --status new

# acknowledge, reply, close
agent-mail ack   --agent agentB --id msg_123
agent-mail reply --agent agentB --id msg_123 --body "Ship it."
agent-mail close --agent agentB --id msg_123

# inspect a full thread
agent-mail thread --id msg_123
```

Message `--type` values: `question`, `decision_request`, `handoff`, `status`, `artifact`, `note`.
`--body-file /abs/path.md` sends the body from a file (handy for long/multiline content).

## Teach your agents to use it (skills)

The CLIs exist, but a Claude Code agent won't reach for them unless it knows they're there. This repo ships two skills for that:

- [`skills/agent-mail/SKILL.md`](skills/agent-mail/SKILL.md) — when/how to message, reply, check the inbox.
- [`skills/agent-sched/SKILL.md`](skills/agent-sched/SKILL.md) — when/how to create and manage scheduled jobs.

Install them by copying (or symlinking) into the agent's skills directory:

```bash
cp -r skills/agent-mail skills/agent-sched ~/.claude/skills/
```

Now the agent discovers "message another agent" and "schedule a job" as first-class capabilities. Set `AGENT_MAIL_DIR` / `AGENT_SCHED_DIR` in the agent's environment (or your shell profile) so the skills' commands resolve the shared store.

## Make it automatic

Mail sitting in the DB does nothing on its own — **each agent has to actually check.** Don't do it by hand: wire the included SessionStart hook so unread mail is injected into the session automatically on start (empty inbox = zero noise).

See **[`hooks/README.md`](hooks/README.md)** for the drop-in script + `settings.json` snippet. The CLI backs it with `agent-mail inbox --agent <you> --status new --format prompt`, which emits runtime-injection blocks (or nothing when the inbox is empty).

## Programmatic use

The store is also importable:

```ts
import { sendAgentMail, listInbox, replyToAgentMail } from 'agent-mail';
```

See `src/index.ts` for the full API.

## Status

Pre-1.0. Extracted from the internal agent-comms monorepo as a standalone, dependency-light drop-in. One runtime dependency: `better-sqlite3`.
