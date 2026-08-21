# Estiva Agent

Read and act on the Estiva workspace as a **service identity** — from Claude
Desktop, from Claude Code, or from a terminal. Ship issues today; Peek topics
alongside them; a third app by adding a module, not by editing an app.

```bash
npx tsx scripts/agent.ts ship issues --status open
npx tsx scripts/agent.ts ship show PEE-1
npm run probe:agent          # four hops: token → sign → header → query
```

Setting this up for a person is [`docs/claude-desktop-setup.md`](docs/claude-desktop-setup.md).

## Why this is its own repository

It used to live inside `estiva-ship`, because that is where `lib/nostr/`,
`Store` and `foldFolder` already were. Gravity, not a decision — and the
consequence became visible the moment the agent learned to read Peek:
**Ship's repository contained Peek's kinds, and Ship's CI had an opinion about
Peek's wire format.**

That contradicts what this ecosystem exists to demonstrate. Apps here are meant
to be independent implementations that agree because they read the same relay,
not siblings sharing a package. Ship duplicated an entire protocol library on
that principle; the agent tooling quietly undid it.

An agent reads N apps. Whichever app hosts it, that app ends up knowing about
the other N−1. So it lives here, depending on no app repository — the same way
Peek and Ship depend on no app repository. (PEEK-155.)

## No signing key is ever held here

The key lives in Estiva ID. This process holds a client credential, exchanges it
for a short-lived token, and asks Estiva ID to sign each request. What the
credential may sign is decided server-side, per identity, by an administrator —
so "read-only" is a property of the credential rather than a promise this code
makes about itself.

Credentials load from `~/.estiva-agent.env`, or from the environment, which
wins. Nothing needs sourcing.

**Everything reads and writes production.** There is no staging workspace.

## Layout

| Path | What it is |
| --- | --- |
| `lib/agent/cli.ts` | Credentials, relay, argument parsing, output, exit codes. **Names no kind, tag or object type.** |
| `lib/agent/apps/` | One module per app. Everything that knows Ship has projects, or that Peek has topics. |
| `lib/agent/resolve.ts` | One rule for turning what a person typed into one object, or refusing. |
| `lib/nostr/`, `src/` | The protocol layer, **vendored from `estiva-ship`** — see below. |
| `scripts/` | The surfaces: CLI, MCP server, probes, tests. |
| `extension/` | The Claude Desktop extension manifest. |
| `conformance/` | The recorded fold both repositories must agree with. |

## The vendored copy, and what keeps it honest

`lib/nostr/` and `src/` are duplicated from `estiva-ship`, at identical paths so
that `diff -r` is a drift check anybody can run:

```bash
diff -r ../estiva-ship/src src
diff -r ../estiva-ship/lib/nostr lib/nostr
```

Duplication is deliberate — it is the same argument Ship makes for duplicating
the protocol library rather than depending on a package. What it risks is drift,
and the specific drift that matters is named in Ship's own CLAUDE.md: the CLI
disagreeing with the app is *the one thing it must not do*.

That is not hypothetical. PEEK-165 found exactly this drift **inside a single
repository**: the agent had reimplemented the surrounding behaviour of Ship's UI
and omitted the part that resolves a public key in a change value, so the app
said "Claude set assignee to Claude" and the agent said a hex string. Nothing
failed; both were self-consistent; it surfaced only when a person read the two
outputs side by side.

So the copies are held to a recorded agreement. `conformance/fold-fixture.json`
holds real production events plus the cases production cannot contain, and
`scripts/conformance.test.ts` — identical in both repos — folds them and
compares. If either side's fold changes, that side's CI fails.

The adversarial half of that fixture exists because the first draft did not
work. Recorded from production alone, it passed unchanged when the fold's `ts`
trust window was widened from one second to five: all 49 recorded changes
carried a `ts`, none outside the window, and only two shared a `created_at`.
Which is obvious in hindsight — `orderingMs` defends against a client trying to
make its write always win, and a healthy workspace contains no such write. **A
fixture recorded from a well-behaved system tests a well-behaved system.**

## Adding an app

A sibling module in `lib/agent/apps/`, and one line in `scripts/agent.ts`. If a
change makes a second app touch a generic file, the seam has leaked.

Whether that module can ever be *generic* — read from a NIP-89 manifest rather
than written by hand — is measured by `npm run probe:manifest`. The answer today
is that rendering and acting work from a manifest alone, and discovery does not:
nothing declares which kind is the unit of work, how to reach an object's
parent, or how to scope a query to a container. Written up in peek-app's
`docs/buzz-compat/RFC_UPDATES.md` §3 (PEEK-150).

## Before adding anything that writes

Read [`docs/untrusted-content.md`](docs/untrusted-content.md). Every string the
relay returns was written by somebody else, and the constraint that places on
writes is far cheaper to design for than to retrofit.

Two rules from it that are already load-bearing here:

- **Each command changes exactly one object.** There is deliberately no way to
  express "close everything matching X". Tool shape is the containment.
- **No error message contains a command to run.** Claude Desktop once met one,
  correctly read shell commands arriving through tool output as indistinguishable
  from a prompt injection, and refused. Error text states what is wrong and where.
