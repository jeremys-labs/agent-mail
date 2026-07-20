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
  --agent agentA \
  --notify agentA \
  --timeout-ms 600000

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

## Raise results to a live session (`--notify`)

A scheduled job runs headless — nobody's watching. `--notify <agent>` closes that gap: when the job finishes, the scheduler drops an **agent-mail** to that agent with the outcome (status, exit code, timing, and the tail of the run log). That agent's SessionStart hook (or mid-session poll) surfaces it in their live session, so a 3am failure is waiting in the inbox instead of buried in a log.

```bash
agent-sched add --name "nightly-sync" --cron "0 2 * * *" \
  --command "./sync.sh" --agent worker --notify me
```

- Default policy is **always** (results *and* failures). Narrow to failures with `--notify-on error`.
- Failures send **high priority**; successes send normal.
- Needs a mailbox on this box (`AGENT_MAIL_DIR`, or shared with `AGENT_SCHED_DIR`). If none is configured, notification is skipped and noted in the job log — the run itself never fails because of it.

This is the scheduler↔mailbox loop: **scheduler = when it runs, mailbox = who hears about it.**

## Don't let a hung job wedge the daemon (`--timeout-ms`)

Jobs run sequentially, so one hung `claude -p` would block every later job. `--timeout-ms <n>` SIGTERMs (then SIGKILLs) a run that overruns and records it as an error, keeping the queue moving. No timeout unless you set one.

## Health

- **Per job:** `last_status` / `last_exit_code` (see `agent-sched get`).
- **Daemon liveness:** each tick writes `$AGENT_SCHED_DIR/.agent-sched-heartbeat` with `lastTickAt` / `tickCount` / `lastError`. "Process alive but tick stopped" is a real failure — check that `lastTickAt` is recent, not just that the process exists.
- **Crash recovery:** on startup the daemon releases running leases older than `AGENT_SCHED_STALE_CLAIM_MS` (default 1h), so a job whose daemon died mid-run isn't stuck as "running" forever. Claiming is atomic, so a due slot fires exactly once even if two ticks overlap.

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
    <!-- launchd's PATH is minimal. Give jobs a real PATH so `claude`, `node`,
         etc. resolve, or use an absolute path to `claude` in the job command. -->
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <!-- If the agents use a non-default Claude config dir, set it here too. -->
    <!-- <key>CLAUDE_CONFIG_DIR</key><string>/Users/me/.claude</string> -->
  </dict>
  <!-- cwd for the daemon; individual jobs still get their own --cwd. -->
  <key>WorkingDirectory</key><string>/abs/path/to/agent-mail</string>
  <!-- Capture daemon stdout/stderr — where you'll see tick logs + fatals. -->
  <key>StandardOutPath</key><string>/abs/path/to/agent-state/logs/daemon.out.log</string>
  <key>StandardErrorPath</key><string>/abs/path/to/agent-state/logs/daemon.err.log</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

> Most vanilla-box failures are **env/PATH**, not scheduler logic: launchd runs with a stripped PATH, so either set `PATH` (above) or use an absolute `claude` path in your `--command`. The heartbeat file tells you the loop is actually ticking; `KeepAlive` only proves the process exists.

## Pairs with the mailbox

A scheduled job can do anything — including dropping agent-mail. Want a nightly agent to hand work to another agent? Its `--prompt` turn can call `agent-mail send`, and the recipient's SessionStart hook picks it up. Scheduler = *when*, mailbox = *who gets told*.
