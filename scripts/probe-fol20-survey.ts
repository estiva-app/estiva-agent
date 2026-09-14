/**
 * Survey for FOL-20: every unarchived project, where its record lives, where
 * its work is, and which Folders on the relay already carry a team name.
 *
 *   set -a; . ~/.estiva-agent.env; set +a
 *   npx tsx scripts/probe-fol20-survey.ts
 *
 * Read-only. Prints what the mapping proposal has to be built from, so it is
 * proposed from the relay's answer rather than from the project titles alone.
 */
import { connect } from '../lib/agent/cli'
import { Store } from '../src/store'

const TEAMS = ['Estiva HQ', 'Peek', 'Ship', 'Leaf', 'Steer']

const tag = (event: { tags: string[][] }, name: string) => event.tags.find((t) => t[0] === name)?.[1]

async function main() {
  const context = await connect()
  const store = new Store(context.relay, context.signer)
  const state = await store.loadAll()

  // Folder names: the channel metadata (39000) is what names a Folder; 9007 is
  // the create event and carries the name too, for Folders created by an app.
  const [channels, creates, states] = await Promise.all([
    context.relay.queryAll([{ kinds: [39000], limit: 500 }]),
    context.relay.queryAll([{ kinds: [9007], limit: 500 }]),
    context.relay.queryAll([{ kinds: [30890], limit: 500 }]),
  ])
  const names = new Map<string, string>()
  for (const e of creates) {
    const id = tag(e, 'h')
    if (id && !names.has(id)) names.set(id, tag(e, 'name') ?? '')
  }
  for (const e of channels) {
    const id = tag(e, 'd')
    if (id) names.set(id, tag(e, 'name') ?? names.get(id) ?? '')
  }
  const name = (id: string) => (names.has(id) ? `${names.get(id) || '(unnamed)'} ${id.slice(0, 8)}…` : `? ${id.slice(0, 8)}…`)

  console.log(`Folders named on the relay: ${names.size} (39000: ${channels.length}, 9007: ${creates.length}); folder state (30890): ${states.length}`)
  for (const team of TEAMS) {
    const hits = [...names].filter(([, n]) => n.trim().toLowerCase() === team.toLowerCase())
    console.log(`  team "${team}": ${hits.length ? hits.map(([id]) => id).join(', ') : 'no Folder with that name'}`)
  }

  const live = state.projects.filter((p) => !p.archived)
  console.log(`\nUnarchived projects: ${live.length} (archived: ${state.projects.length - live.length})\n`)
  for (const p of live) {
    const issues = state.issues.filter((i) => i.projectAddr === p.addr)
    const issueFolders = new Map<string, number>()
    for (const i of issues) issueFolders.set(i.folder, (issueFolders.get(i.folder) ?? 0) + 1)
    console.log(`${p.title}  [${p.status}]  author ${p.author.slice(0, 8)}…`)
    console.log(`   record  ${name(p.originFolder)}`)
    console.log(`   content ${name(p.contentFolder)}${p.contentFolder !== p.originFolder ? '  (relinked)' : ''}`)
    console.log(`   issues  ${issues.length} in ${[...issueFolders].map(([f, n]) => `${name(f)} ×${n}`).join(', ') || '—'}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
