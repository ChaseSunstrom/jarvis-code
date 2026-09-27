import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { clean } from './agents/types.js';
import type { PlannedTask } from './tasks.js';

/**
 * What jarvis-code can learn about a repository without an agent, for the planner and the
 * prompt writer: its layout, what it says about itself, how it builds, what changed lately,
 * what is already queued and what earlier workers learned.
 */
export interface Pack {
	openTasks?: string[];
	lessons?: string[];
	/** Worker routes and how they have done here. */
	workers?: string[];
	/** Project.firstTry(): how often each tier passed on its first attempt. */
	sizing?: string;
}

const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', '.next', 'coverage']);

function head(file: string, lines: number): string | undefined {
	try {
		return readFileSync(file, 'utf8').split('\n').slice(0, lines).join('\n').trim();
	} catch {
		return undefined;
	}
}

/** Build and test entry points: package.json scripts, Makefile targets, and the usual manifests. */
function commands(cwd: string): string[] {
	const out: string[] = [];
	try {
		const scripts = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).scripts ?? {};
		for (const [k, v] of Object.entries(scripts).slice(0, 12)) out.push(`npm run ${k}: ${String(v).slice(0, 100)}`);
	} catch {
		/* no package.json */
	}
	const make = head(join(cwd, 'Makefile'), 200);
	if (make) out.push(`make targets: ${[...make.matchAll(/^([A-Za-z][\w-]*):/gm)].map((m) => m[1]).slice(0, 15).join(', ')}`);
	for (const [f, what] of [['Cargo.toml', 'cargo build / cargo test'], ['go.mod', 'go build ./... / go test ./...'], ['pyproject.toml', 'Python project (pyproject.toml)'], ['CMakeLists.txt', 'CMake project']] as const)
		if (existsSync(join(cwd, f))) out.push(what);
	return out;
}

export function contextPack(cwd: string, pack: Pack = {}): string {
	const parts: string[] = [];
	try {
		const entries = readdirSync(cwd, { withFileTypes: true })
			.filter((e) => !SKIP.has(e.name) && !(e.name.startsWith('.') && e.name !== '.github'))
			.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
			.sort();
		if (entries.length) parts.push(`Top level: ${entries.slice(0, 40).join(' ')}${entries.length > 40 ? ` … (${entries.length - 40} more)` : ''}`);
	} catch {
		/* unreadable */
	}
	const readme = ['README.md', 'README', 'readme.md', 'README.rst'].map((f) => head(join(cwd, f), 25)).find(Boolean);
	if (readme) parts.push(`README (first lines):\n${readme}`);
	const cmds = commands(cwd);
	if (cmds.length) parts.push(`Build and test:\n${cmds.map((c) => `- ${c}`).join('\n')}`);
	try {
		const log = execFileSync('git', ['log', '--oneline', '-8'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
		if (log) parts.push(`Recent commits:\n${log}`);
	} catch {
		/* not a repository */
	}
	if (pack.openTasks?.length) parts.push(`Already queued (do not plan these again):\n${pack.openTasks.slice(0, 20).map((t) => `- ${t}`).join('\n')}`);
	if (pack.lessons?.length) parts.push(`Lessons earlier workers left here:\n${pack.lessons.map((l) => `- ${l}`).join('\n')}`);
	if (pack.sizing) parts.push(`How tasks here went, by tier: ${pack.sizing}`);
	if (pack.workers?.length) parts.push(`Workers available (size tasks for them):\n${pack.workers.map((w) => `- ${w}`).join('\n')}`);
	// The repository is not trusted text: no escape sequences, and a hard size limit.
	return parts.length ? clean(`Repository facts (gathered by jarvis-code):\n\n${parts.join('\n\n')}`).slice(0, 6000) : '';
}

export interface Intake {
	items: { type: string; text: string }[];
	must: string[];
	never: string[];
	doneWhen: string[];
}

const TAG = /^\s*(FIX|FEATURE|CLEAN|PERF|PERFORMANCE|SECURITY|RESEARCH|MUST|NEVER|DONE-WHEN)\s*:\s*(.+)$/i;

/** A goal written as a tagged list: `FIX: …` lines are items, `MUST:`/`NEVER:`/`DONE-WHEN:` constraints. */
export function parseIntake(goal: string): Intake | undefined {
	const out: Intake = { items: [], must: [], never: [], doneWhen: [] };
	for (const line of goal.split('\n')) {
		const m = line.match(TAG);
		if (!m) continue;
		const tag = m[1].toUpperCase();
		const text = m[2].trim();
		if (tag === 'MUST') out.must.push(text);
		else if (tag === 'NEVER') out.never.push(text);
		else if (tag === 'DONE-WHEN') out.doneWhen.push(text);
		else out.items.push({ type: tag === 'PERFORMANCE' ? 'PERF' : tag, text });
	}
	return out.items.length || out.must.length || out.never.length || out.doneWhen.length ? out : undefined;
}

export function intakeText(i: Intake): string {
	const parts: string[] = [];
	if (i.items.length) parts.push(`The user listed these items. Plan each as its own task (or a few), keeping its type:\n${i.items.map((x) => `- ${x.type}: ${x.text}`).join('\n')}`);
	if (i.must.length) parts.push(`Every task must respect:\n${i.must.map((x) => `- ${x}`).join('\n')}`);
	if (i.never.length) parts.push(`No task may:\n${i.never.map((x) => `- ${x}`).join('\n')}`);
	if (i.doneWhen.length) parts.push(`The goal is done when (turn these into verify commands):\n${i.doneWhen.map((x) => `- ${x}`).join('\n')}`);
	return parts.join('\n\n');
}

const TYPES = new Set(['RESEARCH', 'CLEAN', 'PERF', 'PERFORMANCE', 'SECURITY', 'FIX', 'FEATURE']);

/**
 * Verify commands jarvis-code itself must not run: they escalate, wipe, download and execute,
 * or publish. A plan comes from agents that read the repository, and a repository can lie.
 * ponytail: a denylist for obvious cases, not a sandbox; checks run with the user's rights.
 */
const DANGEROUS = [
	/\b(sudo|doas|su\s+-|mkfs|shutdown|reboot|halt|poweroff)\b/,
	/\bdd\s+[^|;&]*\bof=\/dev\//,
	/\brm\s+(-\w+\s+)*(\/|~|\$HOME|\/\*)(\s|$)/,
	/\b(curl|wget|fetch)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/,
	/\bgit\s+push\b/,
	/\b(npm|yarn|pnpm)\s+publish\b/,
	/\bchmod\s+(-\w+\s+)*[0-7]*777\s+\/(\s|$)/,
	/:\(\)\s*\{.*\};\s*:/,
];

export const dangerous = (cmd: string) => DANGEROUS.some((re) => re.test(cmd));

// ponytail: naive top-level split on ; && || | — no quote/backslash awareness, good enough for
// the one-line shell verify commands a planner writes.
const SPLIT = /(\|\||&&|;|\|)/;

function clauses(cmd: string): { sep: string | null; stages: string[] }[] {
	const out: { sep: string | null; stages: string[] }[] = [];
	let sep: string | null = null;
	for (const part of cmd.split(SPLIT)) {
		if (part === '||' || part === '&&' || part === ';' || part === '|') {
			sep = part;
			continue;
		}
		const text = part.trim();
		if (sep === '|' && out.length) out[out.length - 1].stages.push(text);
		else out.push({ sep, stages: [text] });
		sep = null;
	}
	return out;
}

const TRIVIAL = /^(true|:|exit\s+0)$/i;
const BARE_ECHO = /^echo\b/i;
const HIDES_EXIT = new Set(['tail', 'head', 'tee', 'cat', 'sort', 'uniq', 'wc', 'sed', 'awk']);

/** What is wrong with a single verify command: checks that can never fail, so a real bug always passes. */
export function verifyProblems(cmd: string): string[] {
	const problems: string[] = [];
	const cs = clauses(cmd);
	if (!cs.length) return problems;
	const last = cs[cs.length - 1];
	const lastStage = last.stages[last.stages.length - 1] ?? '';
	if (cs.length === 1 && last.stages.length === 1 && (TRIVIAL.test(lastStage) || BARE_ECHO.test(lastStage))) {
		problems.push(`"${cmd}" always exits 0, so it can never fail: give it a real check (e.g. test -f a file it should produce, or grep its output).`);
	} else if (last.sep === '||' && (/^(true|:)$/i.test(lastStage) || BARE_ECHO.test(lastStage))) {
		problems.push(`"${cmd}" ends in "|| ${lastStage}", which always succeeds and hides a real failure: drop the fallback, or replace it with a check that can fail.`);
	} else if (last.sep === ';' && (TRIVIAL.test(lastStage) || BARE_ECHO.test(lastStage))) {
		problems.push(`"${cmd}" ends in "; ${lastStage}", which runs regardless of what came before and hides its exit code: drop it, or make it the only check.`);
	}
	if (last.stages.length > 1) {
		const word = lastStage.split(/\s+/)[0]?.toLowerCase();
		if (word && HIDES_EXIT.has(word) && !/pipefail/i.test(cmd))
			problems.push(`"${cmd}" pipes into ${word}, which hides the exit code of what ran before it: drop the pipe, or start the command with "set -o pipefail".`);
	}
	return problems;
}

/** The plan with any dangerous verify command removed (its criterion then waits for a person), and what was removed. */
export function defang(plan: PlannedTask[]): { plan: PlannedTask[]; removed: string[] } {
	const removed: string[] = [];
	const safe = plan.map((t) => ({
		...t,
		acs: (t.acs ?? []).map((a) => {
			if (!a.verify || !dangerous(a.verify)) return a;
			removed.push(`${t.title}: ${a.verify}`);
			return { text: a.text };
		}),
	}));
	return { plan: safe, removed };
}

// ponytail: a keyword next to the path, not a parse of the step; "address" counts as "add".
const CREATES = /\b(create|add|new|write)/i;

/**
 * What is wrong with a plan, task by task; empty when it can be stored as it is. With `cwd`,
 * each task's files must be repository paths that exist, or that one of its steps creates.
 */
export function validatePlan(plan: PlannedTask[], cwd?: string): string[] {
	const problems: string[] = [];
	const keys = new Set(plan.map((t, i) => t.key ?? `t${i + 1}`));
	if (plan.length > 25) problems.push(`${plan.length} tasks: group them into at most 25`);
	for (const [i, t] of plan.entries()) {
		const name = `${t.key ?? `t${i + 1}`} "${t.title}"`;
		if (!t.acs?.some((a) => a.verify?.trim())) problems.push(`${name} has no verify command: give each criterion a shell command that exits 0 only when it holds`);
		if (t.tier && !/^[SML]$/i.test(t.tier)) problems.push(`${name} has tier "${t.tier}": use S, M or L`);
		if (t.type && !TYPES.has(t.type.toUpperCase())) problems.push(`${name} has type "${t.type}": use FIX, FEATURE, CLEAN, PERF, SECURITY or RESEARCH`);
		for (const d of t.depends ?? []) if (!keys.has(d) && !/^T-\d+$/.test(d)) problems.push(`${name} depends on "${d}", which is not a task key in this plan`);
		const files = t.files ?? [];
		if ((t.tier ?? 'S').toUpperCase() === 'S' && files.length > 2)
			problems.push(`${name} is tier S but lists ${files.length} files (${files.join(', ')}): S is 1-2 files, so make it M or split it`);
		if (cwd)
			for (const f of files) {
				if (isAbsolute(f) || f.split(/[\\/]/).includes('..')) problems.push(`${name} lists "${f}", which is outside the repository: list paths relative to the repository root`);
				else if (!existsSync(join(cwd, f)) && !(t.steps ?? []).some((s) => s.includes(f) && CREATES.test(s)))
					problems.push(`${name} lists "${f}", which does not exist: fix the path, or add a step that creates it (e.g. "Create ${f} …")`);
			}
		const seen = new Set<string>();
		for (const a of t.acs ?? []) {
			if (!a.verify) continue;
			if (dangerous(a.verify)) problems.push(`${name} has a verify command jarvis-code will not run (it escalates, wipes, downloads and executes, or publishes): ${a.verify}`);
			for (const p of verifyProblems(a.verify)) problems.push(`${name}: ${p}`);
			const norm = a.verify.trim().replace(/\s+/g, ' ');
			if (seen.has(norm)) problems.push(`${name} has two criteria with the same verify command "${a.verify}": give each criterion its own check, or drop the duplicate`);
			seen.add(norm);
		}
	}
	// A dependency cycle would leave every task in it waiting forever.
	const deps = new Map(plan.map((t, i) => [t.key ?? `t${i + 1}`, t.depends ?? []]));
	const state = new Map<string, 'visiting' | 'done'>();
	const visit = (k: string): boolean => {
		if (state.get(k) === 'done') return false;
		if (state.get(k) === 'visiting') return true;
		state.set(k, 'visiting');
		const cyclic = (deps.get(k) ?? []).some((d) => deps.has(d) && visit(d));
		state.set(k, 'done');
		return cyclic;
	};
	if ([...deps.keys()].some(visit)) problems.push('the depends links form a cycle: order the tasks so each depends only on earlier ones');
	return problems;
}
