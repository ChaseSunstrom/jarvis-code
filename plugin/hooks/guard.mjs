// The one rule set every jarvis-code worker integration applies (Claude Code, Codex, OpenCode).
// Pure: it reads the environment jarvis-code sets on the worker and answers allow or deny.

/** `jarvis-code` verbs that only read: anything else plans, runs or changes the queue. */
const READ_ONLY = /^(status|tasks|learn|doctor|config|help|--help|-h|--version|-v)$/;
/** Verbs that change state or start a run, for either name. `jc` is also another tool's name (JSON conversion), so for it only these count. */
const STATE_VERBS = /^(run|work|demo|task|plugin|learn|config)$/;
/** Words that run the word after them as the command (`env jc …`, `then jc …`). */
const PREFIXES = /^(env|command|exec|nohup|time|sudo|npx|then|do|else|if|while|until|!)$/;

/** Whether `bin verb sub` changes jarvis-code state; `strict` = only the explicit state verbs count. */
function changes(bin, verb = '', sub = '', strict = false) {
	if (bin !== 'jarvis-code' && bin !== 'jc') return false;
	if (verb === 'task') return sub !== 'show';
	if (verb === 'learn') return sub === 'reset';
	if (verb === 'config') return sub === 'init';
	if (bin === 'jc' || strict) return STATE_VERBS.test(verb) || (bin === 'jarvis-code' && !verb);
	return !READ_ONLY.test(verb);
}

function scan(line, separators, strict) {
	for (const segment of line.split(separators)) {
		const words = segment.trim().split(/\s+/);
		let i = 0;
		while (i < words.length && (PREFIXES.test(words[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) i++;
		if (changes(words[i]?.replace(/^.*\//, ''), words[i + 1], words[i + 2], strict)) return true;
	}
	return false;
}

/**
 * Whether a shell line changes jarvis-code's task state or starts another run anywhere in
 * it. Two views of the line: with quotes and escapes removed the way the shell joins words
 * (`jarvis-cod"e" task …`), and split at quotes and substitutions so a command inside
 * `bash -c "…"` or `$(…)` is seen too; that second view counts only explicit state verbs,
 * so quoted prose that mentions jarvis-code is not a command.
 * ponytail: a guardrail for cooperative agents, not a sandbox — a command built from
 * variables (`$J task add`) gets through; the orchestrator's own checks are the backstop.
 */
export function changesTaskState(command) {
	return scan(command.replace(/["'\\]/g, ''), /[\n;&|()`{}]/, false) || scan(command, /[\n;&|()`'"{}]/, true);
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
	if (env.JARVIS_CODE_ROLE !== 'orchestrator' && /^(bash|shell|exec_command)$/i.test(tool) && changesTaskState(command))
		return 'jarvis-code owns the task queue for this run and is already running: do your task and report. It runs the checks, records the evidence and closes the task.';
	return undefined;
}
