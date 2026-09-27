import type { AgentConfig } from '../config.js';
import { outcomeFromExit, run } from './spawn.js';
import { summarize, type AgentRun, type Emit, type Outcome, type RunSpec } from './types.js';

type Obj = Record<string, any>;

/**
 * `codex exec --json` → AgentEvents. Events: `thread.started`, `turn.started`,
 * `turn.completed` (usage), `turn.failed`, `error`, and `item.started|updated|completed`
 * whose item is an `agent_message`, `reasoning`, `command_execution`, `file_change`,
 * `mcp_tool_call`, `web_search`, `todo_list` or `error`. Unknown events are ignored, so
 * a newer Codex degrades to "final message + exit code" instead of breaking.
 */
export class CodexParser {
	final: Partial<Outcome> = {};
	private started = new Set<string>();
	constructor(private emit: Emit) {}

	line(v: unknown): void {
		if (typeof v !== 'object' || v === null) return;
		const e = v as Obj;
		if (e.type === 'thread.started') this.emit({ type: 'init', session: e.thread_id, model: e.model });
		else if (e.type === 'turn.completed') {
			const u = e.usage ?? {};
			this.emit({ type: 'usage', tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) });
		} else if (e.type === 'turn.failed' || e.type === 'error') {
			const msg = e.error?.message ?? e.message ?? 'failed';
			this.final.ok = false;
			this.final.error = String(msg).slice(0, 300);
		} else if (typeof e.type === 'string' && e.type.startsWith('item.') && e.item) this.item(e.type.slice(5), e.item);
	}

	private item(phase: string, it: Obj): void {
		const id = String(it.id ?? '');
		const tool = (name: string, input: unknown) => {
			if (this.started.has(id)) return;
			this.started.add(id);
			this.emit({ type: 'tool', id, name, summary: summarize(name, input) });
		};
		switch (it.type) {
			case 'agent_message':
				if (phase === 'completed' && it.text) {
					this.final.summary = it.text;
					this.emit({ type: 'text', text: it.text });
				}
				return;
			case 'command_execution':
				tool('Bash', { command: it.command });
				if (phase === 'completed' || it.status === 'failed')
					this.emit({ type: 'tool_result', id, name: 'Bash', ok: it.exit_code === 0 && it.status !== 'failed', error: it.exit_code === 0 ? undefined : String(it.aggregated_output ?? '').slice(-300) });
				return;
			case 'file_change':
				tool('Edit', { path: it.changes?.map((c: Obj) => c.path).join(', ') });
				if (phase === 'completed') for (const c of it.changes ?? []) this.emit({ type: 'change', path: c.path, diff: c.kind });
				return;
			case 'mcp_tool_call': {
				const name = `mcp__${it.server}__${it.tool}`;
				tool(name, it.arguments);
				if (phase === 'completed' || it.status === 'failed')
					this.emit({ type: 'tool_result', id, name, ok: it.status !== 'failed' && !it.error, error: it.error?.message ?? it.error });
				return;
			}
			case 'web_search':
				tool('WebSearch', { query: it.query });
				return;
			case 'error':
				this.emit({ type: 'log', text: String(it.message ?? '').slice(0, 300) });
				return;
		}
	}
}

export function codexArgs(cfg: AgentConfig, spec: RunSpec): string[] {
	const args = ['exec', '--json'];
	if (spec.model) args.push('--model', spec.model);
	// `codex exec` defaults to a read-only sandbox: a worker could never write. A sandbox the
	// config already chose wins (Codex refuses the flag twice).
	const chosen = cfg.args.some((a) => /^(-s|--sandbox|--full-auto|--dangerously-bypass-approvals-and-sandbox)(=|$)/.test(a));
	if (!chosen) args.push('--sandbox', spec.role === 'planner' ? 'read-only' : 'workspace-write');
	args.push(...cfg.args);
	// Codex has no system-prompt flag: the context leads the prompt.
	args.push(spec.context ? `${spec.context}\n\n---\n\n${spec.prompt}` : spec.prompt);
	return args;
}

export function start(cfg: AgentConfig, spec: RunSpec, emit: Emit): AgentRun {
	const parser = new CodexParser(emit);
	const p = run(cfg.bin, codexArgs(cfg, spec), { cwd: spec.cwd, env: { ...cfg.env, ...spec.env }, timeoutMin: cfg.timeoutMin, idleMin: cfg.idleMin }, (v) => parser.line(v));
	return { done: p.exited.then((x) => outcomeFromExit(x, parser.final, emit)), kill: p.kill };
}
