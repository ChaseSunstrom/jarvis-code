import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { changes, git, snapshot } from './review.js';
import type { Learning } from './learn.js';
import type { Project } from './store.js';

/**
 * One attempt's own working tree, for workers running side by side. It starts from the main
 * tree as it is now (uncommitted changes included) through a dangling commit, so no branch,
 * ref or index of the user's changes; its changes come back as a patch.
 */
export interface Worktree {
	dir: string;
	/** The tree it started from. */
	base: string;
	remove(): Promise<void>;
}

// commit-tree needs an identity; this one only ever names a dangling commit nobody sees.
const IDENTITY = { GIT_AUTHOR_NAME: 'jarvis-code', GIT_AUTHOR_EMAIL: 'jarvis-code@localhost', GIT_COMMITTER_NAME: 'jarvis-code', GIT_COMMITTER_EMAIL: 'jarvis-code@localhost' };

// git's worktree bookkeeping (add, remove, prune) is not safe to run concurrently in one repository.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
	const next = queue.then(fn, fn);
	queue = next.catch(() => {});
	return next;
}

const run = (cmd: string, args: string[]) => new Promise<boolean>((resolve) => execFile(cmd, args, (err) => resolve(!err)));

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** Worktrees left by a jarvis-code that died mid-attempt (their directory names start with its pid). */
async function sweep(cwd: string, home: string): Promise<void> {
	for (const name of readdirSync(home)) {
		const pid = Number(name.split('-')[0]);
		if (pid && alive(pid)) continue;
		await git(cwd, ['worktree', 'remove', '--force', join(home, name)]);
		rmSync(join(home, name), { recursive: true, force: true });
	}
	await git(cwd, ['worktree', 'prune']);
}

export function openWorktree(cwd: string, links: string[]): Promise<Worktree | undefined> {
	return serial(() => open(cwd, links));
}

async function open(cwd: string, links: string[]): Promise<Worktree | undefined> {
	const base = await snapshot(cwd);
	const common = (await git(cwd, ['rev-parse', '--git-common-dir']))?.trim();
	if (!base || !common) return undefined;
	const head = (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']))?.trim();
	const commit = (await git(cwd, ['commit-tree', base, ...(head ? ['-p', head] : []), '-m', 'jarvis-code: worktree base'], IDENTITY))?.trim();
	if (!commit) return undefined;
	// Inside the repository's git directory: out of the working tree, and on its filesystem,
	// so dependency directories can be hard-linked rather than shared.
	const home = join(isAbsolute(common) ? common : join(cwd, common), 'jarvis-code-worktrees');
	mkdirSync(home, { recursive: true });
	await sweep(cwd, home);
	const dir = mkdtempSync(join(home, `${process.pid}-`));
	if ((await git(cwd, ['worktree', 'add', '--detach', '--quiet', dir, commit])) === undefined) {
		rmSync(dir, { recursive: true, force: true });
		return undefined;
	}
	// Dependencies are not in git. A hard-linked copy lets a worker delete or reinstall them
	// without touching yours; a symlink (shared) only where hard links are impossible.
	for (const name of links) {
		const from = join(cwd, name);
		const to = join(dir, name);
		if (!existsSync(from) || existsSync(to)) continue;
		if (!(await run('cp', ['-al', from, to]))) {
			rmSync(to, { recursive: true, force: true });
			symlinkSync(from, to);
		}
	}
	return {
		dir,
		base,
		remove: () =>
			serial(async () => {
				await git(cwd, ['worktree', 'remove', '--force', dir]);
				rmSync(dir, { recursive: true, force: true });
				await git(cwd, ['worktree', 'prune']);
			}),
	};
}

/** What the attempt changed in its worktree, as a patch (binary files included) against where it started. The dependency copies are ours, not the task's. */
export async function patchOf(wt: Worktree, links: string[]): Promise<string> {
	const after = await snapshot(wt.dir, links);
	return after ? changes(wt.dir, wt.base, after, Infinity, true) : '';
}

function apply(cwd: string, patch: string, reverse = false): Promise<string | undefined> {
	const dir = mkdtempSync(join(tmpdir(), 'jc-patch-'));
	const file = join(dir, 'task.patch');
	writeFileSync(file, patch);
	return new Promise((resolve) => {
		// No --index: the user's staging area is theirs. git apply is all or nothing.
		execFile('git', ['apply', '--whitespace=nowarn', ...(reverse ? ['-R'] : []), file], { cwd }, (err, _out, stderr) => {
			rmSync(dir, { recursive: true, force: true });
			resolve(err ? stderr.trim() || err.message : undefined);
		});
	});
}

/** Apply a task's patch to the main tree; the error when it does not apply cleanly. */
export const land = (cwd: string, patch: string) => apply(cwd, patch);
/** Take a landed patch back out (its checks failed once merged); the error when it can't be. */
export const unland = (cwd: string, patch: string) => apply(cwd, patch, true);

/**
 * Take a landed task back out: reverse-apply its newest passing attempt's kept patch to `cwd`
 * (all or nothing), then defer the task so no run redoes it by itself. Throws with why when
 * there is nothing to undo or the patch no longer reverses (a later change touched the lines).
 */
export async function undo(project: Project, cwd: string, id: string, teach: { learning?: Learning; intent?: (e: { kind: 'dropped'; text: string; project: string }) => void } = {}): Promise<string> {
	const t = project.get(id.toUpperCase());
	if (!t) throw new Error(`no task ${id}`);
	if (t.status === 'active') throw new Error(`${t.id} is being worked right now: stop the run first`);
	// A worker without a worktree edits this same tree: reversing a patch under it could tear both.
	if (project.running()) throw new Error('a run is going in this project: stop it first');
	const landed = t.attempts.findLast((a) => a.ok && a.patch);
	const file = landed?.patch;
	let patch = '';
	try {
		patch = file ? readFileSync(file, 'utf8') : '';
	} catch {
		/* the kept file is gone */
	}
	if (!patch.trim()) throw new Error(`no landed patch kept for ${t.id}: nothing to undo`);
	const err = await unland(cwd, patch);
	if (err) throw new Error(`could not take ${t.id}'s changes back out (nothing was changed): ${err.split('\n')[0]}`);
	project.setStatus(t.id, 'deferred', `undone: its changes were taken back out (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`);
	project.log({ event: 'undo', id: t.id, patch: file });
	// You took the work back: the route that did it is charged, overall and for this kind of task,
	// and the ask counts as turned down, so later plans and dispatch lean away from both.
	const route = landed!.route;
	if (teach.learning) {
		teach.learning.recordRoute(route, false);
		teach.learning.recordKind(route, t.type, false);
		teach.learning.save();
	}
	teach.intent?.({ kind: 'dropped', text: t.title, project: project.meta.name });
	return `took ${t.id}'s changes back out of ${basename(cwd)}; it is deferred (\`jarvis-code task retry ${t.id}\` redoes it)${teach.learning ? `; ${route} marked down for it` : ''}`;
}

/**
 * Take back every task the newest run still standing landed, newest first, so each patch
 * reverses onto the tree it left. Called again, it walks back one run at a time. Throws at the
 * first task that will not reverse, saying which came out: that one and older ones stay.
 */
export async function undoRun(project: Project, cwd: string, teach: Parameters<typeof undo>[3] = {}): Promise<string> {
	const standing = (id: string) => project.get(id)?.status === 'done';
	const run = project.history().find((r) => r.landed?.some(standing));
	if (!run) throw new Error('no run here has landed tasks still in the tree');
	const ids = run.landed!.filter(standing).reverse();
	const when = run.at.slice(0, 16).replace('T', ' ');
	const out: string[] = [];
	for (const id of ids) {
		try {
			await undo(project, cwd, id, teach);
		} catch (e) {
			const left = ids.slice(out.length);
			throw new Error(`${out.length ? `took ${out.join(', ')} back out, then ` : ''}stopped at ${id}: ${(e as Error).message}; ${left.join(', ')} ${left.length === 1 ? 'stays' : 'stay'} in the tree`);
		}
		out.push(id);
	}
	return `took the ${when} run's ${out.length} landed task${out.length === 1 ? '' : 's'} back out of ${basename(cwd)}, newest first: ${out.join(', ')}; each is deferred (\`jarvis-code task retry ID\` redoes one)`;
}
