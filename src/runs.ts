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
import { claudeInstalled, PLUGIN_DIR } from './plugin.js';
import { Project } from './store.js';
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

	async start(dir: string, opts: StartOptions = {}): Promise<Run> {
		const abs = resolve(dir);
		const busy = this.active().find((r) => r.dir === abs);
		if (busy) throw new Error(`${basename(abs)} already has a run going (#${busy.id}); /stop it first`);
		const { config, warnings } = loadConfig(abs, merge(this.base.overrides ?? {}, opts.overrides ?? {}));
		const src = await this.source(config, abs, opts.memory);
		// One run per project across processes too: a CLI or background run may hold it.
		const project = src instanceof StoreSource ? src.project : undefined;
		project?.lock({ goal: opts.goal, by: 'cockpit' });
		const run = this.launch(abs, config, src, opts.goal);
		run.warnings = warnings;
		if (project) void run.done.finally(() => project.unlock());
		return run;
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

	private launch(dir: string, config: Config, src: TaskSource, goal?: string, learning = this.learning): Run {
		const o = new Orchestrator(config, src, learning, dir, { pluginDir: claudeInstalled() ? undefined : PLUGIN_DIR });
		const run: Run = { id: this.next++, dir, name: basename(dir), goal, o, done: undefined as never, finished: false };
		o.on('update', () => this.emit('update'));
		o.on('activity', (a) => this.emit('activity', run, a));
		run.done = o.run(goal).finally(() => {
			run.finished = true;
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
		activity: [],
		cost: snaps.reduce((n, s) => n + s.cost, 0),
		planning: snaps.reduce((n, s) => n + (s.planning ?? 0), 0),
		started: Math.min(...snaps.map((s) => s.started)),
		reactor,
		routes: [...new Map(snaps.flatMap((s) => s.routes).map((r) => [r.id, r])).values()],
	};
}
