#!/usr/bin/env bash
#
# Launch the Estiva MCP server for a client that is not in this shell.
#
# Claude Desktop is a Windows application and this repo lives in WSL, so Desktop
# crosses the boundary with `wsl.exe -e <program>`. That runs a program
# directly — no login shell, so no profile, so **no nvm and no node on PATH**.
#
# The obvious fix is to name nvm's node absolutely in the Desktop config. Do not:
# that path carries the node version in it, so the next `nvm install` silently
# breaks the launch, and the symptom is a tool that quietly stops appearing in
# an app nobody is watching for errors. This script exists so the Desktop config
# names something whose path never changes.
#
# Nothing may reach stdout before the server starts — stdout is the JSON-RPC
# stream, and one stray line from a shell profile corrupts it in a way that
# presents as "the server does not work" with no error anywhere.
set -euo pipefail

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# Sourced with stdout redirected to stderr: nvm is chatty on some setups, and
# its greeting would land in the middle of a protocol stream.
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" 1>&2
fi

# Which tree answers (AGE-6).
#
# This repository is shared and is routinely parked on somebody's branch, so
# launching from it means a session can answer from code days old while every
# other signal looks correct. The server runs from a worktree pinned to a
# commit instead — `scripts/pin-server.sh` creates and moves it.
#
# Three ways out, in order:
#
#   ESTIVA_AGENT_DEV=1   run from this checkout, to test a local edit by
#                        restarting a session. That workflow is the reason the
#                        old shape existed and it is kept on purpose.
#   the pinned worktree  the default.
#   this checkout        when no worktree has been pinned yet.
#
# The last one is a **fallback, not a default**: hard-failing here would take
# out Claude Desktop's tools with an error nobody is watching for, which this
# file already warns about. So it falls back, says so on stderr, and — the part
# that matters — exports the choice, so `estiva_ping` reports which tree
# answered rather than leaving it to be inferred.
repo="$(cd "$(dirname "$0")/.." && pwd)"
runtime="${ESTIVA_AGENT_RUNTIME:-$HOME/.estiva-agent-runtime}"

if [ "${ESTIVA_AGENT_DEV:-}" = "1" ]; then
  export ESTIVA_AGENT_SOURCE=dev
  cd "$repo"
elif [ -e "$runtime/.git" ]; then
  export ESTIVA_AGENT_SOURCE=pinned
  cd "$runtime"
else
  export ESTIVA_AGENT_SOURCE=checkout
  echo "estiva mcp: no pinned worktree at $runtime, running from $repo — run scripts/pin-server.sh" >&2
  cd "$repo"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "estiva mcp: no node on PATH, and nvm did not provide one (NVM_DIR=$NVM_DIR)" >&2
  exit 1
fi

exec node node_modules/tsx/dist/cli.mjs scripts/mcp-server.ts
