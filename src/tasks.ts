import { exec } from 'node:child_process';
import { clean } from './agents/types.js';
import type { Attempt, Project } from './store.js';

export interface AC {
	text: string;
	verify?: string;
}

export interface Task {
	id: string;
	title: string;
	type: string;
	tier: string;
	acs: AC[];
	steps: string[];
	/** What a worker needs beyond the title (approach, files, pitfalls). */
	brief?: string;
	/** What a person said about this task (sending it back, or a note mid-run): guidance for the next worker. */
	hint?: string;
	/** Task ids this one waits for. */
	depends?: string[];
	/** `replan`: split from a blocked task, and never split again. */
	source?: string;
	/** Paths the plan said the task will change or create. */
	files?: string[];
}

/** A task as the planner proposes it; `key`/`depends` link tasks within one plan. */
export interface PlannedTask {
	key?: string;
	title: string;
	type?: string;
	tier?: string;
	acs?: AC[];
	steps?: string[];
	depends?: string[];
	notes?: string;
	/** Paths (from the repository root) the task will change or create, tests included. */
	files?: string[];
}

export interface Check {
	cmd: string;
	ok: boolean;
	output: string;
	/** The process exit code: 0 on success, `err.code` when the shell gave a numeric one. */
	code?: number;
}

/** Where tasks come from and where their outcome is recorded. */
export interface TaskSource {
	readonly name: string;
	/** Open tasks in the order to work them, minus the ones this run already handled. */
	next(skip: ReadonlySet<string>): Promise<Task[]>;
	add(plan: PlannedTask[], goal?: string): Promise<string[]>;
	start(task: Task): Promise<void>;
	/** Run the task's verify commands, in `cwd` when given (an attempt's own worktree). */
	check(task: Task, cwd?: string): Promise<Check[]>;
	/** It passed, but a person has to look first (its changes did not merge). */
	hold?(task: Task, reason: string): Promise<void>;
	/** Record success; `closed: false` means it passed but the source wants a human (e.g. audits). */
	close(task: Task, checks: Check[], note: string): Promise<{ closed: boolean; message: string }>;
	block(task: Task, reason: string): Promise<void>;
	/** Record one attempt (route, outcome, cost) where the source keeps history. */
	attempt?(task: Task, a: Attempt): void;
	/** Keep a planning artifact (prompt, brainstorm) where the source keeps history. */
	research?(name: string, content: string): string | undefined;
	/** Keep a worker's lessons and out-of-scope findings; returns the ids given to the findings. */
	notes?(task: Task, lessons: string[], followUps: string[]): string[];
	/** Recent lessons to give the next worker. */
	lessons?(limit?: number): string[];
	/** How often each tier passed on its first attempt here, for the planner. */
	sizing?(): string | undefined;
	/** A task the run stopped working: back in the queue as it was. */
	requeue?(task: Task): Promise<void>;
	/** The run's latest activity, so status can show it is still moving. */
	beat?(a: { at: number; kind: string; text: string; task?: string }): void;
	/** Replace a blocked task with smaller ones: add them, drop it, and move its dependents onto them. */
	split?(task: Task, plan: PlannedTask[], why: string): Promise<string[]>;
	/** Add a person's note to the task's hint; false when the task is unknown, done or dropped. */
	tell?(id: string, text: string): boolean;
	/** The task's hint as it is now, notes included. */
	hint?(id: string): string | undefined;
}

const tail = (s: string, n = 400) => (s.length > n ? '…' + s.slice(-n) : s).trim();

/** node --test-name-pattern, jest -t/--testNamePattern, go test -run */
const FILTER_FLAG = /--test-name-pattern\b|--testNamePattern\b|(?:^|\s)-t(?:[=\s]|$)|(?:^|\s)-run(?:[=\s]|$)/;

/** A filter flag matched zero tests: the check passed by finding nothing to run. */
const filteredNoMatch = (cmd: string, full: string): boolean =>
	FILTER_FLAG.test(cmd) &&
	(/[#ℹ]\s*pass 0\b/.test(full) || (/\bTests:/.test(full) && !/\bpassed\b/.test(full)) || /no tests to run/.test(full));

/**
 * Run a verify command through the shell in `cwd`. A shell on purpose: verify commands are
 * shell lines (`test -f x && npm test`), written by the plan —
 * and the workers that satisfy them already run arbitrary commands in this repo.
 */
export function shell(cmd: string, cwd: string, timeoutSec: number): Promise<Check> {
	return new Promise((resolve) => {
		// Strip our own test runner's env: a verify command that runs `node --test` must not
		// inherit jarvis-code's own NODE_TEST_CONTEXT, or node reports to us instead of it.
		const { NODE_TEST_CONTEXT, NODE_TEST_WORKER_ID, ...env } = process.env;
		exec(cmd, { cwd, env, timeout: timeoutSec * 1000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
			const full = `${stdout}${stderr}`;
			const code = err ? (typeof err.code === 'number' ? err.code : undefined) : 0;
			if (!err && filteredNoMatch(cmd, full)) {
				resolve({ cmd, ok: false, code, output: clean(`${tail(full)}\njarvis-code: the test filter matched no tests, so this check proves nothing`) });
				return;
			}
			resolve({ cmd, ok: !err, code, output: clean(tail(full) || (err ? err.message : '')) });
		});
	});
}

// --- the native store ------------------------------------------------------------------

/** jarvis-code's own task store as the queue: attempts, evidence and outcomes are kept per task. */
export class StoreSource implements TaskSource {
	readonly name = 'store';
	constructor(
		readonly project: Project,
		private cwd: string,
		private timeoutSec: number,
	) {}

	async next(skip: ReadonlySet<string>): Promise<Task[]> {
		return this.project
			.queue()
			.filter((t) => !skip.has(t.id))
			.map((t) => ({ id: t.id, title: t.title, type: t.type, tier: t.tier, acs: t.acs, steps: t.steps, brief: t.brief, hint: t.hint, depends: t.depends, source: t.source, files: t.files }));
	}

	async add(plan: PlannedTask[], goal?: string): Promise<string[]> {
		return this.project.add(plan, { goal, source: 'plan' }).map((t) => t.id);
	}

	async start(task: Task): Promise<void> {
		this.project.setStatus(task.id, 'active');
	}

	async check(task: Task, cwd = this.cwd): Promise<Check[]> {
		const out: Check[] = [];
		for (const [i, ac] of task.acs.entries()) {
			if (!ac.verify) continue;
			const c = await shell(ac.verify, cwd, this.timeoutSec);
			out.push(c);
			this.project.update(task.id, (t) => {
				t.evidence.push({ at: new Date().toISOString(), kind: 'ac', n: i + 1, cmd: c.cmd, ok: c.ok, output: c.output.slice(-600) });
				if (t.acs[i]) t.acs[i].checked = c.ok;
			});
			this.project.log({ event: 'check', id: task.id, n: i + 1, ok: c.ok });
		}
		return out;
	}

	async close(task: Task, checks: Check[], note: string): Promise<{ closed: boolean; message: string }> {
		this.project.update(task.id, (t) => {
			t.status = 'done';
			t.reason = undefined;
			t.evidence.push({ at: new Date().toISOString(), kind: 'note', ok: true, output: note });
		});
		this.project.log({ event: 'done', id: task.id, checks: checks.length });
		return { closed: true, message: 'done' };
	}

	async block(task: Task, reason: string): Promise<void> {
		this.project.setStatus(task.id, 'blocked', reason);
	}

	async hold(task: Task, reason: string): Promise<void> {
		this.project.setStatus(task.id, 'review', reason);
	}

	async requeue(task: Task): Promise<void> {
		if (this.project.get(task.id)?.status === 'active') this.project.setStatus(task.id, 'planned');
	}

	research(name: string, content: string): string {
		return this.project.research(name, content);
	}

	notes(task: Task, lessons: string[], followUps: string[]): string[] {
		if (lessons.length) this.project.update(task.id, (t) => (t.lessons = [...new Set([...t.lessons, ...lessons])].slice(-20)));
		// Found out of scope: kept, not run. The user queues them with `jarvis-code task retry`.
		const goal = this.project.get(task.id)?.goal;
		return this.project.add(followUps.map((title) => ({ title, type: /\b(fix|bug|broken|crash|fails?)\b/i.test(title) ? 'FIX' : 'FEATURE' })), { goal, source: 'followup', status: 'deferred', reason: `found while working ${task.id}` }).map((t) => t.id);
	}

	lessons(limit?: number): string[] {
		return this.project.lessons(limit);
	}

	sizing(): string | undefined {
		return this.project.firstTry();
	}

	async split(task: Task, plan: PlannedTask[], why: string): Promise<string[]> {
		const ids = this.project.add(plan, { goal: this.project.get(task.id)?.goal, source: 'replan' }).map((t) => t.id);
		this.project.setStatus(task.id, 'dropped', `split into ${ids.join(', ')}: ${why}`);
		for (const t of this.project.tasks())
			if (t.depends.includes(task.id)) this.project.update(t.id, (x) => (x.depends = [...new Set(x.depends.flatMap((d) => (d === task.id ? ids : [d])))]));
		return ids;
	}

	attempt(task: Task, a: Attempt): void {
		this.project.update(task.id, (t) => t.attempts.push(a));
		this.project.log({ event: 'attempt', id: task.id, route: a.route, ok: a.ok, cause: a.cause });
	}

	beat(a: { at: number; kind: string; text: string; task?: string }): void {
		this.project.beat(a);
	}

	tell(id: string, text: string): boolean {
		const t = this.project.get(id);
		if (!t || t.status === 'done' || t.status === 'dropped') return false;
		this.project.update(id, (t) => (t.hint = t.hint ? `${t.hint}\n${text}` : text));
		this.project.log({ event: 'note', id });
		return true;
	}

	hint(id: string): string | undefined {
		return this.project.get(id)?.hint;
	}
}

// --- in memory ------------------------------------------------------------------------

/** Tasks held in the process: the demo, tests, and `--tasks memory`. */
export class MemorySource implements TaskSource {
	readonly name = 'memory';
	tasks: (Task & { status: 'open' | 'done' | 'blocked' | 'split'; depends: string[]; reason?: string })[] = [];
	private n = 0;
	constructor(private cwd: string, private timeoutSec: number) {}

	async next(skip: ReadonlySet<string>): Promise<Task[]> {
		return this.tasks.filter((t) => t.status === 'open' && !skip.has(t.id));
	}

	async split(task: Task, plan: PlannedTask[], why: string): Promise<string[]> {
		const ids = await this.add(plan, undefined, 'replan');
		Object.assign(this.find(task), { status: 'split', reason: `split into ${ids.join(', ')}: ${why}` });
		for (const t of this.tasks) t.depends = [...new Set(t.depends.flatMap((d) => (d === task.id ? ids : [d])))];
		return ids;
	}

	async add(plan: PlannedTask[], _goal?: string, source?: string): Promise<string[]> {
		const keys = new Map<string, string>();
		return plan.map((p, i) => {
			const id = `M-${String(++this.n).padStart(4, '0')}`;
			keys.set(p.key ?? `t${i + 1}`, id);
			this.tasks.push({
				id,
				title: p.title,
				type: (p.type ?? 'FEATURE').toUpperCase(),
				tier: (p.tier ?? 'S').toUpperCase(),
				acs: p.acs ?? [],
				steps: p.steps ?? [],
				brief: p.notes,
				files: p.files,
				status: 'open',
				source,
				depends: (p.depends ?? []).map((d) => keys.get(d) ?? d),
			});
			return id;
		});
	}

	async start(): Promise<void> {}

	async check(task: Task, cwd = this.cwd): Promise<Check[]> {
		const out: Check[] = [];
		for (const ac of task.acs) if (ac.verify) out.push(await shell(ac.verify, cwd, this.timeoutSec));
		return out;
	}

	async hold(task: Task, reason: string): Promise<void> {
		Object.assign(this.find(task), { status: 'blocked', reason });
	}

	async close(task: Task): Promise<{ closed: boolean; message: string }> {
		this.find(task).status = 'done';
		return { closed: true, message: 'done' };
	}

	async block(task: Task, reason: string): Promise<void> {
		Object.assign(this.find(task), { status: 'blocked', reason });
	}

	tell(id: string, text: string): boolean {
		const t = this.tasks.find((x) => x.id === id);
		if (!t || t.status === 'done' || t.status === 'split') return false;
		t.hint = t.hint ? `${t.hint}\n${text}` : text;
		return true;
	}

	hint(id: string): string | undefined {
		return this.tasks.find((x) => x.id === id)?.hint;
	}

	private find(task: Task) {
		const t = this.tasks.find((x) => x.id === task.id);
		if (!t) throw new Error(`unknown task ${task.id}`);
		return t;
	}
}
