import { exec, execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

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
	/** The brief's execution prompt / notes, when it has one. */
	brief?: string;
	/** Task ids this one waits for. */
	depends?: string[];
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
}

export interface Check {
	cmd: string;
	ok: boolean;
	output: string;
}

/** Where tasks come from and where their outcome is recorded. */
export interface TaskSource {
	readonly name: string;
	/** Open tasks in the order to work them, minus the ones this run already handled. */
	next(skip: ReadonlySet<string>): Promise<Task[]>;
	add(plan: PlannedTask[]): Promise<string[]>;
	start(task: Task): Promise<void>;
	/** Run the task's verify commands. */
	check(task: Task): Promise<Check[]>;
	/** Record success; `closed: false` means it passed but the source wants a human (e.g. audits). */
	close(task: Task, checks: Check[], note: string): Promise<{ closed: boolean; message: string }>;
	block(task: Task, reason: string): Promise<void>;
}

const tail = (s: string, n = 400) => (s.length > n ? '…' + s.slice(-n) : s).trim();

/**
 * Run a verify command through the shell in `cwd`. A shell on purpose: verify commands are
 * shell lines (`test -f x && npm test`), the same ones Foreman runs, written by the plan —
 * and the workers that satisfy them already run arbitrary commands in this repo.
 */
export function shell(cmd: string, cwd: string, timeoutSec: number): Promise<Check> {
	return new Promise((resolve) => {
		exec(cmd, { cwd, timeout: timeoutSec * 1000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
			resolve({ cmd, ok: !err, output: tail(`${stdout}${stderr}`) || (err ? err.message : '') });
		});
	});
}

// --- Foreman ------------------------------------------------------------------------

export interface FmResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Foreman as the task backend, through its CLI (`fm … --json`). Foreman state is never
 * written directly; briefs are only read for their criteria, steps and execution prompt,
 * which `fm task show --json` does not carry.
 */
export class ForemanSource implements TaskSource {
	readonly name = 'foreman';
	constructor(
		private bin: string,
		private cwd: string,
		private timeoutSec: number,
		private log: (s: string) => void = () => {},
	) {}

	fm(args: string[], timeoutSec = 120): Promise<FmResult> {
		return new Promise((resolve) => {
			execFile(this.bin, args, { cwd: this.cwd, timeout: timeoutSec * 1000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
				// execFile's `code` is the exit status, or a string like ENOENT when it never ran.
				const c = (err as { code?: number | string } | null)?.code;
				const code = !err ? 0 : typeof c === 'number' ? c : c === 'ENOENT' ? 127 : 1;
				resolve({ code, stdout, stderr: stderr || (err?.message ?? '') });
			});
		});
	}

	/** `fm init` is idempotent: it makes this directory a Foreman project if it is not one yet. */
	async init(): Promise<void> {
		const r = await this.fm(['init']);
		if (r.code !== 0) throw new Error(`fm init: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
	}

	private async json<T>(args: string[]): Promise<T> {
		const r = await this.fm([...args, '--json']);
		if (r.code !== 0) throw new Error(`fm ${args.join(' ')}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
		return JSON.parse(r.stdout) as T;
	}

	async next(skip: ReadonlySet<string>): Promise<Task[]> {
		const q = await this.json<{ order: { id: string; title: string; type: string; tier: string; status: string; path?: string }[] }>(['queue']);
		return q.order.filter((t) => !skip.has(t.id) && t.status !== 'done').map((t) => ({ ...t, ...readBrief(t.path) }));
	}

	async add(plan: PlannedTask[]): Promise<string[]> {
		const ids = new Map<string, string>();
		const out: string[] = [];
		for (const [i, t] of plan.entries()) {
			const args = ['task', 'new', t.title, '--type', (t.type ?? 'FEATURE').toUpperCase(), '--tier', (t.tier ?? 'S').toUpperCase(), '--source', 'user'];
			for (const ac of t.acs ?? []) args.push('--ac', ac.verify ? `${ac.text} :: ${ac.verify}` : ac.text);
			for (const s of t.steps ?? []) args.push('--step', s);
			const deps = (t.depends ?? []).map((d) => ids.get(d) ?? d).filter((d) => /^T-\d+$/.test(d));
			if (deps.length) args.push('--depends', deps.join(','));
			const made = await this.json<{ id: string }>(args);
			ids.set(t.key ?? `t${i + 1}`, made.id);
			if (t.notes) await this.fm(['task', 'set', made.id, '--section', 'Execution prompt', '--text', t.notes]);
			out.push(made.id);
		}
		return out;
	}

	async start(task: Task): Promise<void> {
		// Focus is Foreman's "one active task"; a brief not planned enough for its tier is
		// refused focus, which only matters to Foreman's own hooks — the worker runs anyway.
		const r = await this.fm(['focus', task.id]);
		if (r.code !== 0) this.log(`fm focus ${task.id}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
	}

	async check(task: Task): Promise<Check[]> {
		const out: Check[] = [];
		for (const [i, ac] of task.acs.entries()) {
			if (!ac.verify) continue;
			// fm runs the command and records it as evidence; its exit code is the check's.
			const r = await this.fm(['task', 'evidence', task.id, '--ac', String(i + 1), '--run', ac.verify, '--timeout', String(this.timeoutSec)], this.timeoutSec + 30);
			out.push({ cmd: ac.verify, ok: r.code === 0, output: tail(`${r.stdout}${r.stderr}`) });
		}
		return out;
	}

	async close(task: Task, checks: Check[], note: string): Promise<{ closed: boolean; message: string }> {
		const cmds = checks.map((c) => c.cmd);
		const args =
			task.tier.toUpperCase() === 'S'
				? ['task', 'finish', task.id, '--run', cmds.length ? cmds.join(' && ') : 'git status --short', '--audit', note, '--timeout', String(this.timeoutSec)]
				: ['task', 'done', task.id];
		const r = await this.fm(args, this.timeoutSec + 30);
		const message = (r.stderr || r.stdout).trim().split('\n').pop() ?? '';
		return { closed: r.code === 0, message };
	}

	async block(task: Task, reason: string): Promise<void> {
		await this.fm(['task', 'block', task.id, reason.slice(0, 500)]);
	}
}

/** Criteria, steps and execution prompt out of a Foreman brief. */
export function readBrief(path: string | undefined): Pick<Task, 'acs' | 'steps' | 'brief' | 'depends'> {
	let md = '';
	try {
		if (path) md = readFileSync(path, 'utf8');
	} catch {
		/* a brief we cannot read is worked from its title */
	}
	const section = (name: string) => {
		const m = md.match(new RegExp(`^## ${name}[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'));
		return m ? m[1].trim() : '';
	};
	const acs = section('Acceptance criteria')
		.split('\n')
		.map((l) => l.match(/^- \[[ x]\] (.*?)(?: — verify with `(.+)`)?\s*$/))
		.filter((m): m is RegExpMatchArray => !!m)
		.map((m) => ({ text: m[1], verify: m[2] }));
	const steps = section('Steps')
		.split('\n')
		.map((l) => l.match(/^\d+\. \[[ x]\] (.*?)(?:\s+<- CURRENT)?\s*$/)?.[1])
		.filter((s): s is string => !!s);
	const brief = [section('Execution prompt'), section('Interpretation')].filter(Boolean).join('\n\n') || undefined;
	const depends = md.match(/^depends_on: \[(.*)\]$/m)?.[1].split(',').map((d) => d.trim()).filter(Boolean) ?? [];
	return { acs, steps, brief, depends };
}

// --- in memory ------------------------------------------------------------------------

/** Tasks held in the process: the demo, tests, and running without Foreman. */
export class MemorySource implements TaskSource {
	readonly name = 'memory';
	tasks: (Task & { status: 'open' | 'done' | 'blocked'; depends: string[]; reason?: string })[] = [];
	private n = 0;
	constructor(private cwd: string, private timeoutSec: number) {}

	async next(skip: ReadonlySet<string>): Promise<Task[]> {
		return this.tasks.filter((t) => t.status === 'open' && !skip.has(t.id));
	}

	async add(plan: PlannedTask[]): Promise<string[]> {
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
				status: 'open',
				depends: (p.depends ?? []).map((d) => keys.get(d) ?? d),
			});
			return id;
		});
	}

	async start(): Promise<void> {}

	async check(task: Task): Promise<Check[]> {
		const out: Check[] = [];
		for (const ac of task.acs) if (ac.verify) out.push(await shell(ac.verify, this.cwd, this.timeoutSec));
		return out;
	}

	async close(task: Task): Promise<{ closed: boolean; message: string }> {
		this.find(task).status = 'done';
		return { closed: true, message: 'done' };
	}

	async block(task: Task, reason: string): Promise<void> {
		Object.assign(this.find(task), { status: 'blocked', reason });
	}

	private find(task: Task) {
		const t = this.tasks.find((x) => x.id === task.id);
		if (!t) throw new Error(`unknown task ${task.id}`);
		return t;
	}
}
