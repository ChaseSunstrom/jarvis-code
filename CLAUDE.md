# CLAUDE.md

jarvis-code is an orchestrator for coding-agent CLIs with an Ink TUI and its own task store. The README is
the user-facing map. `src/orchestrator.ts` is the core loop.

## Commands

- `npm test`: tsc build + every test (`node --test dist/test/`). The end-to-end tests run fake
  agents (`src/demo-agent.ts`, `test/fixtures/`) with `JARVIS_CODE_STATE` isolated.
- `node scripts/verify-reactor.mjs`: runs the demo in a real pty and checks the reactor animates,
  then holds still. Run it after touching `src/reactor.ts` or `src/tui/`.
- `node scripts/verify-cockpit.mjs`: drives the cockpit in a real pty (menu, /help, a run, Ctrl+C
  out). Run it after touching `src/tui/` or `src/cli.ts`.
- `node --max-old-space-size=256 --expose-gc scripts/soak-cockpit.mjs [seconds]` (after `npm run build`):
  floods the rendered cockpit for ~90 s and fails if its heap keeps growing. Run it after touching
  what the cockpit renders or keeps per run.
- `claude plugin validate plugin` and `claude plugin validate .` after touching `plugin/` or `.claude-plugin/`.
- `node dist/src/cli.js demo --plain --fast`: quick end-to-end smoke.

## Conventions

- Tabs, single quotes, semicolons. ESM with `.js` import suffixes. Comments say why.
- Colours come from `src/theme.ts` (the Jarvis console palette). Don't type hex values elsewhere.
- Agent adapters normalize to `AgentEvent` (`src/agents/types.ts`). Parsers ignore unknown events.
- Agent fakes must copy the real CLI's timing. Claude Code applies `set_model` from the next
  turn, not mid-turn.
- Task state goes through `Project` (`src/store.ts`): atomic writes, every change in the ledger.
- Nothing shipped (prompts, plugin, skills, docs) may point agents at jarvis-code's own source as
  work to do: workers run it on other people's projects.
- Nothing machine-specific in the repo: no home paths, no captured account data in fixtures.
- Tests never reach a real agent CLI: runs load config from disk, so any test that can start one
  points `XDG_CONFIG_HOME` at a temp dir whose config switches claude/codex/opencode off.
- Commands the orchestrator runs in the main tree (checks, preflight) go through `oneAtATime`:
  with parallel workers, two `npm test`s would share one build dir.
- The cockpit re-renders at `ui.fps` while it animates: no file or process I/O in render. Read
  on the event that needs it (a command, an interval) and keep the result in state.
