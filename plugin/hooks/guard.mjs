// The one rule set every jarvis-code worker integration applies (Claude Code, Codex, OpenCode).
// Pure: it reads the environment jarvis-code sets on the worker and answers allow or deny.

/** `fm` subcommands that change task state: the orchestrator owns them, a worker must not. */
const STATE_VERBS = /^(task|focus|capture|intake|checkpoint|next|run|serve|ask|decide)$/;
/** Words that run the word after them as the command (`env fm …`, `then fm …`). */
const PREFIXES = /^(env|command|exec|nohup|time|sudo|then|do|else|if|while|until|!)$/;

/**
 * Whether a shell line runs a Foreman state command anywhere in it. Every simple command
 * is checked: the line is split on the shell's separators and on quotes and substitutions,
 * so `bash -c "fm task …"`, `$(fm task …)` and a second line are seen too.
 */
export function changesForeman(command) {
	for (const segment of command.split(/[\n;&|()`'"{}]/)) {
		const words = segment.trim().split(/\s+/);
		let i = 0;
		while (i < words.length && (PREFIXES.test(words[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) i++;
		if (words[i]?.replace(/^.*\//, '') === 'fm' && STATE_VERBS.test(words[i + 1] ?? '')) return true;
	}
	return false;
}

/** `Agent(Explore)` / `task(general)` for a subagent call, the bare tool name otherwise. */
export function toolKey(tool, input) {
	const type = input && typeof input.subagent_type === 'string' ? input.subagent_type : undefined;
	return type && /^(agent|task)$/i.test(tool) ? `${tool}(${type})` : tool;
}

/** A reason to refuse this call, or undefined to let it run. */
export function refusal(tool, input, env = process.env) {
	if (env.JARVIS_CODE_RUN !== '1') return undefined;
	const blocked = new Set((env.JARVIS_CODE_BLOCKED || '').split(',').map((s) => s.trim()).filter(Boolean));
	const key = toolKey(tool, input);
	if (blocked.has(key) || blocked.has(tool))
		return `jarvis-code switched off ${key} for this agent: it kept failing in this environment. Use another tool or do it directly.`;
	const command = input && typeof input.command === 'string' ? input.command : '';
	if (env.JARVIS_CODE_ROLE !== 'orchestrator' && /^(bash|shell|exec_command)$/i.test(tool) && changesForeman(command))
		return 'jarvis-code owns Foreman task state for this run: do the task and report; it records evidence and closes the task.';
	return undefined;
}
