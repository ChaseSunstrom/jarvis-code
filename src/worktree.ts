import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { changes, git, snapshot } from './review.js';

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
