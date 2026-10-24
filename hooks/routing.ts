// Pure: the routing option's grammar. Parse and validate the versioned JSON,
// resolve role references, apply /roles edits, write the map back. No `$`.
import type { Binding, Effort, RoleDef, Routing, RoutingRead } from '../types'

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

const ROLE_NAME = /^[A-Za-z0-9_.:-]{1,64}$/
const AGENT_NAME = /^\S{1,128}$/
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/

export const EMPTY: Routing = { version: 1, roles: {}, agents: {} }

export function isEffort(v: unknown): v is Effort {
  return typeof v === 'string' && (EFFORTS as readonly string[]).includes(v)
}

export function isModel(v: unknown): v is string {
  return typeof v === 'string' && MODEL.test(v)
}

/** Sets an own key, whatever its name (`__proto__` included). */
function put<T>(obj: Record<string, T>, key: string, value: T) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true })
}

function own<T>(obj: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(obj, key) ? obj[key] : undefined
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function unknownKeys(where: string, obj: Record<string, unknown>, allowed: readonly string[], errors: string[]) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${where}: unknown key "${k}"`)
}

/** Reads the option's text: an empty value is the empty map; anything else must validate whole. */
export function parseRouting(text: string): RoutingRead {
  if (text.trim() === '') return { ok: true, routing: { version: 1, roles: {}, agents: {} } }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { ok: false, errors: [`routing is not valid JSON (${err instanceof Error ? err.message : String(err)})`] }
  }
  return validateRouting(raw)
}

/** Checks a parsed value and builds a fresh Routing from it, or lists every error. */
export function validateRouting(raw: unknown): RoutingRead {
  const errors: string[] = []
  if (!isPlainObject(raw)) return { ok: false, errors: ['routing must be a JSON object'] }
  if (raw.version !== 1) errors.push('routing: version must be 1')
  unknownKeys('routing', raw, ['version', 'roles', 'agents'], errors)

  const roles: Record<string, RoleDef> = {}
  const rawRoles = raw.roles ?? {}
  if (!isPlainObject(rawRoles)) errors.push('routing: roles must be an object')
  else
    for (const [name, def] of Object.entries(rawRoles)) {
      if (!ROLE_NAME.test(name)) {
        errors.push(`role name "${name}" must be 1-64 letters, digits, _ - . or :`)
        continue
      }
      if (!isPlainObject(def)) {
        errors.push(`role "${name}" must be an object`)
        continue
      }
      unknownKeys(`role "${name}"`, def, ['model', 'effort', 'role'], errors)
      if (def.role !== undefined) {
        if (def.model !== undefined || def.effort !== undefined) {
          errors.push(`role "${name}": a reference ({"role"}) takes no model or effort`)
          continue
        }
        if (typeof def.role !== 'string') {
          errors.push(`role "${name}": role must be a role name`)
          continue
        }
        put(roles, name, { role: def.role })
        continue
      }
      const leaf: { model?: string; effort?: Effort } = {}
      if (def.model !== undefined) {
        if (isModel(def.model)) leaf.model = def.model
        else errors.push(`role "${name}": model must be an alias or a model id (letters, digits, . _ : - [ ])`)
      }
      if (def.effort !== undefined) {
        if (isEffort(def.effort)) leaf.effort = def.effort
        else errors.push(`role "${name}": effort must be one of ${EFFORTS.join(', ')}`)
      }
      put(roles, name, leaf)
    }

  // References: each must name a role, and none may loop back.
  for (const [name, def] of Object.entries(roles)) {
    if (!('role' in def)) continue
    if (!Object.hasOwn(roles, def.role)) errors.push(`role "${name}" refers to unknown role "${def.role}"`)
  }
  const reported = new Set<string>()
  for (const start of Object.keys(roles)) {
    const path = [start]
    let cur = own(roles, start)
    while (cur && 'role' in cur) {
      const next = cur.role
      if (!Object.hasOwn(roles, next)) break
      const at = path.indexOf(next)
      if (at >= 0) {
        const cycle = [...path.slice(at), next]
        const key = [...cycle.slice(0, -1)].sort().join('|')
        if (!reported.has(key)) {
          reported.add(key)
          errors.push(`role references form a cycle: ${cycle.join(' → ')}`)
        }
        break
      }
      path.push(next)
      cur = own(roles, next)
    }
  }

  const agents: Record<string, Binding> = {}
  const rawAgents = raw.agents ?? {}
  if (!isPlainObject(rawAgents)) errors.push('routing: agents must be an object')
  else
    for (const [agent, b] of Object.entries(rawAgents)) {
      if (!AGENT_NAME.test(agent)) {
        errors.push(`agent name "${agent}" must be 1-128 characters with no spaces`)
        continue
      }
      if (!isPlainObject(b)) {
        errors.push(`agent "${agent}" must be an object like {"role": "fast"}`)
        continue
      }
      unknownKeys(`agent "${agent}"`, b, ['role', 'overrideCaller'], errors)
      if (typeof b.role !== 'string') {
        errors.push(`agent "${agent}": role must be a role name`)
        continue
      }
      if (!Object.hasOwn(roles, b.role)) errors.push(`agent "${agent}" is bound to unknown role "${b.role}"`)
      if (b.overrideCaller !== undefined && b.overrideCaller !== true && b.overrideCaller !== false)
        errors.push(`agent "${agent}": overrideCaller must be true or false`)
      put(agents, agent, b.overrideCaller === true ? { role: b.role, overrideCaller: true } : { role: b.role })
    }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, routing: { version: 1, roles, agents } }
}

export type ResolvedRole = { chain: string[]; model?: string; effort?: Effort }

/** Follows references to the leaf. Null for an unknown role or a cycle (validation rules both out). */
export function resolveRole(routing: Routing, name: string): ResolvedRole | null {
  const chain: string[] = []
  let cur = name
  for (;;) {
    const def = own(routing.roles, cur)
    if (def === undefined || chain.includes(cur)) return null
    chain.push(cur)
    if ('role' in def) {
      cur = def.role
      continue
    }
    const out: ResolvedRole = { chain }
    if (def.model !== undefined) out.model = def.model
    if (def.effort !== undefined) out.effort = def.effort
    return out
  }
}

export function bindingFor(routing: Routing, agent: string): Binding | undefined {
  return own(routing.agents, agent)
}

export type Edit =
  | { kind: 'set'; role: string; model: string; effort?: string }
  | { kind: 'bind'; agent: string; role: string; override: boolean }
  | { kind: 'unbind'; agent: string }

/** A copy of the map with one edit applied, validated whole; the input is never changed. */
export function applyEdit(routing: Routing, edit: Edit): RoutingRead {
  const draft = JSON.parse(serializeRouting(routing)) as { version: 1; roles: Record<string, unknown>; agents: Record<string, unknown> }
  if (edit.kind === 'set') {
    let def: Record<string, unknown>
    if (edit.model.startsWith('@')) {
      def = { role: edit.model.slice(1) }
      if (edit.effort !== undefined && edit.effort !== '-') def.effort = edit.effort
    } else {
      def = {}
      if (edit.model !== '-') def.model = edit.model
      if (edit.effort !== undefined && edit.effort !== '-') def.effort = edit.effort
    }
    put(draft.roles, edit.role, def)
  } else if (edit.kind === 'bind') {
    put(draft.agents, edit.agent, edit.override ? { role: edit.role, overrideCaller: true } : { role: edit.role })
  } else {
    if (!Object.hasOwn(draft.agents, edit.agent)) return { ok: false, errors: [`agent "${edit.agent}" has no binding`] }
    delete draft.agents[edit.agent]
  }
  return validateRouting(draft)
}

export function serializeRouting(routing: Routing): string {
  return JSON.stringify(routing)
}
