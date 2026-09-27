import type { AgentConfig } from '../config.js';
import { outcomeFromExit, run } from './spawn.js';
import { sameModel, summarize, type AgentRun, type Emit, type Outcome, type RunSpec } from './types.js';

type Obj = Record<string, any>;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** `Agent(Explore)` for a subagent call, the bare name otherwise: the key learning and blocking use. */
export function toolKey(name: string, input: unknown): string {
	const type = (input as Obj | undefined)?.subagent_type;
	return (name === 'Agent' || name === 'Task') && typeof type === 'string' ? `${name}(${type})` : name;
}

function diffOf(name: string, input: Obj): string | undefined {
	const cut = (s: unknown, sign: string) =>
		String(s ?? '').split('\n').slice(0, 12).map((l) => sign + l).join('\n');
	if (name === 'Edit') return `${cut(input.old_string, '- ')}\n${cut(input.new_string, '+ ')}`;
	if (name === 'Write') return cut(input.content, '+ ');
	if (name === 'MultiEdit' && Array.isArray(input.edits))
		return input.edits.map((e: Obj) => `${cut(e.old_string, '- ')}\n${cut(e.new_string, '+ ')}`).join('\n');
	return undefined;
}

/**
 * Claude Code `--output-format stream-json` → AgentEvents.
 *
 * Model switches arrive as `system` events: `model_refusal_fallback` (a flagged message
 * moved the session to a fallback model; `direction: sticky` keeps it there),
 * `model_consent_fallback` (a usage-credit gate swapped the session model) and
 * `model_fallback` (turn-scoped overload/availability fallback: the primary is retried
 * next turn). A main-thread assistant message on an unexpected model is the backstop.
 */
export class ClaudeParser {
	final: Partial<Outcome> = {};
	/** The model the session is on now. */
	model?: string;
	/** A switch the CLI accepted; it takes effect at the next turn's `init`. */
	accepted?: string;
	readonly tools = new Map<string, string>();
	readonly pending = new Map<string, string>();
	readonly results: string[] = [];
	constructor(private emit: Emit) {}

	line(v: unknown): void {
		if (typeof v !== 'object' || v === null) return;
		const e = v as Obj;
		switch (e.type) {
			case 'system':
				return this.system(e);
			case 'assistant':
				return this.assistant(e);
			case 'user':
				return this.toolResults(e);
			case 'result':
				this.results.push(typeof e.result === 'string' ? e.result : '');
				this.final = {
					results: this.results,
					ok: e.subtype === 'success' && !e.is_error,
					summary: typeof e.result === 'string' ? e.result : '',
					costUsd: e.total_cost_usd,
					model: this.model,
					error: e.is_error || e.subtype !== 'success' ? String(e.result || e.subtype || 'error').slice(0, 300) : undefined,
				};
				this.emit({ type: 'usage', costUsd: e.total_cost_usd });
				return;
			case 'control_response': {
				const r = e.response ?? {};
				const model = this.pending.get(r.request_id);
				if (model === undefined) return;
				this.pending.delete(r.request_id);
				// Accepted is not applied: the CLI keeps the running turn on its model and
				// starts the next one on the new model (verified against Claude Code 2.1.280).
				if (r.subtype === 'success') this.accepted = model;
				else {
					this.emit({ type: 'reupgrade', model, ok: false });
					this.emit({ type: 'log', text: `set_model ${model} refused: ${r.error ?? 'unknown'}` });
				}
				return;
			}
		}
	}

	private system(e: Obj): void {
		switch (e.subtype) {
			case 'init':
				// Every turn opens with an init; the one after an accepted switch confirms it.
				this.model = e.model;
				this.emit({ type: 'init', model: e.model, session: e.session_id });
				if (this.accepted) {
					this.emit({ type: 'reupgrade', model: this.accepted, ok: sameModel(e.model, this.accepted) });
					this.accepted = undefined;
				}
				return;
			case 'model_refusal_fallback':
				if (e.scope === 'local') return; // a subagent's answer only; the session model is unchanged
				this.switched(e.original_model, e.fallback_model, `refusal${e.api_refusal_category ? `:${e.api_refusal_category}` : ''}`, e.direction !== 'revert');
				return;
			case 'model_consent_fallback':
				this.switched(e.original_model, e.fallback_model, 'consent', true);
				return;
			case 'model_fallback':
				this.emit({ type: 'model', from: e.original_model, to: e.fallback_model, reason: e.trigger ?? 'fallback', sticky: false });
				return;
			case 'model_refusal_no_fallback':
				this.emit({ type: 'log', text: `refused with no fallback: ${e.content ?? ''}`.slice(0, 200) });
				return;
		}
	}

	private switched(from: string | undefined, to: string, reason: string, sticky: boolean): void {
		if (sticky) this.model = to;
		this.emit({ type: 'model', from, to, reason, sticky });
	}

	private assistant(e: Obj): void {
		const m = e.message ?? {};
		const main = !e.parent_tool_use_id;
		// The backstop for a switch no event announced. Ids are compared without their `[1m]`-style
		// suffix: the session is started as `x[1m]` while its messages report `x`.
		if (main && this.model && m.model && !sameModel(m.model, this.model) && !sameModel(m.model, this.accepted) && m.model !== '<synthetic>') {
			this.switched(this.model, m.model, 'switched', true);
		}
		for (const c of m.content ?? []) {
			if (c.type === 'text' && main && c.text?.trim()) this.emit({ type: 'text', text: c.text });
			else if (c.type === 'tool_use') {
				const key = toolKey(c.name, c.input);
				this.tools.set(c.id, key);
				this.emit({ type: 'tool', id: c.id, name: key, summary: summarize(key, c.input) });
				if (EDIT_TOOLS.has(c.name)) {
					const path = c.input?.file_path ?? c.input?.notebook_path;
					if (path) this.emit({ type: 'change', path, diff: diffOf(c.name, c.input ?? {}) });
				}
			}
		}
	}

	private toolResults(e: Obj): void {
		const content = e.message?.content;
		if (!Array.isArray(content)) return;
		for (const c of content) {
			if (c.type !== 'tool_result') continue;
			const name = this.tools.get(c.tool_use_id) ?? 'unknown';
			const text = Array.isArray(c.content) ? c.content.map((x: Obj) => x.text ?? '').join(' ') : String(c.content ?? '');
			this.emit({ type: 'tool_result', id: c.tool_use_id, name, ok: !c.is_error, error: c.is_error ? text.slice(0, 300) : undefined });
		}
	}
}

export function claudeArgs(cfg: AgentConfig, spec: RunSpec): string[] {
	const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
	if (spec.model) args.push('--model', spec.model);
	if (cfg.disablePlugins.length)
		args.push('--settings', JSON.stringify({ enabledPlugins: Object.fromEntries(cfg.disablePlugins.map((p) => [p, false])) }));
	if (spec.pluginDir) args.push(`--plugin-dir=${spec.pluginDir}`);
	// `Agent(Explore)`-style keys are refused by the plugin's hook; plain names by the CLI.
	const deny = spec.blockedTools.filter((t) => !t.includes('('));
	if (spec.role === 'planner') deny.push(...EDIT_TOOLS);
	if (spec.tools === 'none') args.push('--tools', '');
	else if (deny.length) args.push(`--disallowedTools=${deny.join(',')}`);
	if (spec.context) args.push('--append-system-prompt', spec.context);
	return [...args, ...cfg.args];
}

/** The turn that hands a downgraded task back to the model it was meant for. */
export const followUp = (model: string, role: RunSpec['role']) =>
	`An automatic fallback moved part of this task to another model; you are back on ${model}. ` +
	(role === 'planner'
		? 'Review the plan you gave, fix anything wrong with it, and reply again with ONLY the final JSON plan.'
		: 'Review what was done for the task in this session, fix or finish anything missing, run its checks, and reply with the final summary.');

export function start(cfg: AgentConfig, spec: RunSpec, emit: Emit): AgentRun {
	const parser = new ClaudeParser(emit);
	let ids = 0;
	let followed = false;
	const p = run(cfg.bin, claudeArgs(cfg, spec), { cwd: spec.cwd, env: { ...cfg.env, ...spec.env }, timeoutMin: cfg.timeoutMin, idleMin: cfg.idleMin, stdin: true }, (v) => {
		const accepted = parser.accepted;
		parser.line(v);
		if ((v as Obj)?.type !== 'result') return;
		// A switch back only applies from the next turn, so a downgraded turn gets one more
		// turn on the restored model; otherwise stream-json input would wait for more input.
		if (accepted && !followed) {
			followed = true;
			send({ type: 'user', message: { role: 'user', content: followUp(accepted, spec.role) } });
		} else p.child.stdin?.end();
	});
	const send = (o: object) => {
		const s = p.child.stdin;
		if (s && !s.writableEnded && !s.destroyed) s.write(JSON.stringify(o) + '\n');
	};
	p.child.stdin?.on('error', () => {}); // the CLI exiting early must not crash the orchestrator
	send({ type: 'user', message: { role: 'user', content: spec.prompt } });
	return {
		done: p.exited.then((x) => outcomeFromExit(x, parser.final, emit)),
		kill: p.kill,
		setModel(model: string) {
			const id = `jc-${++ids}`;
			parser.pending.set(id, model);
			send({ type: 'control_request', request_id: id, request: { subtype: 'set_model', model } });
		},
	};
}
