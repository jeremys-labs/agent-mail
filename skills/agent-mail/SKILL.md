---
name: agent-mail
description: Use when you need to message another local agent, reply to an injected `[Agent Mail]` message, hand off work, or check your mailbox. Durable local agent-to-agent coordination backed by a shared SQLite file.
---

# agent-mail

Cross-agent coordination for agents sharing one machine (or shared storage). Messages are durable — a cold/offline agent gets them when it next checks. This is the standard path; do not invent your own message-passing.

## Setup assumed

- The `agent-mail` CLI is on `PATH` (from `npm run build` + `npm link`, or an absolute path to `dist/cli.js`).
- `AGENT_MAIL_DIR` points at the shared mailbox directory both agents use. If it's not exported globally, prefix each call: `AGENT_MAIL_DIR=/path/to/mailbox agent-mail <command>`.
- **Your agent key** is the name you were given (e.g. `agentA`). Other agents' keys are their names. Use lowercase, stable keys.

## When to use

- You need to ask another agent something or hand off work.
- Your session received an injected prompt starting with `[Agent Mail]`.
- You want to check whether anyone has messaged you.

## Send a message

```bash
agent-mail send --from <you> --to <them> \
  --type question --subject "Short subject" \
  --body "Concrete ask." --requires-response
```

- `--type`: `question` | `decision_request` | `handoff` | `status` | `artifact` | `note`.
- `--body-file /abs/path.md` sends a long/multiline body from a file instead of `--body`.
- Set `--requires-response` only when you actually need a reply.
- Save the returned `id` if you'll need to inspect the thread.

## Reply to injected mail

An injected prompt looks like: `[Agent Mail] New message from eli | ... | id=msg_123 | requires_response=true`. Reply by that message id:

```bash
agent-mail reply --agent <you> --id msg_123 --body "Answer." 
# add --requires-response if you need a follow-up
```

Then close the thread when the exchange is done:

```bash
agent-mail close --agent <you> --id msg_123
```

## Check your inbox / inspect a thread

```bash
agent-mail inbox  --agent <you> --status new      # unread messages
agent-mail inbox  --agent <you> --status new --format prompt   # as injectable [Agent Mail] blocks
agent-mail thread --id msg_123                    # full thread by message id
agent-mail ack    --agent <you> --id msg_123      # acknowledge without replying
```

## Rules

- Reply by mailbox **message id**, never by guessing.
- Keep subjects short and bodies concrete.
- Close threads once the coordination loop is done so inboxes stay clean.
- Automatic delivery: if the SessionStart hook is wired (see the repo's `hooks/`), unread mail is injected for you at session start — you don't have to poll manually.
