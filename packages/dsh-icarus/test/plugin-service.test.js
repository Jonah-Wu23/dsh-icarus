// Plugin assembly: `apply` must open the database, publish the Mission service as
// `ctx.icarus`, and close the connection when the plugin unloads. Uses a fake context, so
// no host is needed and nothing is delivered.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

test('apply publishes ctx.icarus.missions and closes the database on unload', t => {
  const dshHome = mkdtempSync(join(tmpdir(), 'icarus-plugin-'))
  t.after(() => rmSync(dshHome, { recursive: true, force: true }))

  const provided = new Map()
  const effects = []
  const logs = []
  const ctx = {
    logger: {
      info: (...args) => logs.push(args),
      warn: (...args) => logs.push(args),
      error: (...args) => logs.push(args),
      debug: () => {},
    },
    sessionController: { prompt: async () => ({ accepted: true }) },
    effect: (execute, label) => {
      effects.push({ label, dispose: execute() })
    },
    provide: (name, value) => {
      provided.set(name, value)
      return () => provided.delete(name)
    },
  }

  apply(ctx, { dshHome, demo: { onBoot: false } })

  assert.deepEqual([...provided.keys()], ['icarus'])
  assert.match(String(logs[0]?.[0]), /icarus: loaded/)
  assert.deepEqual(effects.map(effect => effect.label), ['icarus: storage'])

  const service = provided.get('icarus')
  assert.equal(typeof service.missions.create, 'function')
  const mission = service.missions.create({
    ownerBotId: 'session-bot-1',
    kind: 'recurring',
    objective: 'arXiv cs.AI 每日摘要',
    requirements: ['含来源引用'],
    schedule: { kind: 'daily', time: '21:00' },
    timezone: 'Asia/Singapore',
    budget: 1_000,
  })
  assert.equal(service.missions.get(mission.id).revision, 1)
  assert.equal(service.missions.history(mission.id).length, 1)
  assert.ok(service.missions.get(mission.id).nextDueAt > Date.now() - 60_000)
  assert.ok(existsSync(join(dshHome, 'icarus', 'icarus.sqlite')))

  for (const effect of effects.splice(0)) effect.dispose()
  assert.throws(() => service.missions.list(), /database is not open/)
  // The handle is closed for real: the data directory can be deleted while the test runs.
  rmSync(join(dshHome, 'icarus'), { recursive: true, force: true })
  assert.equal(existsSync(join(dshHome, 'icarus')), false)
})
