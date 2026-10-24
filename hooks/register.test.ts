import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const COMMAND = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }
const ENGINE = { plugin: 'engine', tier: 'core' as const }
const PARENT = 'claude-opus-5-5'

const ROUTING = JSON.stringify({
  version: 1,
  roles: {
    fast: { model: 'claude-haiku-5-5', effort: 'low' },
    deep: { model: 'claude-opus-5-5', effort: 'high' },
    search: { role: 'fast' },
  },
  agents: {
    scout: { role: 'search' },
    worker: { role: 'fast' },
    reviewer: { role: 'deep', overrideCaller: true },
  },
})

type Spawned = { tool_use_id: string; type: string; model?: string }
type Ran = { tool_use_id: string; type?: string; effort?: string; model?: string }

/**
 * The engine beneath the plugin. The Agent tool spawns through the engine's
 * own `agent.spawn` with the call's tool_use_id, as core does; a spawn
 * resolves `model` to the given one or the parent's.
 */
type WorldOpts = {
  denyConfig?: string
  toolDenies?: boolean
  /** The saved routing value the /config row holds; the test's routing option by default. */
  saved?: string
  /** The row's provider id: `agent-roles@inline` for a --plugin-dir load, `agent-roles@agent-roles` installed. */
  provider?: string
  /** A headless session on 2.1.310: $.config.list has no plugin rows and $.config.set rejects their keys. */
  noRows?: boolean
  /** Another plugin's config.set hook replaces the value written with this one. */
  clampTo?: string
}

function world($: any, on: On, opts: WorldOpts = {}) {
  const logs: string[] = []
  const spawned: Spawned[] = []
  const ran: Ran[] = []
  const configSets: { key: string; value: unknown }[] = []
  on('session.start', ($2, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's1' }))
  on('clock.now', () => ({ value: 1000 }))
  on('command.register', ($2, e) => ({ value: { command: e.name } }))
  on('ui.log', ($2, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  const saved = { value: opts.saved ?? ROUTING }
  const engineRow = { key: 'verbose', label: 'Verbose output', kind: 'boolean' as const, value: false, provider: ENGINE, isLocked: false }
  on('config.list', () => ({
    value: opts.noRows
      ? [engineRow]
      : [engineRow, { key: 'agent-roles.routing', label: 'Routing', kind: 'text' as const, value: saved.value, provider: { plugin: opts.provider ?? 'agent-roles@inline', tier: 'user' as const }, isLocked: false }],
  }))
  on('config.set', ($2, e) => {
    if (opts.noRows) return { deny: `no /config row with key ${e.key}` }
    if (opts.denyConfig) return { deny: opts.denyConfig }
    const value = opts.clampTo ?? e.value
    configSets.push({ key: e.key, value })
    saved.value = String(value)
    return { value }
  })
  on('agent.offer', () => ({ isOffered: true }))
  on('agent.spawn', ($2, e) => {
    spawned.push({ tool_use_id: e.tool_use_id, type: e.subagentType, model: e.model })
    return { model: e.fork ? PARENT : (e.model ?? PARENT), agentId: `agent-${spawned.length}` }
  })
  on('tool.call', async ($2, e) => {
    if (e.tool !== 'Agent') return { result: 'ok', text: 'ok' }
    ran.push({ tool_use_id: e.tool_use_id, type: e.subagent_type, effort: e.effort, model: e.model })
    if (opts.toolDenies) return { deny: 'refused by a hook below' }
    const s = await $.agent.spawn({
      tool_use_id: e.tool_use_id,
      prompt: e.prompt,
      description: e.description,
      subagentType: e.subagent_type ?? 'general-purpose',
      provider: ENGINE,
      parentModel: PARENT,
      background: false,
      fork: e.subagent_type === 'fork',
      ...(e.model !== undefined ? { model: e.model } : {}),
    })
    if (s.deny !== undefined) return { result: s.deny, text: s.deny, isError: true as const }
    const result = { status: 'completed', agentId: s.agentId, resolvedModel: s.model, content: [{ type: 'text', text: 'done' }], totalToolUseCount: 0, totalDurationMs: 1, totalTokens: 1, prompt: e.prompt, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null, cache_creation: null } }
    return { result: result as any, text: 'done' }
  })
  return { logs, spawned, ran, configSets, saved }
}

const start = ($: any) => $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
const agent = ($: any, subagent_type: string | undefined, more: object = {}) =>
  $.tool.call({ tool: 'Agent', prompt: 'do it', description: 'task', ...(subagent_type ? { subagent_type } : {}), ...more })
const roles = ($: any, args: string) => $.command.run({ command: 'roles', args, ...COMMAND })
/**
 * Whether a route snapshot is still held for the call: a direct spawn under
 * the same tool_use_id finds it (effort reads as set) or not (not controlled).
 */
async function pending($: any, w: { logs: string[] }, id: string) {
  await $.agent.spawn({ prompt: 'p', description: 'probe', provider: ENGINE, parentModel: PARENT, background: true, fork: false, tool_use_id: id, subagentType: 'scout' })
  return w.logs.at(-1)!.includes('effort not controlled') ? null : 'held'
}

const WITH = { options: { routing: ROUTING } }

describe('agent-roles: routing a spawn', () => {
  test('a bound agent gets the role effort on the call and the role model on the spawn', WITH, async ($, on) => {
    const w = world($, on)
    await start($)
    const r = await agent($, 'scout')
    expect(r.deny).toBeUndefined()
    expect(w.ran).toEqual([expect.objectContaining({ type: 'scout', effort: 'low' })])
    expect(w.spawned).toEqual([expect.objectContaining({ type: 'scout', model: 'claude-haiku-5-5' })])
    expect(w.spawned[0]!.tool_use_id).toBe(w.ran[0]!.tool_use_id)
    expect(w.logs).toContain('agent-roles: scout → search → asked -/- → claude-haiku-5-5, effort low set (binding)')
    expect(await pending($, w, w.ran[0]!.tool_use_id)).toBeNull()
  })

  test('an unbound typed agent is left alone but still logged', WITH, async ($, on) => {
    const w = world($, on)
    await start($)
    await agent($, 'Explore')
    expect(w.ran[0]!.effort).toBeUndefined()
    expect(w.spawned[0]!.model).toBeUndefined()
    expect(w.logs).toContain('agent-roles: Explore → no role → asked -/- → claude-opus-5-5, effort native (native)')
  })

  test("a caller's model keeps the caller's choice; overrideCaller replaces it", WITH, async ($, on) => {
    const w = world($, on)
    await start($)
    await agent($, 'scout', { model: 'opus', effort: 'max' })
    await agent($, 'reviewer', { model: 'haiku', effort: 'low' })
    expect(w.ran[0]).toEqual(expect.objectContaining({ effort: 'max', model: 'opus' }))
    expect(w.spawned[0]!.model).toBe('opus')
    expect(w.ran[1]).toEqual(expect.objectContaining({ effort: 'high' }))
    expect(w.spawned[1]!.model).toBe('claude-opus-5-5')
    expect(w.logs[0]).toContain('asked opus/max → opus, effort max (caller) (caller)')
    expect(w.logs[1]).toContain('reviewer → deep → asked haiku/low → claude-opus-5-5, effort high set (binding)')
  })

  test('concurrent Agent calls never exchange routes', WITH, async ($, on) => {
    const w = world($, on)
    await start($)
    await Promise.all([agent($, 'scout'), agent($, 'reviewer'), agent($, 'Explore')])
    const byType = Object.fromEntries(w.spawned.map(s => [s.type, s.model]))
    expect(byType).toEqual({ scout: 'claude-haiku-5-5', reviewer: 'claude-opus-5-5', Explore: undefined })
    const effort = Object.fromEntries(w.ran.map(r => [r.type, r.effort]))
    expect(effort).toEqual({ scout: 'low', reviewer: 'high', Explore: undefined })
    for (const r of w.ran) expect(await pending($, w, r.tool_use_id)).toBeNull()
  })

  test('a fork is never rewritten', WITH, async ($, on) => {
    const w = world($, on)
    await start($)
    await agent($, 'fork')
    expect(w.ran[0]!.effort).toBeUndefined()
    expect(w.spawned[0]!.model).toBeUndefined()
    expect(w.logs[0]).toContain('effort inherited (fork)')
  })

  test("a plugin's direct spawn and a workflow agent get the model only, effort not controlled", WITH, async ($, on) => {
    const w = world($, on)
    await start($)
    const base = { prompt: 'p', description: 'd', provider: ENGINE, parentModel: PARENT, background: true, fork: false }
    await $.agent.spawn({ ...base, tool_use_id: 'toolu_direct', subagentType: 'worker' })
    await $.agent.spawn({ ...base, tool_use_id: 'toolu_wf', subagentType: 'scout', workflow: { runId: 'wf_1', agentIndex: 1 } })
    expect(w.spawned.map(s => s.model)).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5'])
    expect(w.logs[0]).toContain('worker → fast → asked -/- → claude-haiku-5-5, effort not controlled (binding)')
    expect(w.logs[1]).toContain('effort not controlled')
  })

  test('a resumed agent is not rewritten', WITH, async ($, on) => {
    const w = world($, on)
    await start($)
    await $.agent.spawn({ prompt: '', description: 'd', provider: ENGINE, parentModel: PARENT, background: true, fork: false, tool_use_id: 'toolu_r', subagentType: 'scout', resume: { agentId: 'a9' } })
    expect(w.spawned[0]!.model).toBeUndefined()
    expect(w.logs).toEqual([])
  })

  test('the route snapshot is cleared when the call is refused below', WITH, async ($, on) => {
    const w = world($, on, { toolDenies: true })
    await start($)
    const r = await agent($, 'scout')
    expect(r.deny).toBe('refused by a hook below')
    expect(await pending($, w, w.ran[0]!.tool_use_id)).toBeNull()
  })

  test('with the mod off nothing is rewritten or logged', { options: { routing: ROUTING, enabled: false, untypedPolicy: 'deny' } }, async ($, on) => {
    const w = world($, on)
    await start($)
    await agent($, 'scout')
    const r = await agent($, undefined)
    expect(r.deny).toBeUndefined()
    expect(w.ran[0]!.effort).toBeUndefined()
    expect(w.spawned[0]!.model).toBeUndefined()
    expect(w.logs).toEqual([])
  })

  test('/roles off turns routing off for the session', WITH, async ($, on) => {
    const w = world($, on)
    await start($)
    expect((await roles($, 'off')).text).toContain('off (set for this session)')
    await agent($, 'scout')
    expect(w.spawned[0]!.model).toBeUndefined()
  })
})

describe('agent-roles: untyped spawns', () => {
  test('warn: the spawn runs, the person sees [untyped], the model gets a note naming typed agents', WITH, async ($, on) => {
    const w = world($, on)
    await start($)
    await $.agent.offer({ agent: 'Explore', description: 'search', source: 'built-in', provider: ENGINE })
    const r = await agent($, undefined)
    expect(r.deny).toBeUndefined()
    expect(w.ran.length).toBe(1)
    expect(w.logs[0]).toContain('general-purpose [untyped] → no role')
    expect(r.context?.length).toBe(1)
    expect(r.context?.[0]).toContain('untyped agent; it ran on claude-opus-5-5')
    expect(r.context?.[0]).toContain('subagent_type: scout, worker, reviewer, Explore')
  })

  test('deny: the call is refused with the typed alternatives and nothing spawns', { options: { routing: ROUTING, untypedPolicy: 'deny' } }, async ($, on) => {
    const w = world($, on)
    await start($)
    const r = await agent($, 'general-purpose')
    expect(r.deny).toContain('untypedPolicy deny')
    expect(r.deny).toContain('scout')
    expect(w.ran).toEqual([])
    expect(w.spawned).toEqual([])
    expect(w.logs[0]).toContain('→ refused: untypedPolicy deny')
    // Typed calls still run.
    expect((await agent($, 'scout')).deny).toBeUndefined()
  })

  test('allow: no note', { options: { routing: ROUTING, untypedPolicy: 'allow' } }, async ($, on) => {
    world($, on)
    await start($)
    const r = await agent($, undefined)
    expect(r.context).toBeUndefined()
  })

  test('defaultRole routes untyped spawns', { options: { routing: ROUTING, defaultRole: 'fast' } }, async ($, on) => {
    const w = world($, on)
    await start($)
    await agent($, undefined)
    expect(w.ran[0]!.effort).toBe('low')
    expect(w.spawned[0]!.model).toBe('claude-haiku-5-5')
  })
})

describe('agent-roles: invalid config', () => {
  test('routes nothing, reports at load, on every spawn and in /roles; refuses edits', { options: { routing: '{"version":1,"roles":{"a":{"role":"a"}},"agents":{"scout":{"role":"a"}}}' } }, async ($, on) => {
    const w = world($, on)
    await start($)
    expect(w.logs[0]).toContain('routing option is invalid')
    expect(w.logs[0]).toContain('cycle')
    await agent($, 'scout')
    expect(w.ran[0]!.effort).toBeUndefined()
    expect(w.spawned[0]!.model).toBeUndefined()
    expect(w.logs[1]).toContain('(invalid-config: routing option is invalid, see /roles)')
    expect((await roles($, '')).text).toContain('cycle: a → a')
    const set = await roles($, 'set fast haiku low')
    expect(set.text).toContain('Not saved')
    expect(w.configSets).toEqual([])
  })
})

describe('agent-roles: /roles', () => {
  test('shows the map and the effective routes', WITH, async ($, on) => {
    world($, on)
    await start($)
    const t = (await roles($, '')).text
    expect(t).toContain('scout → search → claude-haiku-5-5, effort low')
    expect(t).toContain('Limits:')
  })

  test('one set changes every agent bound through the role, in one config write', WITH, async ($, on) => {
    const w = world($, on)
    await start($)
    const res = await roles($, 'set fast sonnet medium')
    expect(res.text).toContain('Saved')
    expect(w.configSets.length).toBe(1)
    expect(w.configSets[0]!.key).toBe('agent-roles.routing')
    expect(JSON.parse(String(w.configSets[0]!.value)).roles.fast).toEqual({ model: 'sonnet', effort: 'medium' })
    await agent($, 'scout')
    await agent($, 'worker')
    expect(w.spawned.map(s => s.model)).toEqual(['sonnet', 'sonnet'])
    expect(w.ran.map(r => r.effort)).toEqual(['medium', 'medium'])
  })

  test('bind and unbind', WITH, async ($, on) => {
    const w = world($, on)
    await start($)
    expect((await roles($, 'bind Explore deep')).text).toContain('Saved')
    await agent($, 'Explore')
    expect(w.spawned[0]!.model).toBe('claude-opus-5-5')
    expect((await roles($, 'unbind Explore')).text).toContain('Saved')
    await agent($, 'Explore')
    expect(w.spawned[1]!.model).toBeUndefined()
    expect((await roles($, 'unbind Explore')).text).toContain('Not saved: agent "Explore" has no binding')
  })

  test('an edit that would break the map is refused and nothing is written', WITH, async ($, on) => {
    const w = world($, on)
    await start($)
    const res = await roles($, 'set fast @search')
    expect(res.text).toContain('Not saved')
    expect(res.text).toContain('cycle')
    expect(w.configSets).toEqual([])
  })

  test('an installed copy finds its row by key, whatever the provider id', WITH, async ($, on) => {
    const w = world($, on, { provider: 'agent-roles@agent-roles' })
    await start($)
    const res = await roles($, 'set fast sonnet')
    expect(res.text).toContain('Saved')
    expect(w.configSets.map(c => c.key)).toEqual(['agent-roles.routing'])
  })

  test('headless (no /config rows): says so, prints the value to paste and where, keeps the map', WITH, async ($, on) => {
    const w = world($, on, { noRows: true })
    await start($)
    const res = await roles($, 'set fast sonnet medium')
    expect(res.text).not.toContain('Saved')
    expect(res.text).toContain('Not saved')
    expect(res.text).toContain('pluginConfigs["agent-roles@agent-roles"].options.routing')
    expect(res.text).toContain('agent-roles@inline')
    const proposed = JSON.parse(ROUTING)
    proposed.roles.fast = { model: 'sonnet', effort: 'medium' }
    // The exact value, as a settings.json string literal.
    expect(res.text).toContain(JSON.stringify(JSON.stringify(proposed)))
    expect(w.configSets).toEqual([])
    await agent($, 'scout')
    expect(w.spawned[0]!.model).toBe('claude-haiku-5-5')
  })

  test('a write another hook replaced: reports and uses the value actually saved', WITH, async ($, on) => {
    const w = world($, on, { clampTo: ROUTING })
    await start($)
    const res = await roles($, 'set fast opus high')
    expect(res.text).not.toContain('Saved. New spawns use it.')
    expect(res.text).toContain('differs from the edit')
    expect(res.text).toContain('fast → claude-haiku-5-5, effort low')
    await agent($, 'scout')
    expect(w.spawned[0]!.model).toBe('claude-haiku-5-5')
    expect(w.ran[0]!.effort).toBe('low')
  })

  test('a saved value that is invalid routes nothing and says so', WITH, async ($, on) => {
    const w = world($, on, { clampTo: '{"version":2}' })
    await start($)
    const res = await roles($, 'set fast opus high')
    expect(res.text).not.toContain('Saved. New spawns use it.')
    expect(res.text).toContain('invalid')
    await agent($, 'scout')
    expect(w.spawned[0]!.model).toBeUndefined()
    expect(w.ran[0]!.effort).toBeUndefined()
  })

  test('a refused config write is reported and the old map stays', WITH, async ($, on) => {
    const w = world($, on, { denyConfig: 'locked by policy' })
    await start($)
    const res = await roles($, 'set fast sonnet')
    expect(res.text).toContain('Not saved: locked by policy')
    await agent($, 'scout')
    expect(w.spawned[0]!.model).toBe('claude-haiku-5-5')
  })

  test('recent lists spawns and /clear empties it', WITH, async ($, on) => {
    world($, on)
    await start($)
    expect((await roles($, 'recent')).text).toBe('No spawns recorded in this session yet.')
    await agent($, 'scout')
    expect((await roles($, 'recent')).text).toContain('scout → search')
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    expect((await roles($, 'recent')).text).toBe('No spawns recorded in this session yet.')
  })

  test('an unknown subcommand answers with usage', WITH, async ($, on) => {
    world($, on)
    await start($)
    expect((await roles($, 'bogus')).text).toContain('Usage: /roles')
  })
})
