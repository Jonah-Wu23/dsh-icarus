// Host call contract (found in the M2 acceptance run): `sessionController.prompt` takes an
// AbortSignal that the host gateway dereferences unconditionally (`signal.throwIfAborted()`), so
// the executor must pass one. The harness stub now enforces the same requirement, which is what
// makes an omitted argument fail in node:test instead of only in the real host.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createExecution } from '../lib/execution/index.js'
import { baseMission, goodResult, makeDue, openHarness } from './helpers/execution-harness.js'

function executionOf(harness, options = {}) {
  return createExecution({
    ctx: harness.ctx,
    database: harness.database,
    missions: harness.missions,
    bot: 'Chief',
    dshHome: harness.dshHome,
    now: harness.now,
    deliveryTimeoutMs: 500,
    ...options,
  })
}

async function until(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  return predicate()
}

test('the prompt is admitted with an AbortSignal, and the Run only succeeds because it is', async t => {
  const harness = openHarness(t, { text: goodResult(['含来源引用']), usage: { inputTokens: 20, outputTokens: 10 } })
  const execution = executionOf(harness)
  const mission = harness.missions.create(baseMission({ budget: 1_000 }))
  makeDue(harness.database, mission.id, harness.now())

  const report = await execution.runs.tick()
  // A run that reached succeeded proves the prompt was admitted: the harness stub rejects a call
  // without a signal, exactly as the real gateway does.
  assert.deepEqual(report.outcomes.map(outcome => outcome.status), ['succeeded'])
  assert.equal(harness.host.promptSignals.length, 2, 'the result prompt and the requirement check')
  for (const signal of harness.host.promptSignals) {
    assert.ok(signal instanceof AbortSignal, 'every prompt gets an AbortSignal')
    assert.equal(signal.aborted, false, 'neither admission was cancelled')
  }
})

test('unloading aborts an admission still in flight and the Run ends abandoned', async t => {
  const harness = openHarness(t, {})
  const execution = executionOf(harness)
  const mission = harness.missions.create(baseMission({ budget: 1_000 }))
  makeDue(harness.database, mission.id, harness.now())
  const run = execution.store.enqueueDue(mission.id)

  let admission
  harness.host.onPrompt = async (request, host) => {
    if (!request.sessionId.startsWith('session-run-')) return { accepted: true }
    admission = host.promptSignals.at(-1)
    // The gateway's own line: it throws once the caller's lifetime is aborted.
    await new Promise(resolve => admission.addEventListener('abort', resolve, { once: true }))
    admission.throwIfAborted()
    return { accepted: true }
  }

  const pending = execution.executor.execute(run.id)
  assert.equal(await until(() => admission !== undefined), true, 'the prompt was reached')
  assert.equal(admission.aborted, false)

  execution.executor.dispose()
  const outcome = await pending
  assert.equal(outcome.status, 'abandoned')
  assert.equal(admission.aborted, true, 'unload aborts the admission signal')
})
