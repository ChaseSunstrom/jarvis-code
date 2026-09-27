import type { AgentConfig } from '../config.js';
import { outcomeFromExit, run } from './spawn.js';
import type { AgentRun, Emit, RunSpec } from './types.js';

/**
 * Any command-line agent: `bin` with `args`, where `{prompt}` and `{model}` are replaced.
 * stdout lines are its messages, the last one its summary, exit 0 its success. The prompt
 * is also in JARVIS_CODE_PROMPT for tools that read it from the environment.
 */
export function start(cfg: AgentConfig, spec: RunSpec, emit: Emit): AgentRun {
	const prompt = spec.context ? `${spec.context}\n\n---\n\n${spec.prompt}` : spec.prompt;
	const args = cfg.args.map((a) => a.replaceAll('{prompt}', prompt).replaceAll('{model}', spec.model ?? ''));
	let last = '';
	const p = run(cfg.bin, args, { cwd: spec.cwd, env: { ...cfg.env, ...spec.env, JARVIS_CODE_PROMPT: prompt }, timeoutMin: cfg.timeoutMin }, (_v, raw) => {
		if (!raw.trim()) return;
		last = raw;
		emit({ type: 'text', text: raw });
	});
	emit({ type: 'init', model: spec.model });
	return { done: p.exited.then((x) => outcomeFromExit(x, { summary: last }, emit)), kill: p.kill };
}
