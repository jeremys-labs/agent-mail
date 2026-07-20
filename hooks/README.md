# Automatic mail injection (Claude Code hook)

Mail sitting in the DB does nothing until an agent checks. This hook makes that
automatic: on every session start it injects the agent's unread mail into the
session so the model sees it without you running `inbox` by hand.

## 1. Build the CLI

```bash
npm install && npm run build
chmod +x hooks/session-start-inject-mail.sh
```

## 2. Wire the SessionStart hook

Add this to the work machine's Claude Code `settings.json` (usually
`~/.claude/settings.json`). Set `AGENT_MAIL_AGENT`, `AGENT_MAIL_DIR`, and
`AGENT_MAIL_HOME` to match this box — one entry per agent, using that agent's key:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "AGENT_MAIL_AGENT=agentA AGENT_MAIL_DIR=/path/both/agents/can/reach AGENT_MAIL_HOME=/abs/path/to/agent-mail /abs/path/to/agent-mail/hooks/session-start-inject-mail.sh"
          }
        ]
      }
    ]
  }
}
```

Whatever the script prints on stdout is fed to the model as context. An empty
inbox prints nothing, so quiet sessions stay clean.

## 3. (Optional) also catch mail mid-session

SessionStart fires once per session. If an agent stays in one long session, wire
the same script to a periodic trigger too — e.g. a cron/launchd job that starts a
short "check mail" turn, or a `UserPromptSubmit` hook so unread mail is injected
right before each of your prompts. Same script, same env; pick the cadence that
fits how the agents run.

## The rule this encodes

Two agents talk when they share a rendezvous point **and** a way to notice new
mail. `AGENT_MAIL_DIR` is the rendezvous; this hook is the noticing. Without the
second half, mail just piles up unread.
