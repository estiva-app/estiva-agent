#!/usr/bin/env bash
#
# Create or update the pinned worktree the MCP server runs from (AGE-6).
#
# The server used to launch from this checkout, which is shared and routinely
# parked on somebody's branch. On 2026-08-28 that meant every MCP session was
# answering from a revision ten commits old — and reporting the resulting
# shortfall as a limit of the *workspace*: `unreachable: 13` where the same
# identity on `origin/main` saw `0`. Nothing was wrong with the data.
#
# **Detached on purpose.** The worktree is pinned to a commit, not to `main`, so
# it cannot drift when somebody checks something out, and `git pull` in this
# repository cannot move it. Moving it is this script, run deliberately.
#
# Editing the agent and testing it by restarting a session still works — that is
# what `ESTIVA_AGENT_DEV=1` is for, and it is the reason the old shape existed.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
runtime="${ESTIVA_AGENT_RUNTIME:-$HOME/.estiva-agent-runtime}"
ref="${1:-origin/main}"

git -C "$repo" fetch --quiet origin

if [ -e "$runtime/.git" ]; then
  git -C "$runtime" fetch --quiet origin
  git -C "$runtime" checkout --quiet --detach "$ref"
else
  rm -rf "$runtime"
  git -C "$repo" worktree add --quiet --detach "$runtime" "$ref"
fi

# Dependencies live in the worktree, not the repository, so the pinned server
# cannot pick up a half-installed tree from somebody else's branch switch.
( cd "$runtime" && npm ci --silent )

echo "pinned $(git -C "$runtime" rev-parse --short HEAD) at $runtime" >&2
