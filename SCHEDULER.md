# agent-sched

Durable local job scheduler for agents. Same zero-infra pattern as the mailbox: a SQLite job store, a tiny tick daemon, and a CLI. Ships in this repo alongside `agent-mail`.

## What "firing a job" means

A job is just a shell command on a schedule. The **default** command (via `--prompt`) is a headless Claude Code turn:

```
claude -p "<your task>"
```

That runs a one-shot agent turn in its own process — **beside** any long-running interactive session, never interrupting it. Scheduled work and your live session coexist. You can also schedule any raw command with `--command`.

## Setup

```bash
npm install && npm run build

# where jobs + logs live. Same dir as the mailbox is fine — different db file.
export AGENT_SCHED_DIR=/path/to/agent-state     # AGENT_MAIL_DIR also works
```

## Create jobs

```bash
# recurring: headless claude turn every weekday at 9am (local time)
agent-sched add \
  --name "morning-brief" \
  --cron "0 9 * * 1-5" \
  --prompt "Summarize my unread email and post the top 5 items" \
  --cwd /Users/me/work \
  --agent agentA

# one-time: run a raw command at a specific time
agent-sched add --name "deploy-reminder" --at "2026-08-01T14:00:00" --command "say 'ship it'"

agent-sched list                 # all jobs, next run first
agent-sched get     --id job_... # one job's full state (last status, next run)
agent-sched disable --id job_... # pause without deleting
agent-sched enable  --id job_... # re-arm (re-computes next run — no missed-tick storm)
agent-sched remove  --id job_... # delete
agent-sched run-now --id job_... # fire immediately, for testing
```

`--cron` is standard 5-field (`min hour dom mon dow`), evaluated in **system local time**. Each run's stdout/stderr is appended to `$AGENT_SCHED_DIR/logs/<jobId>.log`, and `last_status` / `last_exit_code` are recorded on the job.

## Keep the daemon alive

Jobs only fire while the tick daemon runs. One per machine:

```bash
# quick + dirty
nohup agent-sched-daemon >> "$AGENT_SCHED_DIR/logs/daemon.log" 2>&1 &
```

For something that survives reboots, wrap it in a launchd plist (macOS) or a systemd unit (Linux). The store is the source of truth, so restarts lose nothing — jobs and their next-run times persist in SQLite. Tune the poll interval with `AGENT_SCHED_TICK_MS` (default 30000).

### launchd example (macOS)

`~/Library/LaunchAgents/com.agent-sched.daemon.plist` — set the paths, then `launchctl load` it:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agent-sched.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/abs/path/to/agent-mail/dist/scheduler-daemon.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENT_SCHED_DIR</key><string>/abs/path/to/agent-state</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

## Pairs with the mailbox

A scheduled job can do anything — including dropping agent-mail. Want a nightly agent to hand work to another agent? Its `--prompt` turn can call `agent-mail send`, and the recipient's SessionStart hook picks it up. Scheduler = *when*, mailbox = *who gets told*.
