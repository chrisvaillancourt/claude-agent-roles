import { describe, expect, test } from 'claude-code/testing'

import { applyEdit, bindingFor, parseRouting, resolveRole, serializeRouting } from './routing'
import type { Routing } from '../types'

const EXAMPLE = JSON.stringify({
  version: 1,
  roles: {
    fast: { model: 'claude-haiku-5-5', effort: 'low' },
    deep: { model: 'claude-opus-5-5', effort: 'high' },
    search: { role: 'fast' },
  },
  agents: {
    scout: { role: 'search' },
    reviewer: { role: 'deep', overrideCaller: true },
  },
})

function ok(text: string): Routing {
  const r = parseRouting(text)
  if (!r.ok) throw new Error(`expected valid routing, got ${r.errors.join('; ')}`)
  return r.routing
}

function errors(text: string): string {
  const r = parseRouting(text)
  if (r.ok) throw new Error('expected invalid routing')
  return r.errors.join('; ')
}

describe('parseRouting', () => {
  test('an empty value is an empty map', async () => {
    expect(ok('')).toEqual({ version: 1, roles: {}, agents: {} })
    expect(ok('   ')).toEqual({ version: 1, roles: {}, agents: {} })
  })

  test('reads roles, references and bindings', async () => {
    const r = ok(EXAMPLE)
    expect(resolveRole(r, 'search')).toEqual({ chain: ['search', 'fast'], model: 'claude-haiku-5-5', effort: 'low' })
    expect(bindingFor(r, 'reviewer')).toEqual({ role: 'deep', overrideCaller: true })
    expect(bindingFor(r, 'nobody')).toBeUndefined()
  })

  test('a lookup by user text never reaches the prototype', async () => {
    const r = ok(EXAMPLE)
    expect(bindingFor(r, 'constructor')).toBeUndefined()
    expect(bindingFor(r, '__proto__')).toBeUndefined()
    expect(resolveRole(r, 'toString')).toBeNull()
  })

  test('rejects text that is not JSON or not version 1', async () => {
    expect(errors('{nope')).toContain('not valid JSON')
    expect(errors('[]')).toContain('must be a JSON object')
    expect(errors('{"roles":{},"agents":{}}')).toContain('version must be 1')
    expect(errors('{"version":1,"roles":{},"agents":{},"extra":1}')).toContain('unknown key "extra"')
  })

  test('rejects a reference cycle, naming it', async () => {
    const text = JSON.stringify({ version: 1, roles: { a: { role: 'b' }, b: { role: 'a' } }, agents: {} })
    expect(errors(text)).toContain('cycle: a → b → a')
    const self = JSON.stringify({ version: 1, roles: { a: { role: 'a' } }, agents: {} })
    expect(errors(self)).toContain('cycle: a → a')
  })

  test('rejects unknown roles, bad efforts, bad models and mixed role entries', async () => {
    const make = (roles: unknown, agents: unknown = {}) => JSON.stringify({ version: 1, roles, agents })
    expect(errors(make({ a: { role: 'missing' } }))).toContain('role "a" refers to unknown role "missing"')
    expect(errors(make({}, { scout: { role: 'missing' } }))).toContain('agent "scout" is bound to unknown role "missing"')
    expect(errors(make({ a: { effort: 'turbo' } }))).toContain('role "a": effort must be one of low, medium, high, xhigh, max')
    expect(errors(make({ a: { model: '' } }))).toContain('role "a": model must be')
    expect(errors(make({ a: { model: 'has space' } }))).toContain('role "a": model must be')
    expect(errors(make({ a: { role: 'b', effort: 'low' }, b: {} }))).toContain('role "a": a reference ({"role"}) takes no model or effort')
    expect(errors(make({ 'bad name!': {} }))).toContain('role name "bad name!"')
    expect(errors(make({ a: {} }, { scout: { role: 'a', overrideCaller: 'yes' } }))).toContain('agent "scout": overrideCaller must be true')
  })

  test('lists every error, not just the first', async () => {
    const text = JSON.stringify({ version: 1, roles: { a: { effort: 'x' }, b: { role: 'c' } }, agents: {} })
    const r = parseRouting(text)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.length).toBe(2)
  })
})

describe('applyEdit', () => {
  test('set creates or replaces a role; - leaves a field native; @name makes a reference', async () => {
    const r = ok(EXAMPLE)
    const a = applyEdit(r, { kind: 'set', role: 'mid', model: 'sonnet', effort: 'medium' })
    expect(a.ok && a.routing.roles.mid).toEqual({ model: 'sonnet', effort: 'medium' })
    const b = applyEdit(r, { kind: 'set', role: 'fast', model: '-', effort: 'low' })
    expect(b.ok && b.routing.roles.fast).toEqual({ effort: 'low' })
    const c = applyEdit(r, { kind: 'set', role: 'fast', model: '@deep' })
    expect(c.ok && resolveRole(c.routing, 'search')).toEqual({ chain: ['search', 'fast', 'deep'], model: 'claude-opus-5-5', effort: 'high' })
  })

  test('an edit that would make the map invalid is rejected and changes nothing', async () => {
    const r = ok(EXAMPLE)
    const before = serializeRouting(r)
    const cyc = applyEdit(r, { kind: 'set', role: 'fast', model: '@search' })
    expect(cyc.ok).toBe(false)
    if (!cyc.ok) expect(cyc.errors.join()).toContain('cycle')
    const bad = applyEdit(r, { kind: 'bind', agent: 'x', role: 'nope', override: false })
    expect(bad.ok).toBe(false)
    const eff = applyEdit(r, { kind: 'set', role: 'fast', model: 'haiku', effort: 'turbo' })
    expect(eff.ok).toBe(false)
    expect(serializeRouting(r)).toBe(before)
  })

  test('bind and unbind', async () => {
    const r = ok(EXAMPLE)
    const a = applyEdit(r, { kind: 'bind', agent: 'my-plugin:runner', role: 'deep', override: true })
    expect(a.ok && bindingFor(a.routing, 'my-plugin:runner')).toEqual({ role: 'deep', overrideCaller: true })
    const b = applyEdit(r, { kind: 'unbind', agent: 'scout' })
    expect(b.ok && bindingFor(b.routing, 'scout')).toBeUndefined()
    const c = applyEdit(r, { kind: 'unbind', agent: 'ghost' })
    expect(c.ok).toBe(false)
    if (!c.ok) expect(c.errors[0]).toContain('"ghost" has no binding')
  })

  test('serialize round-trips', async () => {
    const r = ok(EXAMPLE)
    expect(ok(serializeRouting(r))).toEqual(r)
  })
})
