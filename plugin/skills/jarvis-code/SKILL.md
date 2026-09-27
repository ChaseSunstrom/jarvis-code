---
name: jarvis-code
description: Hand a large, multi-task change to jarvis-code (an orchestrator that plans the goal into verified tasks and works them with Claude Code, Codex, OpenCode or other agents), or check on a jarvis-code run. Use when the user asks to "use jarvis-code", "orchestrate this", or run a big change across agents.
---

# jarvis-code

jarvis-code plans a goal into tasks, works each task with the configured agents, verifies it
with the task's own checks and keeps the queue, evidence and lessons in its own store. Hand it
work instead of doing a large change turn by turn.

- Start a goal (non-interactive, for use from here): `jarvis-code "<goal>" --plain`
- Work this project's open tasks without planning: `jarvis-code work --plain`
- Where things stand: `jarvis-code status`, `jarvis-code tasks`, `jarvis-code task show ID`
- What it has learned (routes and tools it switched off): `jarvis-code learn`
- Check the setup: `jarvis-code doctor`
- Explore an open-ended goal first (several angles and agents, then plan the best):
  `/jarvis-code:brainstorm <goal>`, or `--planning deep`
- Follow-ups workers found out of scope are kept deferred: `jarvis-code tasks --all`, then
  `jarvis-code task retry ID` to queue one

Run it in the background for long goals and read its summary line when it exits: exit 0 means
every task closed; 1 means some were blocked or need review (listed in the output).

Inside a jarvis-code worker session (`JARVIS_CODE_RUN=1`) do not start jarvis-code again and do
not change its tasks: it owns the queue, runs the checks and records the evidence itself.
