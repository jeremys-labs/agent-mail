# agent-mail

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

## The one thing people forget

Mail sitting in the DB does nothing on its own. **Each agent has to actually check.** Either poll `agent-mail inbox --agent <you> --status new` on a timer, or wire a SessionStart hook that reads unread mail and injects it into the session. Without that, messages just pile up unread.

## Programmatic use

The store is also importable:

```ts
import { sendAgentMail, listInbox, replyToAgentMail } from 'agent-mail';
```

See `src/index.ts` for the full API.

## Status

Pre-1.0. Extracted from the internal agent-comms monorepo as a standalone, dependency-light drop-in. One runtime dependency: `better-sqlite3`.
