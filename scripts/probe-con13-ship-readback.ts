/**
 * CON-13's done-when, Ship half, read back from production through Ship's own
 * read: `Store.loadAll` and then `commentsOn` / `mentionsOf` with the
 * `anchors` index — exactly what `IssuePage` and `ProjectPage` call — for one
 * address. Also counts, across the whole workspace, how many threads the
 * per-tag rule moves between the two lists compared with the old reading
 * (every root `a`/`A` tag as a comment). Read-only.
 *
 *   set -a; . ~/.estiva-agent.env; set +a
 *   npx tsx scripts/probe-con13-ship-readback.ts <address>
 */
import { connect } from '../lib/agent/cli'
import { Store } from '../src/store'
import { attachmentOf, commentsOn, mentionsOf, type AnchorIndex } from '../src/references'
import { KIND } from '../src/kinds'

async function main() {
  const address = process.argv[2]
  if (!address) throw new Error('usage: <address>')
  const context = await connect()
  const store = new Store(context.relay, context.signer)
  const state = await store.loadAll()
  console.log(`${state.conversations.length} conversations loaded as ${context.signer.pubkey.slice(0, 8)}…`)

  const comments = commentsOn(state.conversations, address, state.anchors)
  const mentions = mentionsOf(state.conversations, address, state.anchors)
  console.log(`\n${address}\n  comments: ${comments.length}\n  mentions: ${mentions.length}`)
  for (const c of mentions) console.log(`    mention ${c.root.id.slice(0, 8)} in ${c.root.folder.slice(0, 8)}… ${JSON.stringify(c.root.body.slice(0, 60))}`)

  // The old reading, for the delta: every `a` (and `A` on a 1111) on a root was a comment.
  const events = await context.relay.query([{ kinds: [KIND.MESSAGE, KIND.COMMENT], limit: 5000 }])
  const old: AnchorIndex = {}
  for (const e of events) {
    if (e.kind !== KIND.MESSAGE && e.kind !== KIND.COMMENT) continue
    const named = e.tags.filter((t) => (t[0] === 'a' || (e.kind === KIND.COMMENT && t[0] === 'A')) && t[1]).map((t) => t[1])
    if (named.length) old[e.id] = [...new Set(named)]
  }
  let demoted = 0
  const rows: string[] = []
  for (const c of state.conversations) {
    for (const about of c.about) {
      const was = attachmentOf(c, about, old)
      const now = attachmentOf(c, about, state.anchors)
      if (was === now) continue
      // A root the capped relay read did not return has no old reading; only the other direction is real.
      if (!old[c.root.id]) continue
      demoted += 1
      rows.push(`  ${was} → ${now}  ${c.root.id.slice(0, 8)} kind:${c.root.rootId ? '?' : ''} about ${about.split(':')[0]} ${JSON.stringify(c.root.body.slice(0, 50))}`)
    }
  }
  console.log(`\n${demoted} (thread, address) pair(s) change strength under the per-tag rule:`)
  for (const r of rows) console.log(r)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
