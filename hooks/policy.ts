// Pure decisions: no `$`, no I/O. The one resolver every hook routes through,
// and every text the mod shows. register.ts only wires them to events.
import { EFFORTS, bindingFor, isEffort, parseRouting, resolveRole, type Edit } from './routing'
import type { Config, Effort, EffortControl, Mode, Route, RouteRecord, Routing, Session, UntypedPolicy } from '../types'

export const INITIAL: Session = { mode: null }

/** Agent types that carry no specialist definition: the Agent tool's default. */
export const UNTYPED = ['general-purpose']

export const RECENT_MAX = 20

const POLICIES: readonly UntypedPolicy[] = ['warn', 'allow', 'deny']

export function configFrom(options: Record<string, unknown>): Config {
  const policy = options.untypedPolicy
  const defaultRole = typeof options.defaultRole === 'string' ? options.defaultRole.trim() : ''
  let routing = parseRouting(typeof options.routing === 'string' ? options.routing : '')
  if (routing.ok && defaultRole !== '' && !Object.hasOwn(routing.routing.roles, defaultRole))
    routing = { ok: false, errors: [`defaultRole "${defaultRole}" is not a role in routing`] }
  return {
    enabled: options.enabled !== false,
    untypedPolicy: typeof policy === 'string' && (POLICIES as readonly string[]).includes(policy) ? (policy as UntypedPolicy) : 'warn',
    defaultRole,
    routing,
  }
}

export function isActive(config: Config, session: Session): boolean {
  return session.mode === null ? config.enabled : session.mode === 'on'
}

export function isUntyped(type: string | undefined): boolean {
  return type === undefined || UNTYPED.includes(type)
}

export type RouteRequest = {
  type: string
  untyped: boolean
  fork?: boolean
  callerModel?: string
  callerEffort?: Effort
}

/**
 * The one place precedence lives. `model`/`effort` on the answer are what the
 * mod sets; absent, the call's own value (or the native default) stands.
 */
export function resolveRoute(config: Config, req: RouteRequest): Route {
  if (req.fork) return { role: null, source: 'fork', reason: 'forks inherit the parent model and effort' }
  if (!config.routing.ok) {
    const more = config.routing.errors.length > 1 ? ` (+${config.routing.errors.length - 1} more)` : ''
    return { role: null, source: 'invalid-config', reason: `routing option is invalid: ${config.routing.errors[0]}${more}` }
  }
  const routing = config.routing.routing
  const binding = bindingFor(routing, req.type)
  let roleName: string
  let override = false
  let source: 'binding' | 'default-role'
  if (binding) {
    roleName = binding.role
    override = binding.overrideCaller === true
    source = 'binding'
  } else if (req.untyped && config.defaultRole !== '') {
    roleName = config.defaultRole
    source = 'default-role'
  } else {
    return { role: null, source: 'native', reason: req.untyped ? 'untyped; no defaultRole' : 'no binding' }
  }
  const leaf = resolveRole(routing, roleName)
  if (leaf === null) return { role: null, source: 'native', reason: `role ${roleName} does not resolve` }

  if (req.callerModel !== undefined && !override)
    return { role: roleName, source: 'caller', reason: `the call named model ${req.callerModel}; ${source === 'binding' ? 'the binding has no overrideCaller' : 'a default role never overrides it'}` }

  const parts = [source === 'binding' ? `bound to ${roleName}` : `defaultRole ${roleName}`]
  if (leaf.chain.length > 1) parts[0] += ` (${leaf.chain.join(' → ')})`
  const route: Route = { role: roleName, source, reason: '' }
  if (leaf.model !== undefined) route.model = leaf.model
  if (req.callerEffort !== undefined && !override) parts.push('effort from the call')
  else if (leaf.effort !== undefined) route.effort = leaf.effort
  if (override && (req.callerModel !== undefined || req.callerEffort !== undefined)) parts.push('overrides the call')
  route.reason = parts.join('; ')
  return route
}

/** Whose effort the spawn ran with, as far as the mod can know it. */
export function effortControl(a: { route: Route; hasSnapshot: boolean; callerEffort?: Effort }): EffortControl {
  if (a.route.source === 'fork') return 'inherited'
  if (!a.hasSnapshot) return 'not-controlled'
  if (a.route.effort !== undefined) return 'set'
  if (a.callerEffort !== undefined) return 'caller'
  return 'native'
}

function effortText(r: RouteRecord): string {
  switch (r.effortControl) {
    case 'set':
      return `${r.effort} set`
    case 'caller':
      return `${r.callerEffort} (caller)`
    case 'not-controlled':
      return 'not controlled'
    default:
      return r.effortControl
  }
}

/** One line per spawn: type → role → what the call asked → what core resolved, effort, source. */
export function logLine(r: RouteRecord): string {
  const type = r.untyped ? `${r.type} [untyped]` : r.type
  const asked = `asked ${r.callerModel ?? '-'}/${r.callerEffort ?? '-'}`
  const head = `agent-roles: ${type} → ${r.role ?? 'no role'} → ${asked}`
  if (r.resolvedModel === null) return `${head} → refused: ${r.denied ?? 'no reason given'}`
  const source = r.source === 'invalid-config' ? 'invalid-config: routing option is invalid, see /roles' : r.source
  return `${head} → ${r.resolvedModel}, effort ${effortText(r)} (${source})`
}

/** Typed agents to suggest: bound types first, then types the engine offered the model. */
export function typedAlternatives(config: Config, offered: readonly string[]): string[] {
  const out: string[] = []
  const add = (t: string) => {
    if (!isUntyped(t) && t !== 'fork' && !out.includes(t)) out.push(t)
  }
  if (config.routing.ok) for (const t of Object.keys(config.routing.routing.agents)) add(t)
  for (const t of offered) add(t)
  return out.slice(0, 12)
}

/** What the model reads after an untyped Agent result under `warn`. */
export function untypedNote(r: RouteRecord, alternatives: readonly string[]): string {
  const effort = r.effortControl === 'native' ? 'at its default effort' : `with effort ${effortText(r)}`
  const ran = `it ran on ${r.resolvedModel ?? "the session's model"} ${effort}`
  const alts = alternatives.length > 0 ? `: ${alternatives.join(', ')}` : ' from the agent list'
  return `agent-roles: this Agent call used ${r.type}, an untyped agent; ${ran}. When a typed agent fits a task, name it in subagent_type${alts}.`
}

/** The Agent tool's error under `deny`. */
export function denyReason(type: string, alternatives: readonly string[]): string {
  const alts = alternatives.length > 0 ? `: ${alternatives.join(', ')}` : ' from the agent list'
  return `agent-roles refuses untyped Agent calls (untypedPolicy deny): ${type} runs on the session's model at the session's effort. Call Agent again with a typed subagent_type${alts}.`
}

function leafText(model: string | undefined, effort: Effort | undefined): string {
  return `${model ?? 'model native'}, effort ${effort ?? 'native'}`
}

function rolesText(routing: Routing): string[] {
  const lines: string[] = []
  for (const [name, def] of Object.entries(routing.roles)) {
    const leaf = resolveRole(routing, name)
    const end = leafText(leaf?.model, leaf?.effort)
    lines.push('role' in def ? `  ${name} → @${def.role} → ${end}` : `  ${name} → ${end}`)
  }
  return lines
}

function bindingsText(routing: Routing): string[] {
  return Object.entries(routing.agents).map(([agent, b]) => {
    const leaf = resolveRole(routing, b.role)
    const over = b.overrideCaller ? ' (overrides the caller)' : ''
    return `  ${agent} → ${b.role}${over} → ${leafText(leaf?.model, leaf?.effort)}`
  })
}

export const LIMITS = [
  'Limits:',
  '  Effort is set only on Agent tool calls; a plugin\'s $.agent.spawn and workflow agents get model routing only.',
  '  Forks and resumed agents are never rewritten.',
  '  The effort shown is what was requested; the engine reports no effort back.',
  '  If the mod\'s hook fails, the Agent call goes on unchanged (fails open).',
]

export function statusText(config: Config, session: Session): string {
  const state = isActive(config, session) ? 'on' : 'off'
  const from = session.mode === null ? 'from the enabled option' : 'set for this session'
  const lines = [
    `${state} (${from}); untypedPolicy ${config.untypedPolicy}; defaultRole ${config.defaultRole || 'none'}.`,
  ]
  if (!config.routing.ok) {
    lines.push('The routing option is invalid; nothing is routed until it is fixed in /config:')
    for (const e of config.routing.errors) lines.push(`  ${e}`)
  } else {
    const r = config.routing.routing
    const roles = rolesText(r)
    const bindings = bindingsText(r)
    lines.push(roles.length > 0 ? 'Roles:' : 'Roles: none.', ...roles)
    lines.push(bindings.length > 0 ? 'Bindings (agent → role → effective):' : 'Bindings: none.', ...bindings)
    lines.push('Unbound typed agents keep their own definition\'s model and effort.')
  }
  lines.push(...LIMITS)
  return lines.join('\n')
}

/**
 * What a `$.config.set` answered `{ value }` with: the value actually saved,
 * which another plugin's `config.set` hook may have clamped or replaced. That
 * value, not the proposal, becomes the config, and the text says so when the
 * two differ. A saved value that doesn't validate routes nothing.
 */
export function savedOutcome(options: Record<string, unknown>, proposed: string, written: unknown): { config: Config; head: string } {
  const config: Config =
    typeof written === 'string'
      ? configFrom({ ...options, routing: written })
      : { ...configFrom(options), routing: { ok: false, errors: [`the saved routing value is a ${Array.isArray(written) ? 'list' : typeof written}, not JSON text`] } }
  const same = written === proposed
  const changed = 'the value written differs from the edit (another plugin or a setting changed it)'
  if (!config.routing.ok)
    return { config, head: `Saved, but ${same ? 'the value' : changed + ', and it'} is invalid, so no spawn is routed until it is fixed in /config.` }
  if (same) return { config, head: 'Saved. New spawns use it.' }
  return { config, head: `Saved, but ${changed}. New spawns use what was saved:` }
}

/**
 * A headless session (`claude -p`, the SDK) lists no plugin rows in /config on
 * Claude Code 2.1.310, so `$.config.set` can't reach the option. Nothing is
 * saved or applied; this is the value to save by hand, and where.
 */
export function noConfigRowText(value: string): string {
  return [
    'Not saved: this session lists no /config row for the routing option (headless `claude -p` and SDK sessions list none on Claude Code 2.1.310), so /roles can\'t write it. Nothing changed.',
    'To apply this edit, set the option in settings.json under pluginConfigs["agent-roles@agent-roles"].options.routing (the key is the plugin id: agent-roles@<marketplace> for an install, agent-roles@inline for a --plugin-dir load) to this string:',
    JSON.stringify(value),
    'Or run /roles in an interactive session, or `claude plugin configure agent-roles@agent-roles --values-stdin` with {"routing": <that string>}. It applies to sessions started after.',
  ].join('\n')
}

export function recentText(records: readonly RouteRecord[]): string {
  if (records.length === 0) return 'No spawns recorded in this session yet.'
  return [...records]
    .reverse()
    .map(r => logLine(r).replace(/^agent-roles: /, ''))
    .join('\n')
}

export type Command =
  | { kind: 'show' }
  | { kind: 'recent' }
  | { kind: 'mode'; mode: Mode }
  | { kind: 'edit'; edit: Edit }
  | { kind: 'help'; error?: string }

export const USAGE = [
  'Usage: /roles [show|recent|on|off|help]',
  '       /roles set ROLE MODEL [EFFORT]   MODEL: a model, - for native, or @role; EFFORT: ' + EFFORTS.join('|') + ' or -',
  '       /roles bind AGENT ROLE [override]',
  '       /roles unbind AGENT',
].join('\n')

export function parseCommand(args: string): Command {
  const words = args.trim().split(/\s+/).filter(w => w !== '')
  const head = (words[0] ?? '').toLowerCase()
  const rest = words.slice(1)
  switch (head) {
    case '':
    case 'show':
    case 'status':
      return { kind: 'show' }
    case 'recent':
      return { kind: 'recent' }
    case 'on':
    case 'off':
      return { kind: 'mode', mode: head }
    case 'help':
      return { kind: 'help' }
    case 'set': {
      const [role, model, effort] = rest
      if (role === undefined || model === undefined || rest.length > 3) return { kind: 'help', error: 'set takes ROLE MODEL [EFFORT]' }
      if (effort !== undefined && effort !== '-' && !isEffort(effort)) return { kind: 'help', error: `EFFORT must be one of ${EFFORTS.join(', ')} or -` }
      return { kind: 'edit', edit: effort === undefined ? { kind: 'set', role, model } : { kind: 'set', role, model, effort } }
    }
    case 'bind': {
      const [agent, role, flag] = rest
      if (agent === undefined || role === undefined || rest.length > 3 || (flag !== undefined && flag !== 'override'))
        return { kind: 'help', error: 'bind takes AGENT ROLE [override]' }
      return { kind: 'edit', edit: { kind: 'bind', agent, role, override: flag === 'override' } }
    }
    case 'unbind': {
      const [agent] = rest
      if (agent === undefined || rest.length > 1) return { kind: 'help', error: 'unbind takes AGENT' }
      return { kind: 'edit', edit: { kind: 'unbind', agent } }
    }
    default:
      return { kind: 'help', error: `Unknown subcommand: ${words[0]}` }
  }
}
