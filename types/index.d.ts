export type Mode = 'on' | 'off'

/** An effort level the Agent tool takes. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** A role: a model and effort (either left out means native), or a reference to another role. */
export type RoleDef = { model?: string; effort?: Effort } | { role: string }

/** An agent type's binding to a role. */
export type Binding = { role: string; overrideCaller?: true }

/** The routing option, parsed and validated. */
export type Routing = {
  version: 1
  roles: Record<string, RoleDef>
  agents: Record<string, Binding>
}

/** The routing option as read: valid, or rejected whole with the reasons. */
export type RoutingRead = { ok: true; routing: Routing } | { ok: false; errors: string[] }

export type UntypedPolicy = 'warn' | 'allow' | 'deny'

/** The options in plugin.json's userConfig, parsed with defaults filled in. */
export type Config = {
  enabled: boolean
  untypedPolicy: UntypedPolicy
  /** Agent types the untyped policy covers (`untypedAgents`); no `subagent_type` counts as `general-purpose`. */
  untypedAgents: string[]
  /** A role for untyped spawns; '' for none. */
  defaultRole: string
  /** The routing option with defaultRole checked against it. */
  routing: RoutingRead
}

/** Where a route's model and effort came from. */
export type RouteSource = 'binding' | 'default-role' | 'caller' | 'native' | 'fork' | 'invalid-config'

/** One spawn's route, as resolveRoute decides it. `model`/`effort` absent: leave the call's own. */
export type Route = {
  role: string | null
  model?: string
  effort?: Effort
  source: RouteSource
  reason: string
}

/** What the Agent call's hook decided, kept for the spawn under its tool_use_id. */
export type Snapshot = {
  type: string
  untyped: boolean
  route: Route
  callerModel?: string
  callerEffort?: Effort
}

/** Whose effort a spawn ran with, as far as the mod knows. */
export type EffortControl = 'set' | 'caller' | 'native' | 'not-controlled' | 'inherited'

/** One spawn, for the log line and /roles recent. */
export type RouteRecord = {
  at: number
  type: string
  untyped: boolean
  role: string | null
  source: RouteSource
  reason: string
  callerModel?: string
  callerEffort?: Effort
  setModel?: string
  effort?: Effort
  effortControl: EffortControl
  /** The model core resolved, or null when the spawn was refused. */
  resolvedModel: string | null
  agentId?: string
  denied?: string
}

/** What the mod keeps for the session. Lives in $.state, so it survives a hot reload. */
export type Session = {
  /** A /roles on|off override for this session; null follows the `enabled` option. */
  mode: Mode | null
}

declare module 'claude-code' {
  interface PluginState {
    'agent-roles': {
      session: Shaped<Session>
      recent: Shaped<RouteRecord[]>
      pending: StateFamily<Snapshot | null>
    }
  }
}
