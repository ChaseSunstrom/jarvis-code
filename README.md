# jarvis-code

Hand a large change to a fleet of coding agents and watch the tasks, not the diffs.

jarvis-code plans a goal into [Foreman](https://github.com/ChaseSunstrom/foreman) tasks, works
each one with **Claude Code**, **Codex**, **OpenCode** or any other command-line agent, checks it
with the task's own verify commands, and closes it in Foreman. Along the way it learns which
agents, models, subagents and tools actually work in your setup and stops using the ones that
don't. It also switches a downgraded model back to the one you configured.

![jarvis-code working a queue](docs/tui.png)

The TUI is built around the Jarvis C2 arc reactor. The reactor turns while agents work, its
blades track the plan (finished, running, waiting), its level arc fills with progress, and it
changes colour when something needs you.

## Install

```sh
npm install -g --allow-scripts=jarvis-code github:ChaseSunstrom/jarvis-code   # Node 22+; builds on install
jarvis-code doctor                                 # what it found: agents, Foreman, terminal
jarvis-code demo                                   # simulated agents: no API calls, no Foreman
```

jarvis-code uses the agents you already have on `PATH` (`claude`, `codex`, `opencode`) and
Foreman's `fm` CLI. Without Foreman, `--tasks memory` keeps the queue in the process.

## Use

```sh
jarvis-code "migrate the settings system to the new loader"   # plan, then work the tasks
jarvis-code work                                              # work the existing Foreman queue
jarvis-code status                                            # queue + agent health
jarvis-code learn                                             # what it has learned; `learn reset [KEY]`
```

`--plain` prints one line per event instead of the TUI. It is the default when stdout isn't a
terminal. The exit code is 0 when every task closed and 1 when any are blocked or need review.

| key | |
|---|---|
| `q` | stop the run (kills workers), then exit |
| `p` | pause: running tasks finish, no new ones start |
| `d` / `t` / `m` | show diffs / tool calls / agent messages (all off by default) |
| `r` | reactor: large → small → off |
| `l` | learned routes and tools |

## How a run works

1. **Plan.** A planner agent (read-only) turns the goal into small tasks, each with shell verify
   commands. jarvis-code creates them as Foreman briefs (`fm task new`).
2. **Dispatch.** For each ready task (in Foreman's queue order, dependencies respected) it picks a
   *route*, an agent plus model, from your preference list, skipping any the learning has
   switched off.
3. **Work.** The worker gets the brief as its prompt and runs headless (`claude -p` stream-json,
   `codex exec --json`, `opencode run --format json`, or your command).
4. **Verify.** jarvis-code runs the brief's verify commands through `fm task evidence --run`, so
   Foreman records the evidence.
5. **Close or retry.** When the checks pass, the task is closed (`fm task finish`). M/L briefs
   whose Foreman gates want audits are left open and flagged *needs review*. When a check fails,
   the next attempt goes to another route and includes the failure. After `maxAttempts` the task
   is blocked with the reason, and its dependents wait.

### One Foreman, never two

Foreman stays the only planner and bookkeeper. Claude Code workers start with
`--settings '{"enabledPlugins":{"foreman@foreman":false}}'`, so Foreman's hooks don't run a second
loop inside a worker (`agents.claude.disablePlugins`). The jarvis-code plugin (below) also refuses
`fm task`/`fm focus`/… inside workers of every agent, so no worker can close or re-plan a task
behind the orchestrator's back.

### Learning

Every task outcome is recorded against its route (`claude:claude-fable-5-1`,
`local:ollama/qwen3-coder`, …) as a decayed success rate. Once a route has `minSamples` runs and
its rate drops below `disableBelow`, it is **switched off** for `cooldownMin`. It then gets one probe run:
if the probe fails the cooldown doubles, and if it passes the route comes back. If every route is
off, the one whose cooldown ends first is probed early rather than stalling the queue.

Tools are learned the same way, **per orchestrating agent**. When `Agent(Explore)` keeps failing
under Claude Code, or an MCP server keeps erroring under Codex, that tool is refused for that agent
only, through the plugin hook and `--disallowedTools`. Core tools (Bash, Read, Edit, …) are never
switched off, because a failing test is not a broken tool.

```sh
jarvis-code learn                  # routes and tools, scores, what is off and why
jarvis-code learn reset local:ollama/qwen3-coder
```

### Model downgrades

Claude Code sometimes moves a session to a fallback model when a message is flagged (Fable → Opus,
for example), and most of those flags are false positives. jarvis-code reads the structured events
(`model_refusal_fallback`, `model_consent_fallback`, `model_fallback`, plus a check of each
message's `model` field) and applies your policy:

- **reupgrade** (default): sends `set_model` back to the configured model. Claude Code applies a
  switch from the next turn, so once the downgraded turn ends jarvis-code runs one follow-up turn
  on the restored model to review and finish the task. That turn has the last word.
- **retry**: reruns the whole task on the configured model.
- **accept**: keep going on the fallback.

Turn-scoped fallbacks (overload, availability) return to the primary on their own and are only
logged. Usage-credit consent swaps are left alone, because switching back would only reopen the
same prompt.

## Configure

`~/.config/jarvis-code/config.json` (global) and `.jarvis-code.json` (per repo) are merged over
the defaults. Objects merge, arrays replace. `jarvis-code config init` writes a starter file, and
`config show` prints the result.

```jsonc
{
  "agents": {
    "claude":   { "models": ["claude-fable-5-1"] },
    "codex":    { "enabled": "auto", "models": ["gpt-6-sol"] },
    // your own model through OpenCode: its own route, judged on its own record
    "local":    { "kind": "opencode", "models": ["ollama/qwen3-coder"] },
    // any other CLI agent: {prompt} and {model} are substituted
    "aider":    { "kind": "generic", "bin": "aider", "args": ["--yes", "--message", "{prompt}"] }
  },
  "workers": ["local:ollama/qwen3-coder", "claude:claude-fable-5-1", "codex"],  // preference order
  "planner": ["claude:claude-fable-5-1"],
  "strategy": "priority",          // or "best": highest learned score first
  "maxAttempts": 3,
  "maxParallel": 1,                // >1 runs workers side by side in one working tree
  "ui": { "showDiffs": false, "showTools": false, "showText": false, "reactor": "large", "fps": 24, "reducedMotion": false },
  "learning": { "minSamples": 3, "disableBelow": 0.35, "cooldownMin": 1440, "decay": 0.9, "blockTools": true, "neverBlock": [] },
  "downgrade": {
    "default": { "action": "reupgrade", "max": 3 },
    "models": { "claude-fable*": { "action": "reupgrade", "to": "claude-fable-5-1", "max": 5 } }
  }
}
```

(The comments are for this page; the files are plain JSON.)

Agent fields: `kind` (`claude` · `codex` · `opencode` · `generic`), `enabled` (`true` · `false` ·
`"auto"` = on when `bin` is on `PATH`), `bin`, `models` (each is a route, empty = the CLI's
default), `args`, `env`, `timeoutMin`, `disablePlugins` (Claude Code plugins switched off inside
workers). Codex workers get `--sandbox workspace-write` unless your `args` choose a sandbox.

## The plugin

`plugin/` is the worker side of jarvis-code. It does nothing outside a jarvis-code run
(`JARVIS_CODE_RUN` unset), so installing it globally never changes a normal session. Inside a
run it refuses the tools the learning switched off for that agent and any Foreman state commands.

| agent | how it loads |
|---|---|
| Claude Code | per worker with `--plugin-dir`, automatically; or `jarvis-code plugin install claude` (adds this repo as a marketplace), which also gives interactive sessions the `jarvis-code` skill and `/jarvis-code:status` |
| Codex | `jarvis-code plugin install codex` adds a PreToolUse hook to `~/.codex/hooks.json` (Codex asks you to trust it once) |
| OpenCode | `jarvis-code plugin install opencode` links `plugin/opencode/jarvis-code.js` into `~/.config/opencode/plugins/` |

`jarvis-code plugin status` shows what is installed, and `plugin uninstall <agent>` removes only
what jarvis-code added.

## Develop

```sh
npm install
npm test                           # build + unit + end-to-end (fake agents, and real Foreman with isolated state)
node scripts/verify-reactor.mjs    # runs the demo in a real pty and checks the reactor animates, then holds still
```

`src/` has `orchestrator.ts` (plan → dispatch → verify → close/retry), `agents/` (one adapter per
CLI, normalized events), `learn.ts` (routes, tools, circuit breaker), `downgrade.ts`, `tasks.ts`
(Foreman and in-memory sources), `reactor.ts` (ring + braille instrument), `tui/` (Ink) and
`plain.ts`. `src/demo-agent.ts` stands in for an agent in the demo and the tests. It speaks
Claude Code's stream-json protocol, including its model-switch timing.

### Known limits

- Codex and OpenCode adapters follow their documented JSON event formats and are tested against
  recorded fixtures, not a live install. Unknown events are ignored, so a newer CLI degrades to
  "final message + exit code".
- Learned tool blocking is enforced by the plugin. Claude Code workers always load it; Codex and
  OpenCode only have it after `jarvis-code plugin install codex|opencode` (`doctor` warns when
  it's missing). Without it those agents are told which tools are off, but nothing stops them.
- Downgrade detection is structured for Claude Code only. Codex and OpenCode don't report a model
  switch in their event streams.
- `maxParallel > 1` shares one working tree. Keep the plan's tasks on separate files, or leave it
  at 1.

The reactor's geometry, palette and motion come from the Jarvis design system. The terminal
spreads the inner rings apart so they read at braille resolution.

MIT © Chase Sunstrom
