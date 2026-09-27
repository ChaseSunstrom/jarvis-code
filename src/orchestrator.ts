import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { startAgent, type AgentEvent, type AgentRun, type Outcome, type RunSpec } from './agents/index.js';
import type { Config } from './config.js';
import { decide } from './downgrade.js';
import { Learning, learnable, pick, routesFor, score, type Route } from './learn.js';
import type { ReactorState } from './reactor.js';
import type { Check, PlannedTask, Task, TaskSource } from './tasks.js';

export type ActivityKind =
	| 'plan' | 'start' | 'done' | 'fail' | 'block' | 'review' | 'model' | 'learn' | 'info' | 'error'
	// Detail kinds, hidden unless the UI asks for them:
	| 'tool' | 'text' | 'change';

export interface Activity {
	at: number;
	kind: ActivityKind;
	text: string;
	detail?: string;
	task?: string;
}

export type TaskStatus = 'queued' | 'running' | 'verifying' | 'done' | 'failed' | 'blocked' | 'review';

export interface TaskView {
	id: string;
	title: string;
	type: string;
	tier: string;
	status: TaskStatus;
	attempts: number;
	route?: string;
	note?: string;
}

export interface WorkerView {
	key: string;
	task: string;
	title: string;
	route: string;
	model?: string;
	phase: 'planning' | 'running' | 'verifying';
	started: number;
	tools: number;
	last: string;
	cost: number;
}

export interface RouteView {
	id: string;
	off: boolean;
	score: number;
	runs: number;
	reason?: string;
}

export interface Snapshot {
	phase: 'idle' | 'planning' | 'working' | 'finished' | 'stopped';
	paused: boolean;
	goal?: string;
	source: string;
	tasks: TaskView[];
	workers: WorkerView[];
	activity: Activity[];
	cost: number;
	started: number;
	reactor: ReactorState;
	/** When the reactor entered its state (ms), for its alert/attention motions. */
	stateSince: number;
	routes: RouteView[];
	error?: string;
}

export const WORKER_CONTEXT = [
	'You are a worker under jarvis-code, an orchestrator that works a Foreman task queue with several coding agents.',
	'jarvis-code owns planning, verification and task state: do not run fm/Foreman commands, do not create or close tasks, and do not commit unless the task says to.',
	'Do the one task you are given, inside its scope, then run its checks yourself.',
	'Some tools may be switched off because they kept failing here; use an alternative instead of retrying them.',
].join(' ');

/**
 * The worker's standing instructions. Learned-off tools are named here for every agent:
 * the plugin refuses them where it is installed, and this keeps an agent without it (a
 * Codex or OpenCode not set up with `jarvis-code plugin install`) from reaching for them.
 */
export function workerContext(blocked: string[]): string {
	return blocked.length ? `${WORKER_CONTEXT} Switched off for you here because they kept failing, do not use: ${blocked.join(', ')}.` : WORKER_CONTEXT;
}

export const PLAN_MARKER = 'JARVIS-CODE PLAN';

export function plannerPrompt(goal: string, cwd: string): string {
	return `${PLAN_MARKER}
You are the planner for jarvis-code, which works a Foreman task queue with coding agents.
Goal: ${goal}
Repository: ${cwd}

Explore the repository as much as you need (read-only: do not edit anything). Then break the goal into small, independently verifiable tasks in dependency order. Each task:
- tier "S" (about 30 lines, 1-2 files) unless it truly cannot be split; type one of FIX, FEATURE, CLEAN, PERF, SECURITY, RESEARCH
- 1-3 acceptance criteria, each with a non-interactive shell "verify" command, run from the repository root, that exits 0 only when the criterion holds (a test, a build, a grep)
- concrete steps, and "notes" with what a worker needs (files, approach, pitfalls)
- "depends": keys of earlier tasks it needs

Reply with ONLY a JSON object, no prose:
{"tasks":[{"key":"t1","title":"...","type":"FEATURE","tier":"S","acs":[{"text":"...","verify":"..."}],"steps":["..."],"depends":[],"notes":"..."}]}`;
}

/** The plan out of a planner's reply: a fenced JSON block, or the outermost `{…}`. */
export function parsePlan(text: string): PlannedTask[] | undefined {
	const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
	const bare = text.includes('{') ? [text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)] : [];
	for (const candidate of [...fenced.reverse(), ...bare]) {
		try {
			const data = JSON.parse(candidate);
			const tasks = Array.isArray(data) ? data : data?.tasks;
			if (!Array.isArray(tasks) || !tasks.length) continue;
			if (!tasks.every((t) => t && typeof t.title === 'string' && t.title.trim())) continue;
			return tasks.map((t) => ({
				...t,
				acs: (Array.isArray(t.acs) ? t.acs : []).filter((a: unknown) => a && typeof (a as { text?: unknown }).text === 'string'),
				steps: Array.isArray(t.steps) ? t.steps.map(String) : [],
				depends: Array.isArray(t.depends) ? t.depends.map(String) : [],
			}));
		} catch {
			/* try the next candidate */
		}
	}
	return undefined;
}

export function workerPrompt(task: Task, cwd: string, previous?: string): string {
	const parts = [`Task ${task.id} (${task.type} ${task.tier}): ${task.title}`];
	if (task.brief) parts.push(task.brief);
	if (task.steps.length) parts.push('Steps:\n' + task.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'));
	if (task.acs.length)
		parts.push(
			'Done when (jarvis-code runs these checks after you finish; make them pass):\n' +
				task.acs.map((a) => `- ${a.text}${a.verify ? ` — \`${a.verify}\`` : ''}`).join('\n'),
		);
	if (previous) parts.push(`A previous attempt failed. Learn from it:\n${previous}`);
	parts.push(`Work in ${cwd}. Make the change, run the checks, and finish with a short summary of what you changed. If you cannot finish, reply "BLOCKED: <why>".`);
	return parts.join('\n\n');
}

interface Launched extends Outcome {
	/** A downgrade policy asked for the task to be rerun on this model. */
	retryModel?: string;
	subagents: Set<string>;
}

/**
 * Works a task source with the configured agents: optionally plans a goal into tasks,
 * then dispatches each task to a route (agent + model) chosen by preference and what was
 * learned, verifies it, records the outcome and retries on another route when it fails.
 * Emits `update` whenever the snapshot changes and `activity` for each feed entry.
 */
export class Orchestrator extends EventEmitter {
	private tasks = new Map<string, TaskView>();
	private workers = new Map<string, WorkerView>();
	private runs = new Map<string, AgentRun>();
	private activity: Activity[] = [];
	private handled = new Set<string>();
	private inflight = new Set<string>();
	private spent = 0;
	private phase: Snapshot['phase'] = 'idle';
	private stopped = false;
	private alertAt = 0;
	private reactorState: ReactorState = 'idle';
	private stateSince = Date.now();
	private started = Date.now();
	private goal?: string;
	private error?: string;
	paused = false;

	constructor(
		public config: Config,
		private source: TaskSource,
		public learning: Learning,
		private cwd: string,
		private opts: { pluginDir?: string } = {},
	) {
		super();
	}

	snapshot(): Snapshot {
		const workers = [...this.workers.values()];
		const tasks = [...this.tasks.values()];
		const routes = [...new Map([...routesFor(this.config, 'planner'), ...routesFor(this.config, 'worker')].map((r) => [r.id, r])).values()];
		let reactor: ReactorState;
		const live = this.phase === 'planning' || this.phase === 'working';
		if (this.phase === 'stopped') reactor = 'kill';
		else if (!routes.length) reactor = 'offline';
		// A failure flashes the reactor mid-run; once the run is over its outcome shows instead.
		else if (live && Date.now() - this.alertAt < 4000) reactor = 'alert';
		else if (this.phase === 'planning') reactor = 'thinking';
		else if (workers.length) reactor = 'tool';
		else if (this.phase === 'finished' && (this.error || tasks.some((t) => t.status === 'blocked' || t.status === 'review'))) reactor = 'attention';
		else reactor = 'idle';
		if (reactor !== this.reactorState) {
			this.reactorState = reactor;
			this.stateSince = Date.now();
		}
		return {
			phase: this.phase,
			paused: this.paused,
			goal: this.goal,
			source: this.source.name,
			tasks,
			workers,
			activity: this.activity,
			cost: this.spent + workers.reduce((s, w) => s + w.cost, 0),
			started: this.started,
			reactor,
			stateSince: this.stateSince,
			routes: routes.map((r) => {
				const st = this.learning.data.routes[r.id];
				return { id: r.id, off: this.learning.routeOff(r.id), score: score(st), runs: st?.runs ?? 0, reason: st?.reason };
			}),
			error: this.error,
		};
	}

	private changed() {
		this.emit('update');
	}

	note(kind: ActivityKind, text: string, extra: { detail?: string; task?: string } = {}) {
		const a: Activity = { at: Date.now(), kind, text, ...extra };
		this.activity.push(a);
		if (this.activity.length > 1000) this.activity.splice(0, this.activity.length - 1000);
		this.emit('activity', a);
		this.changed();
	}

	togglePause() {
		this.paused = !this.paused;
		this.note('info', this.paused ? 'Paused: running tasks finish, no new ones start' : 'Resumed');
	}

	stop() {
		if (this.stopped) return;
		this.stopped = true;
		for (const r of this.runs.values()) r.kill();
		this.note('info', 'Stopped');
	}

	/** Plan `goal` (when given), then work the queue until it is empty or stopped. */
	async run(goal?: string): Promise<{ done: number; blocked: number; review: number }> {
		this.started = Date.now();
		try {
			if (goal) await this.plan(goal);
			if (!this.stopped) await this.work();
		} catch (e) {
			this.error = (e as Error).message;
			this.note('error', this.error);
			this.alertAt = Date.now();
		} finally {
			this.phase = this.stopped ? 'stopped' : 'finished';
			this.learning.save();
			this.changed();
		}
		const count = (s: TaskStatus) => [...this.tasks.values()].filter((t) => t.status === s).length;
		return { done: count('done'), blocked: count('blocked'), review: count('review') };
	}

	private async plan(goal: string) {
		this.goal = goal;
		this.phase = 'planning';
		this.note('plan', `Planning: ${goal}`);
		const routes = routesFor(this.config, 'planner');
		if (!routes.length) throw new Error('no planner agent is enabled (see `jarvis-code doctor`)');
		const failed = new Set<string>();
		for (let attempt = 1; attempt <= this.config.maxAttempts && !this.stopped; attempt++) {
			const route = pick(routes, this.learning, this.config.strategy, failed) ?? pick(routes, this.learning, this.config.strategy);
			if (!route) break;
			const out = await this.launch('planner', { id: 'plan', title: goal }, route, 'planning', {
				prompt: plannerPrompt(goal, this.cwd),
				cwd: this.cwd,
				model: route.model,
				role: 'planner',
				blockedTools: this.learning.blockedTools(route.agent),
				pluginDir: this.opts.pluginDir,
				env: this.env(route, 'planner', 'plan'),
			});
			const plan = out.ok ? parsePlan(out.summary) : undefined;
			this.learnRoute(route, !!plan);
			if (plan) {
				const ids = await this.source.add(plan);
				this.note('plan', `Planned ${ids.length} task${ids.length === 1 ? '' : 's'} with ${route.id}`, { detail: plan.map((t, i) => `${ids[i]} ${t.title}`).join('\n') });
				return;
			}
			failed.add(route.id);
			this.alertAt = Date.now();
			this.note('fail', `Planner ${route.id} gave no usable plan${out.error ? `: ${out.error}` : ''}`, { detail: out.summary.slice(0, 2000) });
		}
		if (!this.stopped) throw new Error('planning failed: no planner route produced a usable plan');
	}

	private env(route: Route, role: string, task: string): Record<string, string> {
		return {
			JARVIS_CODE_RUN: '1',
			JARVIS_CODE_ROLE: role,
			JARVIS_CODE_TASK: task,
			JARVIS_CODE_AGENT: route.agent,
			JARVIS_CODE_BLOCKED: this.learning.blockedTools(route.agent).join(','),
		};
	}

	private async work() {
		this.phase = 'working';
		this.changed();
		const active = new Set<Promise<void>>();
		while (!this.stopped) {
			if (!this.paused && active.size < this.config.maxParallel) {
				const open = await this.source.next(this.handled);
				for (const t of open)
					if (!this.tasks.has(t.id)) this.tasks.set(t.id, { id: t.id, title: t.title, type: t.type, tier: t.tier, status: 'queued', attempts: 0 });
				// A dependency still open, running or blocked in this run holds its dependents back.
				const stuck = [...this.tasks.values()].filter((t) => t.status === 'blocked').map((t) => t.id);
				const waiting = new Set([...open.map((t) => t.id), ...this.inflight, ...stuck]);
				const ready = open.find((t) => !this.inflight.has(t.id) && !(t.depends ?? []).some((d) => waiting.has(d)));
				if (ready) {
					this.handled.add(ready.id);
					this.inflight.add(ready.id);
					const p: Promise<void> = this.runTask(ready).finally(() => {
						this.inflight.delete(ready.id);
						active.delete(p);
					});
					active.add(p);
					continue;
				}
			}
			if (!active.size && !this.paused) break;
			await Promise.race([...active, sleep(250)]);
		}
		await Promise.all(active);
	}

	private async runTask(task: Task) {
		const view = this.tasks.get(task.id)!;
		if (this.config.maxParallel === 1) await this.source.start(task);
		const routes = routesFor(this.config, 'worker');
		const failed = new Set<string>();
		let previous: string | undefined;
		let modelOverride: { route: string; model: string } | undefined;
		let modelRetries = 0;
		for (let attempt = 1; attempt <= this.config.maxAttempts && !this.stopped; attempt++) {
			let route = pick(routes, this.learning, this.config.strategy, failed) ?? pick(routes, this.learning, this.config.strategy);
			if (!route) break;
			if (modelOverride?.route === route.id) route = { ...route, model: modelOverride.model };
			Object.assign(view, { status: 'running', attempts: attempt, route: route.id });
			this.note('start', `${task.id} → ${route.id}${attempt > 1 ? ` (attempt ${attempt})` : ''}: ${task.title}`, { task: task.id });
			const blocked = this.learning.blockedTools(route.agent);
			const out = await this.launch(task.id, task, route, 'running', {
				prompt: workerPrompt(task, this.cwd, previous),
				cwd: this.cwd,
				model: route.model,
				role: 'worker',
				context: workerContext(blocked),
				blockedTools: blocked,
				pluginDir: this.opts.pluginDir,
				env: this.env(route, 'worker', task.id),
			});
			if (this.stopped) break;
			if (out.retryModel && modelRetries++ < 3) {
				modelOverride = { route: route.id, model: out.retryModel };
				this.note('model', `${task.id}: rerunning on ${out.retryModel}`, { task: task.id });
				attempt--;
				continue;
			}
			let checks: Check[] = [];
			if (out.ok) {
				view.status = 'verifying';
				this.changed();
				checks = await this.source.check(task);
			}
			const bad = checks.find((c) => !c.ok);
			const passed = out.ok && !bad && !/^BLOCKED:/m.test(out.summary);
			const learn = () => {
				this.learnRoute(route, passed);
				for (const s of out.subagents) this.learnTool(route.agent, s, passed);
			};
			if (passed) {
				learn();
				const r = await this.source.close(task, checks, `jarvis-code: ${route.id}, attempt ${attempt}, ${checks.length} check(s) passed`);
				view.status = r.closed ? 'done' : 'review';
				view.note = r.closed ? out.summary.split('\n')[0]?.slice(0, 200) : r.message;
				this.note(r.closed ? 'done' : 'review', `${task.id} ${r.closed ? 'done' : 'passed, needs review'}: ${task.title}`, {
					task: task.id,
					detail: r.closed ? out.summary : r.message,
				});
				return;
			}
			const reason = !out.ok ? out.error || 'agent failed' : bad ? `check failed: ${bad.cmd}` : out.summary.match(/^BLOCKED:.*$/m)![0];
			failed.add(route.id);
			previous = `Attempt ${attempt} on ${route.id}: ${reason}\n${(bad?.output ?? out.summary).slice(-1500)}`;
			view.note = reason;
			this.alertAt = Date.now();
			this.note('fail', `${task.id} failed on ${route.id}: ${reason}`, { task: task.id, detail: bad?.output });
			learn();
		}
		if (this.stopped) {
			view.status = 'queued';
			return;
		}
		view.status = 'blocked';
		const why = view.note ?? 'no agent route available';
		await this.source.block(task, `jarvis-code: ${why}`);
		this.note('block', `${task.id} blocked after ${view.attempts} attempt(s): ${why}`, { task: task.id });
	}

	private learnRoute(route: Route, ok: boolean) {
		const why = this.learning.recordRoute(route.id, ok);
		if (why) this.note('learn', `Switched off ${route.id}: ${why}`);
	}

	private learnTool(agent: string, tool: string, ok: boolean) {
		const why = this.learning.recordTool(agent, tool, ok);
		if (why) this.note('learn', `Switched off ${tool} for ${agent}: ${why}`);
	}

	/** Start one agent run and translate its events into views, learning and downgrade handling. */
	private launch(key: string, task: Pick<Task, 'id' | 'title'>, route: Route, phase: WorkerView['phase'], spec: RunSpec): Promise<Launched> {
		const cfg = this.config.agents[route.agent];
		const w: WorkerView = { key, task: task.id, title: task.title, route: route.id, model: route.model, phase, started: Date.now(), tools: 0, last: 'starting', cost: 0 };
		this.workers.set(key, w);
		const subagents = new Set<string>();
		let retryModel: string | undefined;
		let upgrades = 0;
		const tid = task.id;
		const onEvent = (e: AgentEvent) => {
			switch (e.type) {
				case 'init':
					if (e.model) w.model = e.model;
					break;
				case 'text':
					w.last = e.text.trim().split('\n')[0].slice(0, 200);
					this.note('text', w.last, { task: tid, detail: e.text });
					return;
				case 'tool':
					w.tools++;
					w.last = e.summary;
					if (e.name.includes('(')) subagents.add(e.name);
					this.note('tool', e.summary, { task: tid });
					return;
				case 'tool_result':
					this.learnTool(route.agent, e.name, e.ok);
					if (!e.ok && learnable(e.name, this.config.learning.neverBlock)) this.note('tool', `✗ ${e.name}: ${e.error ?? 'failed'}`, { task: tid });
					return;
				case 'change':
					this.note('change', e.path, { task: tid, detail: e.diff });
					return;
				case 'model': {
					const d = decide(this.config.downgrade, e, upgrades);
					this.note('model', `${tid}: ${e.from ?? '?'} → ${e.to} (${e.reason}${e.sticky ? '' : ', this turn only'})`, { task: tid });
					w.model = e.to;
					if (d.action === 'reupgrade' && run.setModel) {
						upgrades++;
						this.note('model', `${tid}: re-upgrading to ${d.model}`, { task: tid });
						run.setModel(d.model!);
					} else if (d.action === 'reupgrade' || d.action === 'retry') {
						upgrades++;
						retryModel = d.model;
						run.kill();
					} else this.note('model', `${tid}: keeping ${e.to} (${d.why})`, { task: tid });
					break;
				}
				case 'reupgrade':
					if (e.ok) w.model = e.model;
					this.note('model', `${tid}: ${e.ok ? `back on ${e.model}` : `could not switch back to ${e.model}`}`, { task: tid });
					return;
				case 'usage':
					if (e.costUsd !== undefined) w.cost = e.costUsd;
					break;
				case 'log':
					this.note('info', `${route.id}: ${e.text}`, { task: tid });
					return;
			}
			this.changed();
		};
		const run = startAgent(cfg, spec, onEvent);
		this.runs.set(key, run);
		this.changed();
		return run.done.then((out) => {
			this.runs.delete(key);
			this.workers.delete(key);
			this.spent += w.cost;
			this.changed();
			return { ...out, retryModel, subagents };
		});
	}
}
