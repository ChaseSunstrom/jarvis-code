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
		this.data = { routes: {}, tools: {} };
		try {
			const raw = JSON.parse(readFileSync(file, 'utf8'));
			this.data = { routes: raw.routes ?? {}, tools: raw.tools ?? {} };
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
		if (!key) this.data = { routes: {}, tools: {} };
		else {
			delete this.data.routes[key];
			delete this.data.tools[key];
		}
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

/** The routes for a role, in preference order: the configured list, or every enabled agent × model. */
export function routesFor(config: Config, role: 'planner' | 'worker', enabled = agentEnabled): Route[] {
	const listed = role === 'planner' ? config.planner : config.workers;
	const all = listed.length
		? listed.map(parseRoute)
		: Object.entries(config.agents).flatMap(([agent, a]) =>
				a.models.length ? a.models.map((model) => ({ id: `${agent}:${model}`, agent, model })) : [{ id: agent, agent }],
			);
	return all.filter((r) => config.agents[r.agent] && enabled(config.agents[r.agent]));
}

/**
 * The route to use next. Skips `exclude` (routes this task already failed on) and
 * switched-off routes; when every route is off, the one whose cooldown ends first is
 * probed early rather than stalling the queue.
 */
export function pick(routes: Route[], learning: Learning, strategy: Config['strategy'], exclude: Set<string> = new Set()): Route | undefined {
	const open = routes.filter((r) => !exclude.has(r.id));
	const healthy = open.filter((r) => !learning.routeOff(r.id));
	if (healthy.length) {
		if (strategy === 'priority') return healthy[0];
		return healthy.reduce((best, r) => (score(learning.data.routes[r.id]) > score(learning.data.routes[best.id]) ? r : best));
	}
	const until = (r: Route) => Date.parse(learning.data.routes[r.id]?.disabledUntil ?? '0');
	return open.sort((a, b) => until(a) - until(b))[0];
}
