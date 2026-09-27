import type { AgentConfig } from '../config.js';
import { outcomeFromExit, run } from './spawn.js';
import { summarize, type AgentRun, type Emit, type Outcome, type RunSpec } from './types.js';

type Obj = Record<string, any>;

const EDIT_TOOLS = new Set(['edit', 'write', 'patch', 'multiedit']);

/**
 * `opencode run --format json` → AgentEvents. Each line is `{type, sessionID, part}`:
 * `step_start`, `text` (part.text), `tool_use` (part.tool, part.state.{status,input,output,error}),
 * `step_finish` (part.cost, part.tokens) and `error` (error.data.message).
 */
export class OpencodeParser {
	final: Partial<Outcome> = {};
	private cost = 0;
	private session?: string;
	constructor(private emit: Emit, private model?: string) {}

	line(v: unknown): void {
		if (typeof v !== 'object' || v === null) return;
		const e = v as Obj;
		if (e.sessionID && !this.session) {
			this.session = e.sessionID;
			this.emit({ type: 'init', session: e.sessionID, model: this.model });
		}
		const part = e.part ?? {};
		switch (e.type) {
			case 'text':
				if (part.text?.trim()) {
					this.final.summary = part.text;
					this.emit({ type: 'text', text: part.text });
				}
				return;
			case 'tool_use': {
				const st = part.state ?? {};
				const type = st.input?.subagent_type;
				const name = part.tool === 'task' && type ? `task(${type})` : String(part.tool ?? 'tool');
				this.emit({ type: 'tool', id: part.callID, name, summary: summarize(name, st.input) });
				if (EDIT_TOOLS.has(part.tool) && st.input?.filePath) this.emit({ type: 'change', path: st.input.filePath });
				if (st.status === 'completed' || st.status === 'error')
					this.emit({ type: 'tool_result', id: part.callID, name, ok: st.status === 'completed', error: st.error ? String(st.error).slice(0, 300) : undefined });
				return;
			}
			case 'step_finish':
				if (typeof part.cost === 'number') {
					this.cost += part.cost;
					this.final.costUsd = this.cost;
					this.emit({ type: 'usage', costUsd: this.cost });
				}
				return;
			case 'error': {
				const msg = e.error?.data?.message ?? e.error?.message ?? e.error?.name ?? 'error';
				this.final.ok = false;
				this.final.error = String(msg).slice(0, 300);
				return;
			}
		}
	}
}

export function opencodeArgs(cfg: AgentConfig, spec: RunSpec): string[] {
	const args = ['run', '--format', 'json'];
	if (spec.model) args.push('--model', spec.model);
	if (spec.role === 'planner') args.push('--agent', 'plan');
	args.push(...cfg.args);
	args.push(spec.context ? `${spec.context}\n\n---\n\n${spec.prompt}` : spec.prompt);
	return args;
}

export function start(cfg: AgentConfig, spec: RunSpec, emit: Emit): AgentRun {
	const parser = new OpencodeParser(emit, spec.model);
	const p = run(cfg.bin, opencodeArgs(cfg, spec), { cwd: spec.cwd, env: { ...cfg.env, ...spec.env }, timeoutMin: cfg.timeoutMin }, (v) => parser.line(v));
	return { done: p.exited.then((x) => outcomeFromExit(x, parser.final, emit)), kill: p.kill };
}
