// Shared harness for the execution tests: a temp data home with a fake Bot roster, a fake
// host context (logger, sessionController, session/event, interval, provide) and helpers for
// emitting turn events. Not a test file: the runner only picks up `*.test.js`.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMissionService } from '../../lib/domain/index.js'
import { openDatabase } from '../../lib/storage/index.js'

export const NOW = Date.parse('2026-10-14T12:00:00.000Z')
export const CHIEF_SESSION = 'session-chief'

export function assistantEvent(text, usage) {
  return {
    type: 'assistant/message',
    time: 0,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      stream: [],
      ...(usage === undefined ? {} : { usage }),
    },
  }
}

export function turnEndEvent(reason) {
  return { type: 'turn/end', time: 0, data: { turn: 1, reason } }
}

/** `approval/asked`: the host's audit of one request, `{ id, toolName, callId?, reason? }`. */
export function approvalAskedEvent({ id, toolName, callId, reason }) {
  return {
    type: 'approval/asked',
    time: 0,
    data: { id, toolName, ...(callId === undefined ? {} : { callId }), ...(reason === undefined ? {} : { reason }) },
  }
}

/** `approval/decided`: `{ id, outcome }` over the host's closed vocabulary. */
export function approvalDecidedEvent(id, outcome) {
  return { type: 'approval/decided', time: 0, data: { id, outcome } }
}

/** `tool/call`: what the failure archive uses to name the tool a result came from. */
export function toolCallEvent(callId, name, args = {}) {
  return { type: 'tool/call', time: 0, data: { turn: 1, step: 1, callId, name, arguments: args } }
}

/** `tool/result` for a failed call: the message the model sees, plus the host's `error.info`. */
export function toolErrorEvent(callId, text, info) {
  return {
    type: 'tool/result',
    time: 0,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text }],
        isError: true,
      },
      ...(info === undefined ? {} : { error: info }),
    },
  }
}

/** The Run id an execution Session belongs to, as the plugin recorded it. */
export function runIdOfSession(harness, sessionId) {
  return harness.database.db.prepare('SELECT id FROM Run WHERE sessionId = ?').get(sessionId).id
}

/** Emit one completed turn for a Session. */
export function completeTurn(host, sessionId, text, usage) {
  host.emit(sessionId, assistantEvent(text, usage))
  host.emit(sessionId, turnEndEvent({ kind: 'completed' }))
}

/** A result that satisfies the M2.3 structural rules for the given requirements. */
export function goodResult(requirements = []) {
  const sections = requirements.map(requirement => `## ${requirement}\n\n${'这一条要求的回应正文足够长，包含具体结论与依据。'.repeat(3)}`).join('\n\n')
  return `背景与结论\n\n${'本次成果正文覆盖委托目标，并给出可核对的事实与判断。'.repeat(10)}\n\n${sections}\n\n来源：https://arxiv.org/abs/2610.00001\n`
}

/** Writes the Bot roster so `resolveIdentity('Chief')` resolves, and returns the fake host. */
export function createFakeHost(options = {}) {
  const listeners = []
  const prompts = []
  const created = []
  const logs = []
  const intervals = []
  const provided = new Map()
  const effects = []
  let sequence = 0

  const host = { prompts, created, logs, intervals, provided, effects }
  host.emit = (sessionId, event) => {
    for (const entry of listeners) entry.listener({ id: sessionId }, event)
  }
  host.logged = level => logs.filter(entry => entry[0] === level).map(entry => entry.slice(1).join(' '))
  host.onPrompt = options.onPrompt ?? (async request => {
    queueMicrotask(() => completeTurn(host, request.sessionId, options.text ?? goodResult(options.requirements ?? []), options.usage))
    return { accepted: true }
  })
  host.ctx = {
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
      debug: () => {},
    },
    sessionController: {
      async create(request) {
        created.push(request)
        sequence += 1
        return { sessionId: `session-run-${sequence}` }
      },
      async prompt(request) {
        prompts.push(request)
        return host.onPrompt(request, host)
      },
    },
    on(event, listener) {
      if (event === 'session/event') listeners.push({ listener })
    },
    interval(callback, delay) {
      intervals.push({ callback, delay })
      return () => {}
    },
    effect(execute) {
      effects.push(execute())
    },
    provide(name, value) {
      provided.set(name, value)
    },
  }
  return host
}

/** A temp DSH home with the Bot roster, an open database, a Mission service and a fake host. */
export function openHarness(t, options = {}) {
  const dshHome = mkdtempSync(join(tmpdir(), 'icarus-exec-'))
  mkdirSync(join(dshHome, 'bot'), { recursive: true })
  writeFileSync(
    join(dshHome, 'bot', 'state.json'),
    JSON.stringify({ version: 1, bots: { [CHIEF_SESSION]: { id: CHIEF_SESSION, name: 'Chief', role: 'Chief of Staff' } } }),
  )
  const database = openDatabase({ dshHome })
  const clock = { at: options.now ?? NOW }
  const now = () => clock.at
  const missions = createMissionService(database, { now })
  const host = createFakeHost(options)
  t.after(() => {
    database.close()
    rmSync(dshHome, { recursive: true, force: true })
  })
  return { dshHome, database, clock, now, missions, host, ctx: host.ctx }
}

/** Force a Mission to be due (tests only; production advances nextDueAt through the scheduler). */
export function makeDue(database, missionId, at) {
  database.db.prepare('UPDATE Mission SET nextDueAt = ? WHERE id = ?').run(at, missionId)
}

export function baseMission(overrides = {}) {
  return {
    ownerBotId: 'session-bot-1',
    kind: 'recurring',
    objective: 'arXiv cs.AI 每日摘要',
    requirements: ['含来源引用'],
    schedule: { kind: 'daily', time: '21:00' },
    timezone: 'Asia/Singapore',
    budget: 100_000,
    ...overrides,
  }
}
