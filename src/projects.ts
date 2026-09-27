import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { clean } from './agents/types.js';
import { basename, dirname, join, resolve } from 'node:path';
import { paths } from './config.js';
import { listStored, Project as Store, type RunInfo, type StoredTask } from './store.js';

export interface Project {
	name: string;
	path: string;
	/** jarvis-code has task state for it. */
	known: boolean;
	lastActive?: string;
}

/** A project's queue as the cockpit shows it, read straight from the store. */
export interface ProjectState {
	active?: StoredTask;
	queue: StoredTask[];
	blocked: StoredTask[];
	review: StoredTask[];
	/** Kept for later: follow-ups workers found, tasks put aside. */
	deferred: StoredTask[];
	done: number;
	/** A run holding the project from another process (a background run, the CLI, another cockpit). */
	running?: RunInfo;
	/** The last lines of a background run's log. */
	logTail?: string[];
	checked: number;
	/** Lifetime spend across every attempt ever recorded for this project. */
	spent: number;
}

const recentFile = () => join(paths.stateDir(), 'recent.json');

export function recentDirs(): string[] {
	try {
		const list = JSON.parse(readFileSync(recentFile(), 'utf8'));
		return Array.isArray(list) ? list.filter((d) => typeof d === 'string') : [];
	} catch {
		return [];
	}
}

/** Remember `dir` as used: newest first, at most 30. */
export function addRecent(dir: string): void {
	const abs = resolve(dir);
	const list = [abs, ...recentDirs().filter((d) => d !== abs)].slice(0, 30);
	mkdirSync(dirname(recentFile()), { recursive: true });
	const tmp = `${recentFile()}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(list, null, 2));
	renameSync(tmp, recentFile());
}

/**
 * Every project the cockpit knows: directories jarvis-code was used in and every project
 * it has task state for, one entry per path. Recent directories first, then by activity.
 */
export function listProjects(): Project[] {
	const stored = new Map(listStored().map((m) => [m.path, m]));
	const recent = recentDirs();
	const out: Project[] = recent.map((dir) => ({ name: basename(dir), path: dir, known: stored.has(dir), lastActive: stored.get(dir)?.lastActive }));
	for (const m of stored.values()) if (!recent.includes(m.path)) out.push({ name: m.name, path: m.path, known: true, lastActive: m.lastActive });
	return out;
}

/** The last `n` lines of a file, read from its end; empty when it can't be read. */
function tail(file: string, n: number): string[] {
	try {
		const fd = openSync(file, 'r');
		try {
			const size = fstatSync(fd).size;
			const buf = Buffer.alloc(Math.min(size, 4096));
			readSync(fd, buf, 0, buf.length, size - buf.length);
			return clean(buf.toString('utf8')).split('\n').filter((l) => l.trim()).slice(-n);
		} finally {
			closeSync(fd);
		}
	} catch {
		return [];
	}
}

export function projectState(path: string): ProjectState | undefined {
	const store = Store.open(path);
	if (!store) return undefined;
	const tasks = store.tasks();
	const queue = store.queue();
	const running = store.running();
	return {
		active: queue.find((t) => t.status === 'active'),
		queue,
		blocked: tasks.filter((t) => t.status === 'blocked'),
		review: tasks.filter((t) => t.status === 'review'),
		deferred: tasks.filter((t) => t.status === 'deferred'),
		done: tasks.filter((t) => t.status === 'done').length,
		running,
		logTail: running?.log ? tail(running.log, 3) : undefined,
		checked: Date.now(),
		spent: store.spent(),
	};
}

/** Project states re-read at most every `ttlMs`: the cockpit renders several times a second. */
export class StateCache {
	private states = new Map<string, ProjectState | undefined>();
	private at = new Map<string, number>();
	constructor(private ttlMs = 2000) {}

	get(path: string): ProjectState | undefined {
		if (Date.now() - (this.at.get(path) ?? 0) > this.ttlMs) {
			this.states.set(path, projectState(path));
			this.at.set(path, Date.now());
		}
		return this.states.get(path);
	}

	invalidate(path: string): void {
		this.at.delete(path);
	}
}
