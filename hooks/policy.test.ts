import { describe, expect, test } from 'claude-code/testing'

import {
  INITIAL,
  configFrom,
  denyReason,
  effortControl,
  isActive,
  isUntyped,
  logLine,
  parseCommand,
  recentText,
  resolveRoute,
  statusText,
  typedAlternatives,
  untypedNote,
} from './policy'
import type { RouteRecord } from '../types'

const ROUTING = JSON.stringify({
  version: 1,
  roles: {
    fast: { model: 'claude-haiku-5-5', effort: 'low' },
    deep: { model: 'claude-opus-5-5', effort: 'high' },
    search: { role: 'fast' },
    modelOnly: { model: 'sonnet' },
  },
  agents: {
    scout: { role: 'search' },
    worker: { role: 'fast' },
    reviewer: { role: 'deep', overrideCaller: true },
    plain: { role: 'modelOnly' },
  },
})

const cfg = (extra: Record<string, unknown> = {}) => configFrom({ routing: ROUTING, ...extra })
const typed = (type: string, more: object = {}) => ({ type, untyped: isUntyped(type), ...more })

describe('configFrom', () => {
  test('defaults: on, warn, no default role, empty map', async () => {
    const c = configFrom({})
    expect(c.enabled).toBe(true)
    expect(c.untypedPolicy).toBe('warn')
    expect(c.defaultRole).toBe('')
    expect(c.routing).toEqual({ ok: true, routing: { version: 1, roles: {}, agents: {} } })
  })

  test('a defaultRole the map lacks makes the config invalid', async () => {
    const c = cfg({ defaultRole: 'nope' })
    expect(c.routing.ok).toBe(false)
    if (!c.routing.ok) expect(c.routing.errors).toEqual(['defaultRole "nope" is not a role in routing'])
    expect(cfg({ defaultRole: 'deep' }).routing.ok).toBe(true)
  })

  test('an unknown untypedPolicy reads as the default', async () => {
    expect(configFrom({ untypedPolicy: 'deny' }).untypedPolicy).toBe('deny')
    expect(configFrom({ untypedPolicy: 'bogus' }).untypedPolicy).toBe('warn')
  })

  test('a session override beats the enabled option', async () => {
    expect(isActive(configFrom({}), INITIAL)).toBe(true)
    expect(isActive(configFrom({ enabled: false }), INITIAL)).toBe(false)
    expect(isActive(configFrom({ enabled: false }), { mode: 'on' })).toBe(true)
    expect(isActive(configFrom({}), { mode: 'off' })).toBe(false)
  })
})

describe('resolveRoute', () => {
  test('two agents bound through one role both follow it', async () => {
    const a = resolveRoute(cfg(), typed('scout'))
    const b = resolveRoute(cfg(), typed('worker'))
    expect(a).toEqual({ role: 'search', model: 'claude-haiku-5-5', effort: 'low', source: 'binding', reason: 'bound to search (search → fast)' })
    expect(b).toEqual({ role: 'fast', model: 'claude-haiku-5-5', effort: 'low', source: 'binding', reason: 'bound to fast' })
  })

  test('an unbound typed agent stays native', async () => {
    expect(resolveRoute(cfg(), typed('Explore'))).toEqual({ role: null, source: 'native', reason: 'no binding' })
  })

  test("a caller's model keeps the caller's whole choice unless the binding overrides", async () => {
    const kept = resolveRoute(cfg(), typed('scout', { callerModel: 'opus', callerEffort: 'max' }))
    expect(kept.source).toBe('caller')
    expect(kept.model).toBeUndefined()
    expect(kept.effort).toBeUndefined()
    expect(kept.reason).toContain('the call named model opus')

    const over = resolveRoute(cfg(), typed('reviewer', { callerModel: 'haiku', callerEffort: 'low' }))
    expect(over).toEqual({ role: 'deep', model: 'claude-opus-5-5', effort: 'high', source: 'binding', reason: 'bound to deep; overrides the call' })
  })

  test("a caller's effort alone wins over the role's effort, not its model", async () => {
    const r = resolveRoute(cfg(), typed('scout', { callerEffort: 'high' }))
    expect(r.model).toBe('claude-haiku-5-5')
    expect(r.effort).toBeUndefined()
    expect(r.reason).toContain('effort from the call')
  })

  test('a role field left out sets nothing', async () => {
    const r = resolveRoute(cfg(), typed('plain'))
    expect(r.model).toBe('sonnet')
    expect('effort' in r).toBe(false)
  })

  test('untyped spawns use defaultRole only when set, and only for untyped', async () => {
    expect(resolveRoute(cfg(), typed('general-purpose')).source).toBe('native')
    const r = resolveRoute(cfg({ defaultRole: 'fast' }), typed('general-purpose'))
    expect(r).toEqual({ role: 'fast', model: 'claude-haiku-5-5', effort: 'low', source: 'default-role', reason: 'defaultRole fast' })
    expect(resolveRoute(cfg({ defaultRole: 'fast' }), typed('Explore')).source).toBe('native')
    // A default role never overrides an explicit caller model.
    expect(resolveRoute(cfg({ defaultRole: 'fast' }), typed('general-purpose', { callerModel: 'opus' })).source).toBe('caller')
  })

  test('forks are never routed', async () => {
    expect(resolveRoute(cfg(), { type: 'scout', untyped: false, fork: true }).source).toBe('fork')
  })

  test('an invalid map routes nothing and says so', async () => {
    const r = resolveRoute(configFrom({ routing: '{bad' }), typed('scout'))
    expect(r.source).toBe('invalid-config')
    expect(r.model).toBeUndefined()
    expect(r.effort).toBeUndefined()
    expect(r.reason).toContain('routing option is invalid')
  })
})

describe('effortControl', () => {
  test('says whose effort a spawn ran with', async () => {
    const route = resolveRoute(cfg(), typed('scout'))
    expect(effortControl({ route, hasSnapshot: true })).toBe('set')
    expect(effortControl({ route, hasSnapshot: false })).toBe('not-controlled')
    const caller = resolveRoute(cfg(), typed('scout', { callerEffort: 'max' }))
    expect(effortControl({ route: caller, hasSnapshot: true, callerEffort: 'max' })).toBe('caller')
    expect(effortControl({ route: resolveRoute(cfg(), typed('Explore')), hasSnapshot: true })).toBe('native')
    expect(effortControl({ route: resolveRoute(cfg(), { type: 'x', untyped: false, fork: true }), hasSnapshot: true })).toBe('inherited')
  })
})

const RECORD: RouteRecord = {
  at: 0,
  type: 'scout',
  untyped: false,
  role: 'search',
  source: 'binding',
  reason: 'bound to search (search → fast)',
  setModel: 'claude-haiku-5-5',
  effort: 'low',
  effortControl: 'set',
  resolvedModel: 'claude-haiku-5-5',
  agentId: 'a1',
}

describe('texts', () => {
  test('one concise log line per spawn', async () => {
    expect(logLine(RECORD)).toBe('agent-roles: scout → search → asked -/- → claude-haiku-5-5, effort low set (binding)')
    expect(
      logLine({ ...RECORD, type: 'general-purpose', untyped: true, role: null, source: 'native', reason: 'untyped; no defaultRole', setModel: undefined, effort: undefined, effortControl: 'native', resolvedModel: 'claude-opus-5-5' }),
    ).toBe('agent-roles: general-purpose [untyped] → no role → asked -/- → claude-opus-5-5, effort native (native)')
    expect(logLine({ ...RECORD, callerModel: 'opus', callerEffort: 'max', source: 'caller', effortControl: 'caller', effort: undefined, setModel: undefined })).toBe(
      'agent-roles: scout → search → asked opus/max → claude-haiku-5-5, effort max (caller) (caller)',
    )
    expect(logLine({ ...RECORD, effortControl: 'not-controlled', effort: undefined })).toContain('effort not controlled')
    expect(logLine({ ...RECORD, source: 'invalid-config', role: null })).toContain('(invalid-config: routing option is invalid, see /roles)')
    expect(logLine({ ...RECORD, resolvedModel: null, denied: 'untypedPolicy deny' })).toContain('→ refused: untypedPolicy deny')
  })

  test('typed alternatives: bindings first, then offered types, never untyped ones', async () => {
    const alts = typedAlternatives(cfg(), ['Explore', 'general-purpose', 'fork', 'scout', 'Plan'])
    expect(alts).toEqual(['scout', 'worker', 'reviewer', 'plain', 'Explore', 'Plan'])
    expect(typedAlternatives(configFrom({}), [])).toEqual([])
  })

  test('the untyped note and the deny reason name the alternatives and do not mention thinking', async () => {
    const note = untypedNote({ ...RECORD, type: 'general-purpose', untyped: true, effortControl: 'native', resolvedModel: 'claude-opus-5-5' }, ['scout', 'worker'])
    expect(note).toContain('general-purpose')
    expect(note).toContain('claude-opus-5-5')
    expect(note).toContain('subagent_type: scout, worker')
    expect(note.toLowerCase()).not.toContain('think')
    expect(note.toLowerCase()).not.toContain('reason')
    const deny = denyReason('general-purpose', ['scout'])
    expect(deny).toContain('untypedPolicy')
    expect(deny).toContain('scout')
    expect(denyReason('general-purpose', [])).toContain('typed subagent_type')
  })

  test('/roles shows the map, the effective routes and the limits', async () => {
    const text = statusText(cfg(), INITIAL)
    expect(text).toContain('on (from the enabled option)')
    expect(text).toContain('untypedPolicy warn')
    expect(text).toContain('search → @fast → claude-haiku-5-5, effort low')
    expect(text).toContain('reviewer → deep (overrides the caller) → claude-opus-5-5, effort high')
    expect(text).toContain('plain → modelOnly → sonnet, effort native')
    expect(text).toContain('Limits:')
    const bad = statusText(configFrom({ routing: '{"version":2}' }), INITIAL)
    expect(bad).toContain('The routing option is invalid; nothing is routed')
    expect(bad).toContain('version must be 1')
  })

  test('/roles recent lists newest first', async () => {
    expect(recentText([])).toBe('No spawns recorded in this session yet.')
    const t = recentText([RECORD, { ...RECORD, type: 'worker', at: 1 }])
    expect(t.indexOf('worker')).toBeLessThan(t.indexOf('scout'))
  })
})

describe('parseCommand', () => {
  test('reads every subcommand and rejects the rest', async () => {
    expect(parseCommand('')).toEqual({ kind: 'show' })
    expect(parseCommand('show')).toEqual({ kind: 'show' })
    expect(parseCommand('recent')).toEqual({ kind: 'recent' })
    expect(parseCommand(' OFF ')).toEqual({ kind: 'mode', mode: 'off' })
    expect(parseCommand('set fast haiku low')).toEqual({ kind: 'edit', edit: { kind: 'set', role: 'fast', model: 'haiku', effort: 'low' } })
    expect(parseCommand('set fast @deep')).toEqual({ kind: 'edit', edit: { kind: 'set', role: 'fast', model: '@deep' } })
    expect(parseCommand('bind scout fast')).toEqual({ kind: 'edit', edit: { kind: 'bind', agent: 'scout', role: 'fast', override: false } })
    expect(parseCommand('bind scout fast override')).toEqual({ kind: 'edit', edit: { kind: 'bind', agent: 'scout', role: 'fast', override: true } })
    expect(parseCommand('unbind scout')).toEqual({ kind: 'edit', edit: { kind: 'unbind', agent: 'scout' } })
    expect(parseCommand('set fast')).toEqual({ kind: 'help', error: 'set takes ROLE MODEL [EFFORT]' })
    expect(parseCommand('bind scout fast loudly')).toEqual({ kind: 'help', error: 'bind takes AGENT ROLE [override]' })
    expect(parseCommand('bogus')).toEqual({ kind: 'help', error: 'Unknown subcommand: bogus' })
  })
})
