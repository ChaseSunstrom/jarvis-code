import type { AgentConfig, AgentKind } from '../config.js';
import * as claude from './claude.js';
import * as codex from './codex.js';
import * as generic from './generic.js';
import * as opencode from './opencode.js';
import { clean, type AgentEvent, type AgentRun, type Emit, type Outcome, type RunSpec } from './types.js';

export * from './types.js';

const ADAPTERS: Record<AgentKind, { start(cfg: AgentConfig, spec: RunSpec, emit: Emit): AgentRun }> = { claude, codex, opencode, generic };

/** Every string field of an event or outcome, cleaned (events and outcomes are flat). */
function cleaned<T extends object>(o: T): T {
	const out = { ...o } as Record<string, unknown>;
	for (const [k, v] of Object.entries(out)) {
		if (typeof v === 'string') out[k] = clean(v);
		else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'string' ? clean(x) : x));
	}
	return out as T;
}

/** Start an agent. Everything it says passes through `clean` here, the one way in. */
export function startAgent(cfg: AgentConfig, spec: RunSpec, emit: Emit): AgentRun {
	const run = ADAPTERS[cfg.kind].start(cfg, spec, (e: AgentEvent) => emit(cleaned(e)));
	return { ...run, done: run.done.then((o: Outcome) => cleaned(o)) };
}
