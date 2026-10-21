# Reading Estiva from Cursor

Cursor does not load Claude Desktop extensions (`.mcpb`) or Claude Code plugins
(`/plugin install`). It speaks **MCP** through a JSON file instead — the same
protocol the other clients use, backed by the **same server** as Desktop and
Claude Code (`plugin/server/index.js`, or `scripts/mcp-server.ts` when
developing).

## What you are getting

The same tools as Claude Desktop and Claude Code: Ship list/read/comment/status/
assign/create/edit/archive, Peek topics and replies, and `estiva_ping` to see
which hop failed.

Credentials are **not** stored in the repo. Cursor loads them from
`~/.estiva-agent.env` (or environment variables with the same names).

## Before you start

**A bot credential of your own** — same as
[`claude-code-setup.md`](claude-code-setup.md): Estiva ID → your account →
**Your bots**. The secret is shown once.

```bash
printf 'ESTIVA_ID_CLIENT_ID=your-client-id\nESTIVA_ID_CLIENT_SECRET=your-secret\n' > ~/.estiva-agent.env
chmod 600 ~/.estiva-agent.env
```

**Node 18+** on the PATH Cursor uses. If you open the folder over **WSL** or
**Remote SSH**, the server runs on that machine — `node`, `bash`, and
`~/.estiva-agent.env` must exist there, not only on your laptop.

## Install (project config, recommended)

This repository ships a ready-made config:

| You open this folder in Cursor | Config file |
| --- | --- |
| The `estiva` monorepo (`…/estiva`) | `.cursor/mcp.json` at the repo root |
| `estiva-agent` alone | `estiva-agent/.cursor/mcp.json` |

Both point at `scripts/mcp-server.sh`, which runs the MCP server from the
**pinned** worktree at `~/.estiva-agent-runtime` when one exists (same behaviour
as Claude sessions on this machine). To pin or refresh:

```bash
cd estiva-agent && npm run server:pin
```

Restart Cursor (or reload MCP in **Settings → MCP**) after changing the file.

## Install (global, all projects)

Copy the server block into `~/.cursor/mcp.json` and use absolute paths:

```json
{
  "mcpServers": {
    "estiva": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/estiva-agent/plugin/server/index.js"],
      "envFile": "${userHome}/.estiva-agent.env"
    }
  }
}
```

The bundled `plugin/server/index.js` needs no `npm install` in the repo; it
does **not** use the pinned worktree unless you switch the command to
`mcp-server.sh`.

## Check it

In Agent chat, ask whether the Estiva connection is working. The agent should
call `estiva_ping` and report four successful hops.

Then ask for open Ship issues. If `coverage.unreachable` is above zero, the list
is intentionally incomplete — same rule as the CLI and other clients.

## When it does not work

| What you see | What it means |
| --- | --- |
| No Estiva tools in the tool list | MCP server failed to start. **Settings → MCP** → open the `estiva` server log. |
| `node` or `bash` not found | Cursor’s environment has no Node. Install system Node or launch Cursor from a shell where `node` works. |
| Tools work in terminal `ship` but not in Cursor | Different credential file or different machine (local vs WSL remote). |
| Short issue lists / old behaviour | Server answering from an unpinned checkout. Run `npm run server:pin` in `estiva-agent` and restart MCP. |

## Developing the server

```bash
cd estiva-agent
ESTIVA_AGENT_DEV=1 bash scripts/mcp-server.sh
```

Point a temporary MCP entry at that command (or use `claude --plugin-dir ./plugin`
for Claude Code). Do not commit dev-only paths into shared `mcp.json` unless the
team agrees.

## CI

There is no Cursor artefact to build. GitHub Actions already builds the Desktop
`.mcpb` and tests the Claude Code plugin; `scripts/cursor.test.ts` (part of
`npm test`) checks that `.cursor/mcp.json` points at a launcher that exists,
keeps credentials out of the file, and lists the same tools as the extension.

If you use the `estiva` monorepo, its root `.cursor/mcp.json` is a convenience
copy — only the file in this repository is covered by CI.

## Getting stuck is a bug in this document

If something here did not match what you saw, note it on PEEK-161 (or the Agent
feedback project) with the MCP log excerpt.
