# Reading Estiva from Claude Code

For Claude Code — in a terminal, or through the VS Code and JetBrains
extensions, which run the same CLI and read the same configuration.

Claude Desktop is [`claude-desktop-setup.md`](claude-desktop-setup.md). The two
run **the same server**: `plugin/server/index.js` is the one built file this
repository commits, and the Desktop `.mcpb` is packed from it rather than built
separately. They cannot answer differently.

## What you are getting

Twenty-two tools, the same ones Desktop gets. For Ship: read issues, projects
and the activity feed; comment, and **edit a comment already posted**; set a
status, assign, amend or move an issue, edit or archive a project, create either,
and — behind a confirmation — delete either. For Peek: read a topic, reply in a
thread or to one message in it, **edit a message**, start a conversation, create
a topic. Plus `estiva_ping`, which reports which hop is broken when nothing
works.

`extension/manifest.json` is the authoritative list — `extension.test.ts` diffs
it against the server's real `tools/list`, and nothing compares a sentence like
this one to either. It read "twelve" while the server offered twenty-two.

It acts as **your own service identity**, not a shared one. Anything it writes
is attributed to a bot whose name says you steer it.

## Before you start

**A bot credential of your own.** Make one at
[id.estiva.app](https://id.estiva.app) → your account → **Your bots**. No admin
is involved. You get a client id and a secret, and **the secret is shown once**.

> **If you already use the Desktop extension, make a *second* bot for this.**
> The secret you typed into Desktop is not recoverable — only its hash is
> stored — and using **New secret** to recover it would immediately stop Desktop
> working, because rotating replaces the old secret rather than adding one. A
> bot per machine or per client is the intended shape; you can have five.

**Node 18 or newer**, on the PATH that Claude Code itself sees. The plugin is a
plain Node program; unlike the Desktop extension there is no bundled runtime.
If you use `nvm` and launch your editor from a desktop icon rather than a shell,
`node` may not be on that PATH — see the last section.

## Install

Two commands, inside Claude Code:

```
/plugin marketplace add estiva-app/estiva-agent
```

```
/plugin install estiva@estiva
```

If the install summary asks you to, run `/reload-plugins`.

## Give it your credential

The plugin declares **no credential of its own** — a plugin has no equivalent of
Desktop's setup dialog, and a secret written into a public repository is not a
secret. It reads the same file the CLI does:

```bash
printf 'ESTIVA_ID_CLIENT_ID=your-client-id\nESTIVA_ID_CLIENT_SECRET=your-secret\n' > ~/.estiva-agent.env
chmod 600 ~/.estiva-agent.env
```

Environment variables of the same names win over the file, if you would rather
keep it somewhere else.

Restart Claude Code, or run `/reload-plugins`, so the server picks it up.

## Check it, before you trust an answer

Ask it:

> Is the Estiva connection working?

`estiva_ping` walks four hops — credentials, token, signature, relay query — and
names the one that failed. Expect four ticks and a count of events. Then ask
something real, like *what Ship issues are open*.

**The list is not always complete, and it says so.** Discovery starts from
project records, so an issue whose project no longer resolves is unreachable —
`ship_list_issues` returns a `coverage` block with the count. When it is above
zero, the answer is a subset.

## In VS Code specifically

Nothing extra: the extension runs the Claude Code CLI, so a plugin installed
once is available in the terminal and in the editor.

The one thing that differs is **which machine you installed it on**. If you open
a folder over the WSL or SSH remote, Claude Code runs *there*, not on your
laptop — so the plugin, `~/.estiva-agent.env` and Node all have to exist on that
side. A setup that works in a local window and not a remote one is almost always
this.

## When it does not work

| What you see | What it means |
| --- | --- |
| The plugin installed and there are no Estiva tools | The server failed to start. Open `/plugin` and read the **Errors** tab. |
| An error naming `node` | Node is not on the PATH Claude Code sees. Launch your editor from a shell where `node` works, or install Node system-wide rather than through `nvm`. |
| `nip98_url_not_allowed` | Estiva ID refused to sign, so nothing reached the relay. Your credential is missing the relay as an allowed destination — ask an admin. |
| `relay_membership_required` | Signing worked and the door is shut: the key is not a relay member. |
| `invalid_client` | Wrong or rotated secret. Re-issuing a credential **replaces** the old one, so a secret that worked yesterday failing today is expected — including on your other machine. |

## Running it from a clone instead

For developing the server. `--plugin-dir` loads a working copy without
installing anything, and takes precedence over the installed plugin for that
session:

```bash
git clone https://github.com/estiva-app/estiva-agent.git
cd estiva-agent
npm install
npm run extension     # writes plugin/server/index.js
claude --plugin-dir ./plugin
```

`npm run plugin:validate` builds and then checks the plugin the way CI does: the
committed bundle matches its source, the manifests agree, and the command the
plugin declares actually starts and lists twelve tools.

## Getting stuck is a bug in this document

If you had to guess, ask someone, or fix something this page did not mention,
say so on PEEK-161 with what you actually saw.
