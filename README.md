# agent-roles

A Claude Code mod (function-hook plugin) that routes subagents to a model and an effort level from one central role map, and shows how each spawn was routed. Agent files already carry `model` and `effort`; this mod adds one place to change many agents at once, a log line per spawn, and a guard against untyped `general-purpose` delegation, which runs on the session's model at the session's effort.

## Behavior

- **Roles and bindings.** The `routing` option holds a small JSON map: named roles (a model and an effort, or a reference to another role) and bindings from agent types to roles. When the model calls the Agent tool with a bound `subagent_type`, the mod sets the call's `effort` and the spawn's `model` from the role. Change the role once and every agent bound to it follows on its next spawn.
- **What wins.** An Agent call that names a `model` itself keeps the caller's whole choice (model and effort) unless the binding sets `overrideCaller`. A call that names only an `effort` keeps that effort and gets the role's model. A role field left out keeps what the agent's own definition, then the session, decides. Agent types with no binding are untouched.
- **Untyped spawns.** An Agent call with no `subagent_type`, or `general-purpose`, follows `untypedPolicy`:
  - `warn` (default): the spawn runs. Its log line is marked `untyped`, and the model gets one short note after the Agent result naming the typed agents it could use instead. The person sees the log line; only the model reads the note.
  - `deny`: the Agent call is refused with a reason that names the typed agents.
  - `allow`: no note, no refusal.
  
  `defaultRole` (empty by default) routes untyped spawns through a role, like a binding without `overrideCaller`.
- **One log line per spawn**, in the transcript (and as `ui_log` in `claude -p` and SDK hosts), once core has resolved the model:

  ```
  agent-roles: scout → search → asked -/- → claude-haiku-5-5, effort low set (binding)
  agent-roles: general-purpose [untyped] → no role → asked -/- → claude-opus-5-5, effort native (native)
  ```

  The effort shown is what the mod set on the call (or whose it is: the caller's, native, not controlled). The engine reports no effort back, so it is never an observed value. `/roles recent` lists the last 20 spawns.
- **Invalid configuration routes nothing.** A `routing` value that doesn't parse or validate (bad JSON, an unknown role, a reference cycle, a bad effort, an unknown `defaultRole`) is never patched or partly applied: no spawn is routed, the error is logged at load and in every spawn's line, and `/roles` shows it. `/roles` edits are refused until you fix the value in `/config`.
- **Main loop and subagents alike.** Agent calls from inside a subagent are routed the same way.
- **Cost.** The mod calls no model and changes no prompt or tool list. The only tokens it adds are the `warn` note on an untyped Agent result, about 60 tokens per untyped spawn. What it changes is which model your subagents run on, which is the point: routing an agent to a larger model or a higher effort costs more.

## The routing option

```json
{
  "version": 1,
  "roles": {
    "fast": { "model": "claude-haiku-5-5", "effort": "low" },
    "deep": { "model": "claude-opus-5-5", "effort": "high" },
    "search": { "role": "fast" }
  },
  "agents": {
    "scout": { "role": "search" },
    "reviewer": { "role": "deep", "overrideCaller": true }
  }
}
```

- `version`: always `1`.
- `roles`: names of letters, digits, `_`, `-`, `.`, `:` (up to 64). A role is either `{ "model"?, "effort"? }` or `{ "role": "<other role>" }`, never both. `model` is an alias (`haiku`, `sonnet`, `opus`) or a full id (`claude-haiku-5-5`), passed to the spawn as written; a model the engine doesn't know fails that spawn with the engine's error. `effort` is `low`, `medium`, `high`, `xhigh` or `max`.
- `agents`: the agent type exactly as the Agent tool names it (`scout`, `Explore`, `my-plugin:runner`) → `{ "role": "<role>", "overrideCaller"?: true }`.

An empty `routing` value means an empty map: nothing is routed, and the untyped policy still applies.

## Command

`/roles [show|set|bind|unbind|recent|on|off|help]`

| Command | What it does |
| --- | --- |
| `/roles` | The map, each role's effective model and effort, each binding, the options, and the limits below. |
| `/roles set ROLE MODEL [EFFORT]` | Create or change a role. `MODEL` is a model, `-` for native, or `@other` to make the role a reference. `EFFORT` is a level or `-` for native. |
| `/roles bind AGENT ROLE [override]` | Bind an agent type to a role; `override` sets `overrideCaller`. |
| `/roles unbind AGENT` | Remove a binding. |
| `/roles recent` | The last 20 spawns: type, role, what was asked, what was set, the model core resolved. |
| `/roles on` / `/roles off` | Turn the mod on or off for this session. |

Edits validate the whole new map and write it with one `/config` change, or write nothing. A change another plugin or a managed setting refuses is reported, not retried. A change applies to spawns that start after it.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Turn the mod on for new sessions. `/roles on\|off` overrides it per session. |
| `routing` | empty | The role map above, as JSON text. |
| `untypedPolicy` | `warn` | `warn`, `allow` or `deny`, for Agent calls with no `subagent_type` or `general-purpose`. |
| `defaultRole` | empty | A role for untyped spawns; empty leaves them native. Must name a role in `routing`. |

Set them in `/config`, or in settings under `pluginConfigs["agent-roles@agent-roles"].options` (the key is the plugin id, `<plugin>@<marketplace>`; `agent-roles@inline` for a `--plugin-dir` load).

## Limitations

- **Effort is controlled only on Agent tool calls.** A plugin's own `$.agent.spawn` and workflow agents have no effort input: the mod routes their model and logs their effort as "not controlled". It never rewrites per-request effort (`turn.step`), because nothing guarantees the first request of a new agent waits for that.
- **Forks and resumes are never rewritten.** A fork inherits the parent's model and effort; a resumed agent keeps its own.
- **No observed effort.** The log shows the effort requested. The model shown is the one core resolved at spawn; a forced subagent model or a fallback model can still change what serves later requests.
- **`untypedPolicy` covers Agent tool calls only**, not plugin or workflow spawns.
- **The guard fails open.** If the mod's hook fails, the Agent call goes on unchanged, so `deny` lets that one call through.
- **Teammates** are routed like any Agent call but weren't tested.
- Cut from this version: model-name suffixes (`haiku:low`), fuzzy model matching, fallback chains, per-project maps, and a pane.

## Install

```sh
claude plugin marketplace add chrisvaillancourt/claude-agent-roles
claude plugin install agent-roles@agent-roles --scope user
```

Or from inside Claude Code: `/plugin install agent-roles --marketplace chrisvaillancourt/claude-agent-roles`.

To work on it locally, add your clone as the marketplace instead (`claude plugin marketplace add <path to clone>`). The plugin is read from that folder; after editing, run `/reload-plugins`.

## Update

```sh
claude plugin marketplace update agent-roles
claude plugin update agent-roles@agent-roles
```

Then restart Claude Code.

## Develop

```sh
scripts/check.sh
```

It runs `claude plugin validate .`, `claude plugin test .` and a TypeScript check. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## License

MIT. See [LICENSE](LICENSE).
