import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentEnabled, paths, type Config } from './config.js';

/**
 * What jarvis-code has learned about routes (agent + model) and tools (per orchestrating
 * agent): a decayed success rate with a circuit breaker. A route or tool that keeps
 * failing is switched off for `cooldownMin`, then gets one probe; a failed probe doubles
 * the cooldown, a passed one switches it back on.
 */
export interface Stat {
	/** Decayed successes and total. */
	s: number;
	n: number;
	runs: number;
	ok: number;
	last?: string;
	disabledUntil?: string;
	backoff?: number;
	reason?: string;
}

export interface LearningData {
	routes: Record<string, Stat>;
	tools: Record<string, Stat>;
	/** Worker outcomes per `route@TYPE`: a route can be good at one kind of task and bad at another. */
	kinds: Record<string, Stat>;
}

export interface Route {
	/** `agent` or `agent:model`. */
	id: string;
	agent: string;
	model?: string;
}

/** Tools a run cannot work without: never switched off by learning, whatever their error rate. */
const CORE = new Set(
	['bash', 'read', 'edit', 'write', 'multiedit', 'notebookedit', 'glob', 'grep', 'ls', 'list', 'patch', 'todowrite', 'todoread', 'skill', 'toolsearch', 'exitplanmode', 'unknown'],
);

export const score = (st: Stat | undefined) => (st ? (st.s + 1) / (st.n + 2) : 0.5);

export class Learning {
	data: LearningData;
	constructor(
		private cfg: Config['learning'],
		private file = join(paths.stateDir(), 'learning.json'),
		private now = () => Date.now(),
	) {
		this.data = { routes: {}, tools: {}, kinds: {} };
		try {
			const raw = JSON.parse(readFileSync(file, 'utf8'));
			this.data = { routes: raw.routes ?? {}, tools: raw.tools ?? {}, kinds: raw.kinds ?? {} };
		} catch {
			/* first run, or an unreadable file: start fresh rather than refuse to run */
		}
	}

	save(): void {
		mkdirSync(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.data, null, 2));
		renameSync(tmp, this.file);
	}

	/** Record an outcome; returns a reason string when this outcome switched the key off. */
	private record(table: Record<string, Stat>, key: string, ok: boolean): string | undefined {
		if (!this.cfg.enabled) return;
		const st = (table[key] ??= { s: 0, n: 0, runs: 0, ok: 0 });
		const d = this.cfg.decay;
		st.s = st.s * d + (ok ? 1 : 0);
		st.n = st.n * d + 1;
		st.runs++;
		if (ok) st.ok++;
		st.last = new Date(this.now()).toISOString();
		const probing = st.disabledUntil !== undefined;
		if (ok && probing) {
			// A passed probe: back on, and old failures weigh half.
			delete st.disabledUntil;
			delete st.reason;
			st.backoff = 1;
			st.s /= 2;
			st.n /= 2;
			return;
		}
		if (!ok && (probing || (st.runs >= this.cfg.minSamples && score(st) < this.cfg.disableBelow))) {
			st.backoff = probing ? Math.min((st.backoff ?? 1) * 2, 16) : st.backoff ?? 1;
			st.disabledUntil = new Date(this.now() + this.cfg.cooldownMin * 60_000 * st.backoff).toISOString();
			st.reason = `${Math.round(score(st) * 100)}% recent success (${st.ok}/${st.runs} runs)`;
			return st.reason;
		}
	}

	recordRoute(route: string, ok: boolean) {
		return this.record(this.data.routes, route, ok);
	}

	/** A worker outcome for one task type; returns a reason when the route is now off for that type. */
	recordKind(route: string, type: string, ok: boolean) {
		return this.record(this.data.kinds, `${route}@${type.toUpperCase()}`, ok);
	}

	kind(route: string, type?: string): Stat | undefined {
		return type ? this.data.kinds[`${route}@${type.toUpperCase()}`] : undefined;
	}

	/** The route is off, or off for this task type. */
	offFor(route: string, type?: string): boolean {
		return this.routeOff(route) || this.isOff(this.kind(route, type));
	}

	/** Tool outcomes count only for tools a run can do without (subagents, MCP, web...). */
	recordTool(agent: string, tool: string, ok: boolean) {
		if (!learnable(tool, this.cfg.neverBlock)) return;
		return this.record(this.data.tools, `${agent}|${tool}`, ok);
	}

	/** Off and still cooling down. After the cooldown the key is allowed for one probe. */
	isOff(st: Stat | undefined): boolean {
		return !!st?.disabledUntil && Date.parse(st.disabledUntil) > this.now();
	}

	routeOff(id: string) {
		return this.isOff(this.data.routes[id]);
	}

	blockedTools(agent: string): string[] {
		if (!this.cfg.blockTools) return [];
		return Object.entries(this.data.tools)
			.filter(([k, st]) => k.startsWith(`${agent}|`) && this.isOff(st))
			.map(([k]) => k.slice(agent.length + 1));
	}

	/** Clear what was learned about a route or tool key (or everything). */
	reset(key?: string): void {
		if (!key) this.data = { routes: {}, tools: {}, kinds: {} };
		else this.forgive(key);
	}

	/**
	 * Forget what was learned about a route (`claude:model`), a tool under one agent
	 * (`claude › Agent(Explore)` or `claude|Agent(Explore)`), or a tool under every agent
	 * (`Agent(Explore)`). Returns the keys forgotten.
	 */
	forgive(query: string): string[] {
		const q = query.trim().replace(/\s*›\s*/, '|');
		const gone = [
			...Object.keys(this.data.routes).filter((k) => k === q),
			...Object.keys(this.data.tools).filter((k) => k === q || k.endsWith(`|${q}`)),
			// A route's per-type records go with it; `route@TYPE` forgives just that type.
			...Object.keys(this.data.kinds).filter((k) => k === q || k.startsWith(`${q}@`)),
		];
		for (const k of gone) {
			delete this.data.routes[k];
			delete this.data.tools[k];
			delete this.data.kinds[k];
		}
		return gone;
	}
}

export function learnable(tool: string, neverBlock: string[] = []): boolean {
	const t = tool.toLowerCase();
	return !CORE.has(t) && !neverBlock.some((n) => n.toLowerCase() === t);
}

export function parseRoute(id: string): Route {
	const i = id.indexOf(':');
	return i < 0 ? { id, agent: id } : { id, agent: id.slice(0, i), model: id.slice(i + 1) };
}

export type Role = 'promptWriter' | 'brainstorm' | 'critic' | 'planner' | 'reviewer' | 'worker';

/**
 * The routes for a role, in preference order, from the first of these levels that still has an
 * enabled agent: `using` · routes[TYPE] (workers only) · routes[role] · the legacy planner/workers
 * lists · routes.default · every enabled agent × model. So a bad override never leaves a role without one.
 */
export function routesFor(config: Config, role: Role, enabled = agentEnabled, opts: { type?: string; using?: string[] } = {}): Route[] {
	const on = (r: Route) => !!config.agents[r.agent] && enabled(config.agents[r.agent]);
	const legacy = role === 'worker' ? config.workers : role === 'brainstorm' || role === 'reviewer' ? [...new Set([...config.planner, ...config.workers])] : config.planner;
	const levels = [opts.using, role === 'worker' && opts.type ? config.routes[opts.type.toUpperCase()] : undefined, config.routes[role === 'worker' ? 'workers' : role], legacy, config.routes.default];
	for (const ids of levels) {
		const routes = (ids ?? []).map(parseRoute).filter(on);
		if (routes.length) return routes;
	}
	return Object.entries(config.agents)
		.flatMap(([agent, a]) => (a.models.length ? a.models.map((model) => ({ id: `${agent}:${model}`, agent, model })) : [{ id: agent, agent }]))
		.filter(on);
}

/** What a route is being chosen for: its task's type and tier, when it is a task. */
export interface For {
	type?: string;
	tier?: string;
}

/**
 * The route to use next, and why. Skips `exclude` (routes this task already failed on) and
 * routes switched off (overall, or for this task's type); when every route is off, the one
 * whose cooldown ends first is probed early rather than stalling the queue.
 *
 * - `priority`: the first healthy route in your order.
 * - `best`: the highest learned score, for this task type once it has a record, else overall.
 * - `escalate`: your order read as cheapest → strongest. S tasks start cheap, M in the
 *   middle, L and SECURITY at the strongest; each failure moves to the next.
 */
export function choose(routes: Route[], learning: Learning, strategy: Config['strategy'], exclude: Set<string> = new Set(), task: For = {}): { route: Route; why: string } | undefined {
	const open = routes.filter((r) => !exclude.has(r.id));
	const type = task.type?.toUpperCase();
	let order = open;
	let start = 'cheapest';
	if (strategy === 'escalate') {
		if (/^L$/i.test(task.tier ?? '') || type === 'SECURITY') [order, start] = [[...open].reverse(), 'strongest'];
		else if (/^M$/i.test(task.tier ?? '')) {
			const mid = Math.floor(open.length / 2);
			[order, start] = [[...open.slice(mid), ...open.slice(0, mid).reverse()], 'mid-range'];
		}
	}
	const healthy = order.filter((r) => !learning.offFor(r.id, type));
	if (healthy.length) {
		const retry = exclude.size ? ', after a failed attempt' : '';
		if (strategy === 'best') {
			const typed = (r: Route) => {
				const k = learning.kind(r.id, type);
				return k && k.runs >= 3 ? k : undefined;
			};
			const rate = (r: Route) => score(typed(r) ?? learning.data.routes[r.id]);
			const best = healthy.reduce((a, r) => (rate(r) > rate(a) ? r : a));
			const st = typed(best) ?? learning.data.routes[best.id];
			return { route: best, why: st ? `best ${typed(best) ? `for ${type}` : 'overall'}: ${Math.round(score(st) * 100)}% of ${st.runs}${retry}` : `no record yet${retry}` };
		}
		if (strategy === 'escalate') return { route: healthy[0], why: exclude.size ? 'escalating after a failed attempt' : `${task.tier ?? 'S'}${type === 'SECURITY' ? ' SECURITY' : ''} task: starts ${start}` };
		return { route: healthy[0], why: `first healthy in your order${retry}` };
	}
	const until = (r: Route) => Math.max(Date.parse(learning.data.routes[r.id]?.disabledUntil ?? '0'), Date.parse(learning.kind(r.id, type)?.disabledUntil ?? '0'));
	const route = open.sort((a, b) => until(a) - until(b))[0];
	return route && { route, why: 'every route is off: probing the one whose cooldown ends first' };
}

export function pick(routes: Route[], learning: Learning, strategy: Config['strategy'], exclude: Set<string> = new Set(), task: For = {}): Route | undefined {
	return choose(routes, learning, strategy, exclude, task)?.route;
}

/** A route's per-type record, most runs first, at most 4: 'FIX 3/4, FEATURE 5/6'. '' when there is none. */
export function kindSummary(learning: Learning, route: string): string {
	const prefix = `${route}@`;
	return Object.entries(learning.data.kinds)
		.filter(([k]) => k.startsWith(prefix))
		.sort(([, a], [, b]) => b.runs - a.runs)
		.slice(0, 4)
		.map(([k, st]) => `${k.slice(prefix.length)} ${st.ok}/${st.runs}`)
		.join(', ');
}
