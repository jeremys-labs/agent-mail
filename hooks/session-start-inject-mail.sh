#!/usr/bin/env bash
# SessionStart hook: inject this agent's unread agent-mail into the session.
#
# Wire it up in your Claude Code settings.json (see hooks/README.md). On every
# session start it prints any unread mail as [Agent Mail] blocks, which the
# harness feeds into the model as additional context. Empty inbox → prints
# nothing → zero noise.
#
# Config via env (set these in the hook entry or your shell profile):
#   AGENT_MAIL_AGENT  — this agent's key (e.g. agentA).           REQUIRED
#   AGENT_MAIL_DIR    — dir holding the shared agent_mail.db.     REQUIRED
#   AGENT_MAIL_HOME   — path to this repo (where dist/ lives).    default: script's repo root
set -euo pipefail

REPO_ROOT="${AGENT_MAIL_HOME:-"$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"}"
AGENT="${AGENT_MAIL_AGENT:-}"

if [[ -z "$AGENT" ]]; then
  echo "[agent-mail hook] AGENT_MAIL_AGENT is not set — skipping mail injection." >&2
  exit 0
fi
if [[ -z "${AGENT_MAIL_DIR:-}" ]]; then
  echo "[agent-mail hook] AGENT_MAIL_DIR is not set — skipping mail injection." >&2
  exit 0
fi

# Emits [Agent Mail] blocks for unread mail, or nothing when the inbox is empty.
node "$REPO_ROOT/dist/cli.js" inbox --agent "$AGENT" --status new --format prompt
