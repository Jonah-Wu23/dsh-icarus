// Minimal verification of Bot identity resolution against a fake DS Bot state file.
// Runs against the built plugin: `pnpm build` first, then `pnpm test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveIdentity, statePathOf } from '../lib/bridge/identity.js'

// `session-...-a` is a Bot's first own-chat segment and never changes; `session-...-c`
// stands for the fresh segment a long conversation moved on to.
const BOTS = {
  'session-0001': { id: 'session-0001', name: 'Chief', role: 'Chief of Staff' },
  'session-0002': { id: 'session-0002', name: 'Dev', role: 'DEV', sessionId: 'session-0003', segments: [] },
}

async function fakeDshHome(t, bots = BOTS) {
  const home = await mkdtemp(join(tmpdir(), 'icarus-identity-'))
  await mkdir(join(home, 'bot'), { recursive: true })
  await writeFile(join(home, 'bot', 'state.json'), JSON.stringify({ version: 1, bots }))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

test('statePathOf follows DSH_HOME and falls back to ~/.dsh', () => {
  assert.match(statePathOf({ env: { DSH_HOME: 'E:\\fake-dsh' } }), /fake-dsh[\\/]bot[\\/]state\.json$/)
  assert.match(statePathOf({ env: {} }), /\.dsh[\\/]bot[\\/]state\.json$/)
})

test('resolves a Bot by name and defaults a missing sessionId to the Bot id', async t => {
  const dshHome = await fakeDshHome(t)
  assert.deepEqual(await resolveIdentity('Chief', { dshHome }), {
    botId: 'session-0001',
    sessionId: 'session-0001',
    name: 'Chief',
  })
})

test('resolves a Bot by id and uses its current own-chat segment', async t => {
  const dshHome = await fakeDshHome(t)
  assert.deepEqual(await resolveIdentity('session-0002', { dshHome }), {
    botId: 'session-0002',
    sessionId: 'session-0003',
    name: 'Dev',
  })
})

test('re-reads the state file on every call, so a new chat segment is picked up', async t => {
  const dshHome = await fakeDshHome(t)
  const before = await resolveIdentity('Dev', { dshHome })
  await writeFile(join(dshHome, 'bot', 'state.json'), JSON.stringify({
    version: 1,
    bots: { ...BOTS, 'session-0002': { ...BOTS['session-0002'], sessionId: 'session-0009' } },
  }))
  const after = await resolveIdentity('Dev', { dshHome })
  assert.equal(before.sessionId, 'session-0003')
  assert.equal(after.sessionId, 'session-0009')
})

test('an unknown Bot and a missing state file keep their original errors', async t => {
  const dshHome = await fakeDshHome(t)
  await assert.rejects(resolveIdentity('Nobody', { dshHome }), /no Bot "Nobody".*known Bots: Chief, Dev/)
  await assert.rejects(resolveIdentity('Chief', { dshHome: join(dshHome, 'absent') }), /ENOENT/)
})
