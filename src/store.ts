import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { paths } from './config.js';
import { recordIntent } from './intent.js';

/**
 * jarvis-code's own task state: one directory per project under the state dir, one JSON
 * file per task, an append-only ledger. Nothing here knows about any other task system.
 *
 *   <state>/projects/<slug>/project.json
 *   <state>/projects/<slug>/tasks/T-0001.json
 *   <state>/projects/<slug>/ledger.jsonl       every change, one event per line
 *   <state>/projects/<slug>/goals.json          goals queued behind the current run
 *   <state>/projects/<slug>/decisions.jsonl
 *   <state>/projects/<slug>/research/<name>.md  plans, brainstorms, prompts
 */

export type Status = 'planned' | 'active' | 'review' | 'blocked' | 'deferred' | 'done' | 'dropped';

export interface Criterion {
	text: string;
	/** A shell command that exits 0 only when the criterion holds. */
	verify?: string;
	checked?: boolean;
}

export interface Evidence {
	at: string;
	kind: 'ac' | 'check' | 'note';
	/** Criterion number, 1-based, for `ac`. */
	n?: number;
	cmd?: string;
	ok: boolean;
	output?: string;
}

export interface Attempt {
	at: string;
	route: string;
	ok: boolean;
	summary?: string;
	error?: string;
	/** Why a failed attempt failed (diagnose()'s Cause). */
	cause?: string;
	costUsd?: number;
	/** Checks that passed/failed on the untouched tree, first attempt only: those passes prove nothing about the change. */
	preflight?: { pass: number; fail: number };
	/** The file (a research note) holding what this attempt changed; none outside a git repo or when it changed nothing. */
	patch?: string;
}

export interface StoredTask {
	id: string;
	title: string;
	type: string;
	tier: string;
	status: Status;
	acs: Criterion[];
	steps: string[];
	depends: string[];
	/** What a worker needs beyond the title: approach, files, pitfalls. */
	brief?: string;
	/** Paths the plan said the task will change or create; optional so older task files still load. */
	files?: string[];
	/** The goal the task was planned from. */
	goal?: string;
	source: 'user' | 'plan' | 'replan' | 'followup';
	/** Why it is blocked, deferred or waiting for review. */
	reason?: string;
	/** What a person said about this task (sending it back, or a note mid-run): guidance for the next worker. */
	hint?: string;
	attempts: Attempt[];
	evidence: Evidence[];
	lessons: string[];
	created: string;
	updated: string;
	/** Epoch ms of a person's "do this next"; the newest bump goes first. */
	bumpedAt?: number;
}

export interface NewTask {
	/** Plan-local key other tasks in the same plan can depend on. */
	key?: string;
	title: string;
	type?: string;
	tier?: string;
	acs?: Criterion[];
	steps?: string[];
	depends?: string[];
	brief?: string;
	notes?: string;
	files?: string[];
}

/** A goal sent while the project's run was going, to run after it. */
export interface QueuedGoal {
	goal: string;
	at: string;
}

export interface ProjectMeta {
	slug: string;
	name: string;
	path: string;
	created: string;
	lastActive: string;
}

/** Canonical order for independent tasks: understand, tidy, speed up, secure, fix, then build. */
export const TYPE_ORDER = ['RESEARCH', 'CLEAN', 'PERF', 'PERFORMANCE', 'SECURITY', 'FIX', 'FEATURE'];
export const TYPES = ['RESEARCH', 'CLEAN', 'PERF', 'SECURITY', 'FIX', 'FEATURE'];
const OPEN: ReadonlySet<Status> = new Set(['planned', 'active']);

const now = () => new Date().toISOString();

function writeAtomic(file: string, data: string): void {
	const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(tmp, data);
	renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(readFileSync(file, 'utf8')) as T;
	} catch {
		return undefined;
	}
}

export const slugFor = (dir: string) => `${basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'root'}-${createHash('sha1').update(dir).digest('hex').slice(0, 6)}`;

export const storeRoot = () => join(paths.stateDir(), 'projects');

/** Every project jarvis-code has state for, most recently active first. */
export function listStored(root = storeRoot()): ProjectMeta[] {
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.map((slug) => readJson<ProjectMeta>(join(root, slug, 'project.json')))
		.filter((m): m is ProjectMeta => !!m && typeof m.path === 'string')
		.sort((a, b) => b.lastActive.localeCompare(a.lastActive));
}

/** The run working a project right now, as recorded in its lock. */
export interface RunInfo {
	pid: number;
	started: string;
	goal?: string;
	/** Where a background run writes its output. */
	log?: string;
	/** `cockpit` runs are stopped from their cockpit; `cli` runs (background or not) with `jarvis-code stop`. */
	by?: 'cockpit' | 'cli';
	/** When the process started, so a reused pid is not mistaken for the run (Linux; absent elsewhere). */
	proc?: string;
}

/** The kernel's start time of a process: with the pid, it names one process for good. */
function procStart(pid: number): string | undefined {
	try {
		// Field 22 of /proc/<pid>/stat, counted after the parenthesised command name.
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
		return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
	} catch {
		return undefined;
	}
}

function alive(pid: number, proc?: string): boolean {
	try {
		process.kill(pid, 0);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false;
	}
	return !proc || procStart(pid) === undefined || procStart(pid) === proc;
}

/** The state of one project directory. Created on first use. */
export class Project {
	readonly dir: string;
	readonly meta: ProjectMeta;
	constructor(path: string, root = storeRoot()) {
		const abs = resolve(path);
		const slug = slugFor(abs);
		this.dir = join(root, slug);
		mkdirSync(join(this.dir, 'tasks'), { recursive: true });
		const file = join(this.dir, 'project.json');
		this.meta = readJson<ProjectMeta>(file) ?? { slug, name: basename(abs), path: abs, created: now(), lastActive: now() };
		if (!existsSync(file)) writeAtomic(file, JSON.stringify(this.meta, null, 2));
	}

	/** Only an existing project, never created by looking. */
	static open(path: string, root = storeRoot()): Project | undefined {
		return existsSync(join(root, slugFor(resolve(path)), 'project.json')) ? new Project(path, root) : undefined;
	}

	touch(): void {
		this.meta.lastActive = now();
		writeAtomic(join(this.dir, 'project.json'), JSON.stringify(this.meta, null, 2));
	}

	/** The run's latest activity, for status to show a run is still moving. Throttled by the caller. */
	beat(b: { at: number; kind: string; text: string; task?: string }): void {
		writeAtomic(join(this.dir, 'beat.json'), JSON.stringify({ ...b, text: b.text.slice(0, 200) }, null, 2));
	}

	lastBeat(): { at: number; kind: string; text: string; task?: string } | undefined {
		return readJson(join(this.dir, 'beat.json'));
	}

	private taskFile(id: string) {
		return join(this.dir, 'tasks', `${id}.json`);
	}

	tasks(): StoredTask[] {
		const dir = join(this.dir, 'tasks');
		return readdirSync(dir)
			.filter((f) => /^T-\d+\.json$/.test(f))
			.map((f) => readJson<StoredTask>(join(dir, f)))
			.filter((t): t is StoredTask => !!t)
			.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
	}

	get(id: string): StoredTask | undefined {
		return readJson<StoredTask>(this.taskFile(id));
	}

	/** Claim the next free id with an exclusive create, so two processes never share one. */
	private claim(): string {
		const taken = this.tasks().map((t) => Number(t.id.slice(2)));
		for (let n = (taken.length ? Math.max(...taken) : 0) + 1; ; n++) {
			const id = `T-${String(n).padStart(4, '0')}`;
			try {
				writeFileSync(this.taskFile(id), '{}', { flag: 'wx' });
				return id;
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
			}
		}
	}

	/** Add tasks in order; `depends` may name plan keys (`t1`) or existing ids. */
	add(tasks: NewTask[], opts: { goal?: string; source?: StoredTask['source']; status?: Status; reason?: string } = {}): StoredTask[] {
		const keys = new Map<string, string>();
		const out: StoredTask[] = [];
		for (const [i, t] of tasks.entries()) {
			const id = this.claim();
			keys.set(t.key ?? `t${i + 1}`, id);
			const task: StoredTask = {
				id,
				title: t.title.trim(),
				type: (t.type ?? 'FEATURE').toUpperCase(),
				tier: (t.tier ?? 'S').toUpperCase(),
				status: opts.status ?? 'planned',
				reason: opts.reason,
				acs: (t.acs ?? []).map((a) => ({ text: a.text, verify: a.verify || undefined })),
				steps: t.steps ?? [],
				depends: (t.depends ?? []).map((d) => keys.get(d) ?? d).filter((d) => /^T-\d+$/.test(d)),
				brief: t.brief ?? t.notes,
				files: t.files,
				goal: opts.goal,
				source: opts.source ?? 'user',
				attempts: [],
				evidence: [],
				lessons: [],
				created: now(),
				updated: now(),
			};
			this.save(task);
			this.log({ event: 'created', id, title: task.title, ...(opts.status && { status: opts.status }) });
			out.push(task);
		}
		this.touch();
		return out;
	}

	save(task: StoredTask): void {
		task.updated = now();
		writeAtomic(this.taskFile(task.id), JSON.stringify(task, null, 2));
	}

	update(id: string, change: (t: StoredTask) => void): StoredTask {
		const t = this.get(id);
		if (!t) throw new Error(`no task ${id} in ${this.meta.name}`);
		change(t);
		this.save(t);
		return t;
	}

	setStatus(id: string, status: Status, reason?: string): StoredTask {
		const t = this.update(id, (t) => {
			t.status = status;
			t.reason = reason;
		});
		this.log({ event: status, id, reason });
		return t;
	}

	/** Put a task first among ready tasks, without renumbering. Only a queued task can be bumped. */
	bump(id: string): StoredTask {
		const t = this.get(id);
		if (!t || !OPEN.has(t.status)) throw new Error(`no queued task ${id} in ${this.meta.name}`);
		const bumped = this.update(id, (t) => (t.bumpedAt = Date.now()));
		this.log({ event: 'bumped', id });
		return bumped;
	}

	/**
	 * Open tasks in the order to work them: a bump first, then canonical type order, then id;
	 * a task whose dependency is still open comes after it.
	 */
	queue(): StoredTask[] {
		const all = this.tasks();
		const open = all.filter((t) => OPEN.has(t.status));
		const rank = (t: StoredTask) => {
			const i = TYPE_ORDER.indexOf(t.type);
			return i < 0 ? TYPE_ORDER.length : i;
		};
		const sorted = open.sort((a, b) => (b.bumpedAt ?? 0) - (a.bumpedAt ?? 0) || rank(a) - rank(b) || a.id.localeCompare(b.id, undefined, { numeric: true }));
		// Dependencies override the canonical order: emit a task only after its open dependencies.
		const out: StoredTask[] = [];
		const placed = new Set<string>();
		const openIds = new Set(open.map((t) => t.id));
		const visit = (t: StoredTask, seen: Set<string>) => {
			if (placed.has(t.id) || seen.has(t.id)) return;
			seen.add(t.id);
			for (const d of t.depends) {
				const dep = openIds.has(d) ? sorted.find((x) => x.id === d) : undefined;
				if (dep) visit(dep, seen);
			}
			placed.add(t.id);
			out.push(t);
		};
		for (const t of sorted) visit(t, new Set());
		return out;
	}

	/** Recent lessons from finished tasks, newest first. */
	lessons(limit = 8): string[] {
		return this.tasks()
			.filter((t) => t.lessons.length)
			.sort((a, b) => b.updated.localeCompare(a.updated) || b.id.localeCompare(a.id, undefined, { numeric: true }))
			.flatMap((t) => t.lessons)
			.slice(0, limit);
	}

	/** How often each tier passed on its first attempt, over tasks that have had one: sizing advice for the planner. */
	firstTry(): string | undefined {
		const by = new Map<string, [number, number]>();
		const causes = new Map<string, number>();
		for (const t of this.tasks()) {
			if (!t.attempts.length) continue;
			const [ok, n] = by.get(t.tier) ?? [0, 0];
			by.set(t.tier, [ok + (t.attempts[0].ok ? 1 : 0), n + 1]);
			for (const a of t.attempts) if (!a.ok && a.cause) causes.set(a.cause, (causes.get(a.cause) ?? 0) + 1);
		}
		// S, M, L first; any other tier after them.
		const rank = (tier: string) => ['S', 'M', 'L', tier].indexOf(tier);
		const parts = [...by].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)).map(([tier, [ok, n]]) => `${tier}: ${ok} of ${n}`);
		if (!parts.length) return undefined;
		// Why tasks failed tells the planner more than how often: too-big means split finer.
		const top = [...causes].sort(([, a], [, b]) => b - a).slice(0, 4).map(([cause, n]) => `${cause} ${n}`);
		return `${parts[0]} passed on the first attempt${parts.slice(1).map((x) => `; ${x}`).join('')}${top.length ? `; failed attempts by cause: ${top.join(', ')}` : ''}`;
	}

	/** Goals waiting for the project's run to end, oldest first. A missing or bad file is an empty queue. */
	goals(): QueuedGoal[] {
		const q = readJson<QueuedGoal[]>(join(this.dir, 'goals.json'));
		return Array.isArray(q) ? q.filter((g) => typeof g?.goal === 'string') : [];
	}

	// ponytail: read-modify-write without a lock, two processes queueing at the same instant can lose one; lock the file if that shows up.
	private saveGoals(q: QueuedGoal[]): void {
		writeAtomic(join(this.dir, 'goals.json'), JSON.stringify(q, null, 2));
	}

	/** Queue a goal; returns its 1-based position. An identical queued goal is not added twice. */
	enqueue(goal: string): number {
		const q = this.goals();
		const g = goal.trim();
		const at = q.findIndex((x) => x.goal === g);
		if (at >= 0) return at + 1;
		q.push({ goal: g, at: now() });
		this.saveGoals(q);
		this.log({ event: 'queue', goal: g, n: q.length });
		return q.length;
	}

	/** Remove and return queued goal n (1-based); undefined when there is none. */
	unqueue(n: number): QueuedGoal | undefined {
		const q = this.goals();
		if (!Number.isInteger(n) || n < 1 || n > q.length) return undefined;
		const [g] = q.splice(n - 1, 1);
		this.saveGoals(q);
		this.log({ event: 'unqueue', goal: g.goal, n });
		return g;
	}

	/** Take the oldest queued goal off the queue. */
	nextGoal(): string | undefined {
		return this.unqueue(1)?.goal;
	}

	log(event: Record<string, unknown>): void {
		appendFileSync(join(this.dir, 'ledger.jsonl'), JSON.stringify({ at: now(), ...event }) + '\n');
	}

	decide(decision: string, why: string): void {
		appendFileSync(join(this.dir, 'decisions.jsonl'), JSON.stringify({ at: now(), decision, why }) + '\n');
	}

	research(name: string, content: string): string {
		mkdirSync(join(this.dir, 'research'), { recursive: true });
		const file = join(this.dir, 'research', `${name.replace(/[^\w.-]+/g, '-')}.md`);
		writeAtomic(file, content);
		return file;
	}

	/** Past run reports, newest first. */
	reports(): { file: string; at: string; summary: string }[] {
		const dir = join(this.dir, 'research');
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((f) => /^report-.*\.md$/.test(f))
			.map((f) => {
				const full = join(dir, f);
				const at = statSync(full).mtime.toISOString();
				const summary = (readFileSync(full, 'utf8').split('\n')[2] ?? '').trim();
				return { file: f, at, summary };
			})
			.sort((a, b) => b.at.localeCompare(a.at));
	}

	/** The run that holds this project, if its process is still alive. */
	running(): RunInfo | undefined {
		const info = readJson<RunInfo>(join(this.dir, 'run.json'));
		return info && alive(info.pid, info.proc) ? info : undefined;
	}

	/** The run that holds this project's lock but whose process is gone: it died mid-run. */
	died(): RunInfo | undefined {
		const info = readJson<RunInfo>(join(this.dir, 'run.json'));
		return info && !alive(info.pid, info.proc) ? info : undefined;
	}

	/**
	 * Take the project for a run: one run per project across every process, because two would
	 * edit the same working tree. A lock whose process died is taken over.
	 */
	lock(info: Omit<RunInfo, 'pid' | 'started'> & { pid?: number }): RunInfo {
		const file = join(this.dir, 'run.json');
		const pid = info.pid ?? process.pid;
		const mine: RunInfo = { pid, started: now(), goal: info.goal, log: info.log, by: info.by, proc: procStart(pid) };
		for (let tries = 0; tries < 2; tries++) {
			try {
				writeFileSync(file, JSON.stringify(mine, null, 2), { flag: 'wx' });
				this.log({ event: 'run', pid: mine.pid, goal: mine.goal });
				// Only the lock's holder works tasks: anything still active was left by a run that died.
				for (const t of this.tasks()) if (t.status === 'active') this.setStatus(t.id, 'planned', 'its run ended before it did');
				return mine;
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
				const held = this.running();
				if (held && held.pid !== mine.pid) throw new Error(`${this.meta.name} already has a run going (pid ${held.pid}, since ${held.started.slice(11, 16)}): stop it first`);
				rmSync(file, { force: true });
			}
		}
		throw new Error(`${this.meta.name}: could not take the run lock`);
	}

	/** A new log file for a background run; only the newest 20 are kept. */
	runLog(): string {
		const dir = join(this.dir, 'runs');
		mkdirSync(dir, { recursive: true });
		const logs = readdirSync(dir).filter((f) => f.endsWith('.log')).sort();
		for (const old of logs.slice(0, Math.max(0, logs.length - 19))) rmSync(join(dir, old), { force: true });
		return join(dir, `${now().replace(/[:.]/g, '-')}-${process.pid}.log`);
	}

	/** Give the project back; only the lock's own process can. */
	unlock(pid = process.pid): void {
		const file = join(this.dir, 'run.json');
		if (readJson<RunInfo>(file)?.pid === pid) rmSync(file, { force: true });
	}

	/** Counts for a one-line summary. */
	summary(): Record<Status, number> {
		const out = { planned: 0, active: 0, review: 0, blocked: 0, deferred: 0, done: 0, dropped: 0 } as Record<Status, number>;
		for (const t of this.tasks()) out[t.status]++;
		return out;
	}

	/** Lifetime spend: every attempt's cost, across every task ever stored. */
	spent(): number {
		return this.tasks().reduce((sum, t) => sum + t.attempts.reduce((s, a) => s + (a.costUsd ?? 0), 0), 0);
	}
}

/** What a person can decide about a task, and the status it leaves. */
export const DECISIONS = { retry: 'planned', unblock: 'planned', defer: 'deferred', drop: 'dropped', approve: 'done' } as const;
export type Decision = keyof typeof DECISIONS;

/** Status words a decision can act on in bulk, instead of a single task id. */
export const BULK = ['blocked', 'review', 'deferred'] as const;

/** The command that unsticks a task, read from its status and reason alone: no ledger, no filesystem. */
export function nextStep(t: Pick<StoredTask, 'id' | 'status' | 'reason'>): string | undefined {
	const { id, status } = t;
	const reason = t.reason ?? '';
	if (status === 'deferred') return `jarvis-code task retry ${id} queues it`;
	if (status === 'review') {
		if (/not apply to the main tree/.test(reason)) return `its patch no longer applies: jarvis-code task retry ${id} to redo it, or drop ${id}`;
		if (/could not be taken back out/.test(reason)) return `its changes are stuck in your tree: check them, then jarvis-code task approve ${id} or retry ${id}`;
		return `jarvis-code task approve ${id} if it looks right, or retry ${id}`;
	}
	if (status !== 'blocked') return undefined;
	const same = reason.match(/same way on \d+ routes \((.*)\): likely/);
	if (same) return `${same[1]} fails the same way on every route: fix the check or the environment, then jarvis-code task retry ${id}`;
	if (/review asked for changes:/.test(reason)) return `jarvis-code task retry ${id} with what the review asked for, or drop ${id}`;
	if (/no agent route available/.test(reason)) return `jarvis-code status to see why, then jarvis-code learn reset <route>`;
	return `jarvis-code task retry ${id} "<what the next worker should know>", or drop ${id}`;
}

const decisionSuffix = (verb: Decision) => (verb === 'approve' ? 'approved: done' : verb === 'retry' || verb === 'unblock' ? 'back in the queue' : DECISIONS[verb]);

function applyDecision(p: Project, verb: Decision, t: StoredTask, why?: string, intent?: boolean): void {
	if (verb === 'approve' && t.status !== 'review') throw new Error(`${t.id} is ${t.status}, not waiting for review`);
	if ((verb === 'retry' || verb === 'unblock') && (t.status === 'planned' || t.status === 'active')) throw new Error(`${t.id} is already in the queue`);
	if (verb === 'retry' || verb === 'unblock') p.update(t.id, (t) => (t.hint = why || undefined));
	p.setStatus(t.id, DECISIONS[verb], why || (verb === 'approve' ? 'approved by hand' : undefined));
	if (intent && (verb === 'drop' || verb === 'approve')) recordIntent({ kind: verb === 'drop' ? 'dropped' : 'accepted', text: t.title, project: p.meta.name });
}

/** A person's decision on a task, from the CLI or the cockpit. Returns what happened, or throws why not. `intent` records drops and approvals in intent memory. */
export function decideTask(p: Project, verb: Decision, id: string, why?: string, opts: { intent?: boolean } = {}): string {
	const word = id.toLowerCase();
	if ((BULK as readonly string[]).includes(word)) {
		const matches = p.tasks().filter((t) => t.status === word);
		const oks: string[] = [];
		const errs: string[] = [];
		for (const t of matches) {
			try {
				applyDecision(p, verb, t, why, opts.intent);
				oks.push(t.id);
			} catch (e) {
				errs.push((e as Error).message);
			}
		}
		if (!oks.length) throw new Error(errs.length ? errs.join('; ') : `no task is ${word}`);
		return `${oks.length} task${oks.length === 1 ? '' : 's'} ${decisionSuffix(verb)}: ${oks.join(', ')}`;
	}
	const t = p.get(id.toUpperCase());
	if (!t) throw new Error(`no task ${id} in ${p.meta.name}`);
	applyDecision(p, verb, t, why, opts.intent);
	let msg = `${t.id} ${decisionSuffix(verb)}`;
	if ((verb === 'retry' || verb === 'unblock') && !why) {
		const last2 = t.attempts.slice(-2);
		const cause = last2[0]?.cause;
		if (last2.length === 2 && last2.every((a) => !a.ok) && cause && cause !== 'flaky' && last2[1].cause === cause) {
			msg += ` · last 2 failed: ${cause}, a plain retry will likely fail again: add a hint or drop it`;
		}
	}
	return msg;
}
