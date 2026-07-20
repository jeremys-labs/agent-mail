---
name: agent-sched
description: Use when you need to create, list, or remove a scheduled job — a recurring (cron) or one-time task that runs on its own, such as a nightly report, a periodic check, or a future reminder. Backed by a durable local SQLite job store.
---

# agent-sched

Schedule work that runs on its own, later, without you sitting in the session. A job is a shell command on a schedule; the default is a headless `claude -p` turn that runs beside any live session without disturbing it. A separate daemon fires due jobs — this skill just manages the job list.

## Setup assumed

- The `agent-sched` CLI is on `PATH` (from `npm run build` + `npm link`, or an absolute path to `dist/scheduler-cli.js`).
- `AGENT_SCHED_DIR` (or `AGENT_MAIL_DIR`) points at the store directory. Prefix calls if not exported: `AGENT_SCHED_DIR=/path agent-sched <command>`.
- The tick daemon (`agent-sched-daemon`) must be running for jobs to actually fire — if nothing runs, tell the user their daemon isn't up (see the repo's SCHEDULER.md).

## When to use

- The user wants something to happen on a schedule ("every weekday at 9am…", "nightly…", "in 2 hours…").
- You want to offload recurring work (a summary, a sync, a health check) to run unattended.

## Create a job

Recurring (cron), default fire is a headless agent turn:

```bash
agent-sched add --name "morning-brief" --cron "0 9 * * 1-5" \
  --prompt "Summarize my unread email and post the top 5 items" \
  --cwd /path/to/workdir --agent <you> \
  --notify <you> --timeout-ms 600000
```

One-time, at a specific local time:

```bash
agent-sched add --name "reminder" --at "2026-08-01T14:00:00" \
  --command "say 'ship it'"
```

Key options:
- `--cron "<5-field>"` (min hour dom mon dow, **local time**) **or** `--at "<ISO datetime>"` — exactly one.
- `--prompt "<task>"` builds `claude -p "<task>"` (default fire) **or** `--command "<shell>"` for any raw command — exactly one.
- `--cwd <path>` — working directory for the run.
- `--notify <agent>` — when the job finishes, send that agent an agent-mail with the result (status, exit code, log tail). Add `--notify-on error` to only notify on failure (default: always). This is how a scheduled job raises failures/results back to a live session.
- `--timeout-ms <n>` — kill a run that overruns so it can't wedge the queue.
- `--agent <label>` — who the job belongs to (used as the notify sender).

## Manage jobs

```bash
agent-sched list                 # all jobs, next run first
agent-sched get     --id job_... # one job (last status, exit code, next run)
agent-sched disable --id job_... # pause without deleting
agent-sched enable  --id job_... # re-arm (re-computes next run)
agent-sched remove  --id job_... # delete
agent-sched run-now --id job_... # fire immediately, for testing
```

## Rules

- Cron is **local time** — confirm the timezone assumption with the user if it matters.
- Pair `--notify` with the `agent-mail` capability so failures/results surface in a live session instead of dying in a log.
- If jobs aren't firing, the daemon is almost certainly not running — check before assuming a scheduling bug.
- Use `run-now` to verify a new job's command actually works before trusting the schedule.
