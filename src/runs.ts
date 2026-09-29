import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, merge, normalize, type Config } from './config.js';
import { Learning } from './learn.js';
import { Orchestrator, type Snapshot } from './orchestrator.js';
import { improveGoal, nextRound } from './pipeline.js';
import { claudeInstalled, PLUGIN_DIR } from './plugin.js';
import { Project, type QueuedGoal } from './store.js';
import { MemorySource, StoreSource, type TaskSource } from './tasks.js';

export interface Run {
	id: number;
	/** The project directory the run works in. */
	dir: string;
	name: string;
	goal?: string;
	o: Orchestrator;
	done: Promise<{ done: number; blocked: number; review: number }>;
	finished: boolean;
	/** A demo run lives in a scratch directory and is not a real project. */
	demo?: boolean;
	/** Config the run ignored (an untrusted project config's commands). */
	warnings?: string[];
}

export interface StartOptions {
	goal?: string;
	/** Keep the queue in memory instead of the project's task store. */
	memory?: boolean;
	/** Config overrides (CLI flags) merged over the project's own config. */
	overrides?: unknown;
	/** Plan the goal into the project's queue and stop, without working it or draining the queue. */
	planOnly?: boolean;
}

export interface ImproveOptions {
	focus?: string;
	/** At most this many rounds; a round landing fewer than `minLanded` tasks ends the loop. */
	rounds: number;
	minLanded: number;
	/** Config overrides for every round, as start()'s; the rounds add deep planning. */
	overrides?: unknown;
}

/** How an improve loop ended: `error` when the next round could not start. */
export interface Improved {
	dir: string;
	round: number;
	reason: 'stopped' | 'dry' | 'rounds';
	error?: string;
}

/**
 * Run `jarvis-code <args> --plain` in the background in `dir`: it outlives this process, takes
 * the project's run lock itself, and writes to a log kept with the project's tasks. Resolves
 * once the background run holds the project, or rejects with why it did not start.
 */
export async function runDetached(dir: string, args: string[]): Promise<{ pid: number; log: string }> {
	const project = new Project(dir);
	const held = project.running();
	if (held) throw new Error(`${project.meta.name} already has a run going (pid ${held.pid})`);
	const log = project.runLog();
	const out = openSync(log, 'a');
	const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
	const child = spawn(process.execPath, [cli, ...args, '--plain'], { cwd: dir, detached: true, stdio: ['ignore', out, out], env: { ...process.env, JARVIS_CODE_LOG: log } });
	let exited = false;
	child.on('exit', () => (exited = true));
	child.unref();
	// Started = it took the project; a quick run may already have finished, so ask the ledger.
	const ledger = join(project.dir, 'ledger.jsonl');
	const took = () => project.running()?.pid === child.pid || (existsSync(ledger) && readFileSync(ledger, 'utf8').includes(`"event":"run","pid":${child.pid}`));
	for (const end = Date.now() + 10_000; Date.now() < end; await sleep(100)) {
		if (took()) return { pid: child.pid!, log };
		if (exited) break;
	}
	const tail = readFileSync(log, 'utf8').trim().split('\n').slice(-3).join(' ');
	throw new Error(`the background run did not start${tail ? `: ${tail}` : ''} (log ${log})`);
}

/** Stop a project's run held by another jarvis-code process started from the CLI; says what happened. */
export function stopElsewhere(dir: string): string {
	const held = Project.open(dir)?.running();
	if (!held || held.pid === process.pid) return 'nothing running here';
	if (held.by === 'cockpit') return `that run belongs to a cockpit (pid ${held.pid}): stop it there`;
	process.kill(held.pid, 'SIGTERM');
	return `stopping the run here (pid ${held.pid}): running tasks are killed and stay queued`;
}

/** Demo agents: a planner and a strong worker that speak Claude Code's protocol, and a flaky local model. */
export function demoConfig(base: Config, fast: boolean): Config {
	const agent = fileURLToPath(new URL('./demo-agent.js', import.meta.url));
	const env = { JC_DEMO_PACE: fast ? '25' : '450', JC_DEMO_DOWNGRADE: 'some' };
	return normalize(
		merge(base, {
			agents: {
				claude: { kind: 'claude', enabled: true, bin: agent, models: ['claude-fable-5-1'], env, args: [], disablePlugins: [] },
				codex: { enabled: false },
				opencode: { enabled: false },
				local: { kind: 'generic', enabled: true, bin: agent, args: ['--model', '{model}', '{prompt}'], models: ['qwen3-coder-flaky'], env },
			},
			// Two planner routes: the planner runs on the agent that did not write its prompt.
			planner: ['claude:claude-fable-5-1', 'local:qwen3-coder-flaky'],
			workers: ['local:qwen3-coder-flaky', 'claude:claude-fable-5-1'],
			maxParallel: 1,
			downgrade: { models: { 'claude-fable*': { action: 'reupgrade', to: 'claude-fable-5-1', max: 3 } } },
		}),
	);
}

/** Finished runs the manager remembers; older ones are dropped. */
export const KEEP_FINISHED = 5;

/**
 * Every run the cockpit started, one per project directory at a time (two runs in one
 * working tree would edit the same files). Runs share one Learning, so what one project
 * learns about a route or tool applies to the next. Emits `update` on any change.
 */
export class RunManager extends EventEmitter {
	readonly runs = new Map<number, Run>();
	private next = 1;
	constructor(
		readonly learning: Learning,
		private base: { overrides?: unknown } = {},
	) {
		super();
	}

	/**
	 * Forget all but the newest KEEP_FINISHED finished runs: each Orchestrator holds its activity,
	 * nodes and patches, and a cockpit left open for hours starts many runs. Never drops one going.
	 */
	prune(): void {
		const finished = this.list().filter((r) => r.finished);
		for (const r of finished.slice(0, -KEEP_FINISHED)) this.runs.delete(r.id);
	}

	list(): Run[] {
		return [...this.runs.values()];
	}

	active(): Run[] {
		return this.list().filter((r) => !r.finished);
	}

	/** The newest run in `dir`, finished or not. */
	inDir(dir: string): Run | undefined {
		return this.list()
			.filter((r) => r.dir === resolve(dir))
			.at(-1);
	}

	/** `then` runs once the run ended and the project is unlocked: by default, the next queued goal. */
	async start(dir: string, opts: StartOptions = {}, then?: (run: Run, project: Project) => Promise<void>): Promise<Run> {
		const abs = resolve(dir);
		const busy = this.active().find((r) => r.dir === abs);
		if (busy) throw new Error(`${basename(abs)} already has a run going (#${busy.id}); /stop it first`);
		const { config, warnings } = loadConfig(abs, merge(this.base.overrides ?? {}, opts.overrides ?? {}));
		if (opts.planOnly && (opts.memory || !opts.goal)) throw new Error('plan needs a goal and the task store: a memory queue would forget the plan');
		const src = await this.source(config, abs, opts.memory);
		// One run per project across processes too: a CLI or background run may hold it.
		const project = src instanceof StoreSource ? src.project : undefined;
		project?.lock({ goal: opts.goal, by: 'cockpit' });
		const run = this.launch(abs, config, src, opts.goal, this.learning, opts.planOnly);
		run.warnings = warnings;
		// After a plan-only run the queue waits for you: draining it would work the plan too.
		const after = then ?? ((r: Run, p: Project) => (opts.planOnly ? Promise.resolve() : this.drain(abs, r, p, opts)));
		if (project) void run.done.finally(() => project.unlock()).then(() => after(run, project));
		return run;
	}

	/**
	 * The improve loop: rounds of improveGoal with deep planning, each an ordinary run building on
	 * what the last one closed, until nextRound ends them; then emits `improved` (an Improved).
	 * Goals queued meanwhile wait for the loop to end, then drain as after any run.
	 */
	async improve(dir: string, opts: ImproveOptions, round = 1, built: string[] = []): Promise<Run> {
		const overrides = merge(opts.overrides ?? {}, { planning: { mode: 'deep' } });
		return this.start(dir, { goal: improveGoal(opts.focus, built), overrides }, async (run, project) => {
			const s = run.o.snapshot();
			const done = s.tasks.filter((t) => t.status === 'done').map((t) => t.title);
			const reason = nextRound({ round, rounds: opts.rounds, landed: done.length, minLanded: opts.minLanded, stopped: s.phase === 'stopped' || !!s.error });
			let error: string | undefined;
			if (!reason)
				try {
					await this.improve(dir, opts, round + 1, done);
					return;
				} catch (e) {
					error = (e as Error).message;
				}
			this.emit('improved', { dir: run.dir, round, reason: reason ?? 'stopped', ...(error && { error }) } satisfies Improved);
			await this.drain(run.dir, run, project, { overrides: opts.overrides });
		});
	}

	/**
	 * Start a run on the goal, or queue the goal when the project already has a run going, here
	 * or in another process; one run per project works through many goals. Memory and goal-less
	 * runs have no queue entry to make, so they keep start()'s error.
	 */
	async submit(dir: string, opts: StartOptions = {}): Promise<{ run?: Run; queued?: number }> {
		const abs = resolve(dir);
		// A demo has no store to queue in (nor a drain): it keeps start()'s error.
		if (opts.goal && !opts.memory && this.busy(abs)) return { queued: new Project(abs).enqueue(opts.goal) };
		return { run: await this.start(abs, opts) };
	}

	/** The project has a run going, here (not a demo) or in another process. */
	busy(dir: string): boolean {
		const abs = resolve(dir);
		return this.active().some((r) => r.dir === abs && !r.demo) || !!Project.open(abs)?.running();
	}

	/** Goals waiting for the project's run to end, oldest first. */
	queued(dir: string): QueuedGoal[] {
		return Project.open(dir)?.goals() ?? [];
	}

	/** Take queued goal n (1-based) off the project's queue; undefined when there is none. */
	unqueue(dir: string, n: number): QueuedGoal | undefined {
		return Project.open(dir)?.unqueue(n);
	}

	/** After a run finished on its own (not stopped), start the project's next queued goal. */
	private async drain(dir: string, run: Run, project: Project, opts: StartOptions): Promise<void> {
		if (run.o.snapshot().phase !== 'finished' || project.running()) return;
		const goal = project.nextGoal();
		if (!goal) return;
		try {
			await this.start(dir, { ...opts, goal });
		} catch (e) {
			// Put it back rather than lose it; the next run that finishes tries again.
			project.enqueue(goal);
			project.log({ event: 'queue-failed', goal, error: (e as Error).message });
		}
		this.emit('update');
	}

	/** A demo run in a scratch directory with simulated agents: no API calls, nothing stored. */
	startDemo(fast = false, base?: Config): Run {
		const dir = mkdtempSync(join(tmpdir(), 'jarvis-code-demo-'));
		const config = demoConfig(base ?? loadConfig(dir, this.base.overrides ?? {}).config, fast);
		const run = this.launch(dir, config, new MemorySource(dir, 30), 'Modernize the settings system', new Learning(config.learning, join(dir, '.learning.json')));
		run.demo = true;
		run.name = 'demo';
		return run;
	}

	stop(run: Run): void {
		run.o.stop();
	}

	stopAll(): Promise<unknown> {
		for (const r of this.active()) r.o.stop();
		return Promise.all(this.list().map((r) => r.done));
	}

	private async source(config: Config, dir: string, memory?: boolean): Promise<TaskSource> {
		if (memory) return new MemorySource(dir, config.verify.timeoutSec);
		return new StoreSource(new Project(dir), dir, config.verify.timeoutSec);
	}

	private launch(dir: string, config: Config, src: TaskSource, goal?: string, learning = this.learning, planOnly = false): Run {
		const o = new Orchestrator(config, src, learning, dir, { pluginDir: claudeInstalled() ? undefined : PLUGIN_DIR, planOnly });
		const run: Run = { id: this.next++, dir, name: basename(dir), goal, o, done: undefined as never, finished: false };
		o.on('update', () => this.emit('update'));
		o.on('activity', (a) => this.emit('activity', run, a));
		run.done = o.run(goal).finally(() => {
			run.finished = true;
			this.prune();
			this.emit('finished', run);
			this.emit('update');
		});
		this.runs.set(run.id, run);
		this.emit('update');
		return run;
	}
}

/** One snapshot standing for several runs: the header and reactor summarize the fleet. */
export function fleet(runs: Run[]): Snapshot | undefined {
	if (!runs.length) return undefined;
	const snaps = runs.map((r) => r.o.snapshot());
	const order = ['alert', 'attention', 'thinking', 'tool', 'warming', 'idle', 'offline', 'kill'] as const;
	const live = snaps.filter((s) => s.phase === 'planning' || s.phase === 'working');
	const pool = live.length ? live : snaps;
	const reactor = order.find((st) => pool.some((s) => s.reactor === st)) ?? 'idle';
	const lead = pool.find((s) => s.reactor === reactor)!;
	return {
		...lead,
		phase: live.length ? (live.some((s) => s.phase === 'working') ? 'working' : 'planning') : snaps.every((s) => s.phase === 'stopped') ? 'stopped' : 'finished',
		paused: live.length > 0 && live.every((s) => s.paused),
		goal: runs.length === 1 ? snaps[0].goal : `${live.length} of ${runs.length} runs going`,
		tasks: snaps.flatMap((s) => s.tasks),
		workers: snaps.flatMap((s) => s.workers),
		nodes: snaps.flatMap((s) => s.nodes),
		activity: [],
		cost: snaps.reduce((n, s) => n + s.cost, 0),
		planning: snaps.reduce((n, s) => n + (s.planning ?? 0), 0),
		started: Math.min(...snaps.map((s) => s.started)),
		reactor,
		routes: [...new Map(snaps.flatMap((s) => s.routes).map((r) => [r.id, r])).values()],
	};
}
