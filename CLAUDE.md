# CLAUDE.md

jarvis-code is a Foreman-driven orchestrator for coding-agent CLIs with an Ink TUI. The README is
the user-facing map. `src/orchestrator.ts` is the core loop.

## Commands

- `npm test`: tsc build + every test (`node --test dist/test/`). The end-to-end tests run fake
  agents (`src/demo-agent.ts`, `test/fixtures/`) and real `fm` with `FOREMAN_STATE` isolated.
- `node scripts/verify-reactor.mjs`: runs the demo in a real pty and checks the reactor animates,
  then holds still. Run it after touching `src/reactor.ts` or `src/tui/`.
- `claude plugin validate plugin` and `claude plugin validate .` after touching `plugin/` or `.claude-plugin/`.
- `node dist/src/cli.js demo --plain --fast`: quick end-to-end smoke.

## Conventions

- Tabs, single quotes, semicolons. ESM with `.js` import suffixes. Comments say why.
- Colours come from `src/theme.ts` (the Jarvis console palette). Don't type hex values elsewhere.
- Agent adapters normalize to `AgentEvent` (`src/agents/types.ts`). Parsers ignore unknown events.
- Agent fakes must copy the real CLI's timing. Claude Code applies `set_model` from the next
  turn, not mid-turn.
- Never write Foreman state directly. Go through `fm … --json` (`src/tasks.ts`).
- Nothing machine-specific in the repo: no home paths, no captured account data in fixtures.
