// Plugin assembly: `apply` must open the database, publish the Mission and Run services as
// `ctx.icarus`, register the scheduling pass, and close the connection when the plugin
// unloads. Uses a fake context, so no host is needed and nothing is delivered.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject } from '../lib/index.js'

test('apply publishes ctx.icarus.missions and ctx.icarus.runs, then closes on unload', async t => {
  const dshHome = mkdtempSync(join(tmpdir(), 'icarus-plugin-'))
  t.after(() => rmSync(dshHome, { recursive: true, force: true }))

  const provided = new Map()
  const effects = []
  const intervals = []
  const logs = []
  const ctx = {
    logger: {
      info: (...args) => logs.push(args),
      warn: (...args) => logs.push(args),
      error: (...args) => logs.push(args),
      debug: () => {},
    },
    sessionController: { prompt: async () => ({ accepted: true }) },
    tools: { register: () => () => {} },
    on: () => {},
    interval: (callback, delay) => {
      intervals.push({ callback, delay })
      return () => {}
    },
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
  assert.deepEqual([...inject], ['sessionController', 'timer', 'llm', 'sessions', 'sessionQuery', 'agents', 'tools', 'credentials'])
  assert.match(String(logs[0]?.[0]), /icarus: loaded/)
  assert.deepEqual(effects.map(effect => effect.label), ['icarus: execution and storage'])
  assert.deepEqual(intervals.map(interval => interval.delay).sort((a, b) => a - b), [1_000, 1_000, 1_000, 30_000],
    'source poll, delivery scan, scheduling pass and capability refresh')
  assert.ok(existsSync(join(dshHome, 'icarus', 'icarus.sqlite')))

  const service = provided.get('icarus')
  const mission = service.missions.create({
    ownerBotId: 'session-bot-1',
    kind: 'recurring',
    objective: 'arXiv cs.AI 每日摘要',
    requirements: ['含来源引用'],
    schedule: { kind: 'daily', time: '21:00' },
    timezone: 'Asia/Singapore',
    budget: 1_000,
  })
  assert.equal(service.missions.history(mission.id).length, 1)
  assert.deepEqual(service.runs.list(), [])
  const report = await service.runs.tick()
  assert.deepEqual({ ...report, at: 0 }, { at: 0, enqueued: [], outcomes: [], recovered: { superseded: [], requeued: [] }, errors: [] }, 'nothing is due yet')

  for (const effect of effects.splice(0)) await effect.dispose()
  assert.throws(() => service.missions.list(), /database is not open/)
  assert.throws(() => service.runs.list(), /database is not open/)
  rmSync(join(dshHome, 'icarus'), { recursive: true, force: true })
  assert.equal(existsSync(join(dshHome, 'icarus')), false)
})
