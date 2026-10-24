import { atom, read, update } from 'claude-code'
import type { ConfigRow, EngineInterface, Register } from 'claude-code'

import {
  INITIAL,
  RECENT_MAX,
  USAGE,
  configFrom,
  denyReason,
  effortControl,
  isActive,
  isUntyped,
  logLine,
  noConfigRowText,
  parseCommand,
  recentText,
  resolveRoute,
  savedOutcome,
  statusText,
  typedAlternatives,
  untypedNote,
} from './policy'
import { applyEdit, serializeRouting } from './routing'
import type { Config, Effort, RouteRecord, Snapshot } from '../types'

const COMMAND = 'roles'

// Change a shape tag when its type changes: a value an older version stored
// (it outlives a hot reload) then reads as the initial instead of breaking.
const sessionAtom = atom({ plugin: 'agent-roles', key: 'session' } as const, INITIAL, { shape: 'session-2' })
const recentAtom = atom({ plugin: 'agent-roles', key: 'recent' } as const, [] as RouteRecord[], { shape: 'recent-1' })

// Module variables reset on a hot reload (a /config change reloads the module
// with the new options); register and session.start run again then.
let config: Config = configFrom({})
/** Agent types the engine offered the model, for the untyped note and deny reason. */
const offered = new Set<string>()

/** Best effort: reporting must never throw out of a hook. */
function log($: EngineInterface, text: string) {
  try {
    $.ui.log(text)
  } catch {
    // nothing to do
  }
}

async function getPending($: EngineInterface, id: string): Promise<Snapshot | null> {
  const { value } = await $.state.get({ plugin: 'agent-roles', key: 'pending', id })
  return value ?? null
}

async function setPending($: EngineInterface, id: string, value: Snapshot | null) {
  await $.state.set({ plugin: 'agent-roles', key: 'pending', id }, value)
}

/** Logs the spawn's line and keeps it for /roles recent. */
async function record($: EngineInterface, rec: Omit<RouteRecord, 'at'>) {
  log($, logLine({ ...rec, at: 0 }))
  try {
    const at = await $.clock.now()
    await update($, recentAtom, list => [...list, { ...rec, at }].slice(-RECENT_MAX))
  } catch {
    // the log line already said it
  }
}

/**
 * The /config row for this plugin's routing option, by its key
 * (`<plugin>.<field>`). The row's provider names the plugin id
 * (`agent-roles@inline`, `agent-roles@<marketplace>`), not `$.plugin.name`.
 * Headless sessions list no plugin rows at all (2.1.310): null then.
 */
async function routingRow($: EngineInterface): Promise<ConfigRow | null> {
  const key = `${$.plugin.name}.routing`
  const rows = await $.config.list()
  return rows.find(r => r.key === key) ?? null
}

function strip<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

export const register: Register = (on, options) => {
  config = configFrom(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show or edit agent-roles: the role map that routes subagents to a model and effort',
      argumentHint: '[show|set|bind|unbind|recent|on|off]',
    })
    if (!config.routing.ok) log($, `agent-roles: the routing option is invalid, so no spawn is routed: ${config.routing.errors.join('; ')}`)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // /clear starts a new conversation: its spawn records start empty.
    if (e.reason === 'clear') await update($, recentAtom, () => []).catch(() => undefined)
    return next(e)
  })

  on('agent.offer', ($, e, next) => {
    offered.add(e.agent)
    return next(e)
  }).catch(($, e, next) => next(e)) // observes only

  on('command.run', { command: COMMAND }, async ($, e) => {
    const cmd = parseCommand(e.args)
    if (cmd.kind === 'help') return { text: cmd.error ? `${cmd.error}\n${USAGE}` : USAGE }
    if (cmd.kind === 'recent') return { text: recentText(await read($, recentAtom)) }
    if (cmd.kind === 'mode') {
      await update($, sessionAtom, s => ({ ...s, mode: cmd.mode }))
      return { text: statusText(config, await read($, sessionAtom)) }
    }
    if (cmd.kind === 'show') return { text: statusText(config, await read($, sessionAtom)) }

    // An edit: build the whole new map, validate it, write it once or not at all.
    if (!config.routing.ok)
      return { text: `Not saved: the routing option is invalid (${config.routing.errors.join('; ')}). Fix it in /config first.` }
    const next = applyEdit(config.routing.routing, cmd.edit)
    if (!next.ok) return { text: `Not saved: ${next.errors.join('; ')}` }
    const value = serializeRouting(next.routing)
    const row = await routingRow($)
    if (row === null) return { text: noConfigRowText(value) }
    let res: Awaited<ReturnType<EngineInterface['config']['set']>>
    try {
      res = await $.config.set({ key: row.key, value })
    } catch (err) {
      return { text: `Not saved: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (res.deny !== undefined) return { text: `Not saved: ${res.deny}` }
    // The write reloads the module with the new options; until then use what
    // the engine saved (another hook may have replaced the proposal).
    const saved = savedOutcome(options, value, res.value)
    config = saved.config
    return { text: `${saved.head}\n${statusText(config, await read($, sessionAtom))}` }
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.tool !== 'Agent') return next(e)
    if (!isActive(config, await read($, sessionAtom))) return next(e)
    const type = e.subagent_type ?? 'general-purpose'
    // A fork inherits model and effort; agent.spawn logs it.
    if (type === 'fork') return next(e)
    const cfg = config // one revision for the whole call
    const untyped = isUntyped(e.subagent_type)
    const callerModel = e.model
    const callerEffort: Effort | undefined = e.effort

    if (untyped && cfg.untypedPolicy === 'deny') {
      const reason = denyReason(type, typedAlternatives(cfg, [...offered]))
      await record($, strip({ type, untyped, role: null, source: 'native' as const, reason: 'untypedPolicy deny', callerModel, callerEffort, effortControl: 'native' as const, resolvedModel: null, denied: 'untypedPolicy deny' }))
      return { deny: reason }
    }

    const route = resolveRoute(cfg, { type, untyped, callerModel, callerEffort })
    await setPending($, e.tool_use_id, strip({ type, untyped, route, callerModel, callerEffort }))
    try {
      const r = await next(route.effort !== undefined ? { ...e, effort: route.effort } : e)
      if (!untyped || cfg.untypedPolicy !== 'warn' || r.deny !== undefined || r.isError) return r
      const result = r.result as { resolvedModel?: unknown } | undefined
      const resolvedModel = typeof result?.resolvedModel === 'string' ? result.resolvedModel : null
      const rec: RouteRecord = strip({
        at: 0,
        type,
        untyped,
        role: route.role,
        source: route.source,
        reason: route.reason,
        callerModel,
        callerEffort,
        effort: route.effort,
        effortControl: effortControl({ route, hasSnapshot: true, callerEffort }),
        resolvedModel,
      })
      return { ...r, context: [...(r.context ?? []), untypedNote(rec, typedAlternatives(cfg, [...offered]))] }
    } finally {
      await setPending($, e.tool_use_id, null).catch(() => undefined)
    }
  }).catch(($, e, next) => next(e)) // fails open: a bug never blocks delegation

  on('agent.spawn', async ($, e, next) => {
    // A resume ignores content rewrites; nothing to route or report.
    if (e.resume !== undefined) return next(e)
    if (!isActive(config, await read($, sessionAtom))) return next(e)
    // A workflow agent's tool_use_id is its Workflow call's, never an Agent call's.
    const snap = e.workflow === undefined ? await getPending($, e.tool_use_id) : null
    const type = snap?.type ?? e.subagentType
    const untyped = snap?.untyped ?? isUntyped(e.subagentType)
    const callerModel = snap ? snap.callerModel : e.model
    const callerEffort = snap?.callerEffort
    const route = snap?.route ?? resolveRoute(config, { type, untyped, fork: e.fork, callerModel })
    const setModel = !e.fork && route.model !== undefined ? route.model : undefined

    const res = await next(setModel !== undefined ? { ...e, model: setModel } : e)
    await record(
      $,
      strip({
        type,
        untyped,
        role: route.role,
        source: e.fork ? ('fork' as const) : route.source,
        reason: route.reason,
        callerModel,
        callerEffort,
        setModel,
        effort: snap ? route.effort : undefined,
        effortControl: e.fork ? ('inherited' as const) : effortControl({ route, hasSnapshot: snap !== null, callerEffort }),
        resolvedModel: res.deny === undefined ? res.model : null,
        agentId: res.agentId,
        denied: res.deny,
      }),
    )
    return res
  }).catch(($, e, next) => next(e))
}
