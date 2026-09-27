---
name: jarvis-code
description: Hand a large, multi-task change to jarvis-code (a Foreman-driven orchestrator that plans the goal into tasks and works them with Claude Code, Codex, OpenCode or other agents), or check on a jarvis-code run. Use when the user asks to "use jarvis-code", "orchestrate this", or run a big change across agents.
---

# jarvis-code

jarvis-code plans a goal into Foreman briefs, works each brief with the configured agents,
verifies it with the brief's own checks and closes it in Foreman. Hand it work instead of
doing a large change turn by turn.

- Start a goal (non-interactive, for use from here): `jarvis-code "<goal>" --plain`
- Work the existing Foreman queue without planning: `jarvis-code work --plain`
- Where things stand: `jarvis-code status`
- What it has learned (routes and tools it switched off): `jarvis-code learn`
- Check the setup: `jarvis-code doctor`

Run it in the background for long goals and read its summary line when it exits: exit 0 means
every task closed; 1 means some were blocked or need review (listed in the output).

Inside a jarvis-code worker session (`JARVIS_CODE_RUN=1`) do not run it again and do not run
`fm task`/`fm focus`: jarvis-code owns the queue and records the evidence itself.
