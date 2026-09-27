import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Emit, Outcome } from './types.js';

export interface Spawned {
	child: ChildProcess;
	/** Resolves once the process has exited and every stdout line was handled. */
	exited: Promise<Exit>;
	kill(): void;
}

/** Every agent process still running: none may outlive jarvis-code, even on a crash. */
const live = new Set<ChildProcess>();
let reaping = false;
function reapOnExit() {
	if (reaping) return;
	reaping = true;
	// 'exit' runs for normal exits and uncaught errors; signals end the process without it,
	// so they are turned into an exit here (after the CLI's own handlers had their turn).
	process.on('exit', () => {
		for (const c of live) c.kill('SIGTERM');
	});
	for (const sig of ['SIGTERM', 'SIGHUP'] as const)
		process.on(sig, () => {
			if (process.listenerCount(sig) === 1) process.exit(128 + (sig === 'SIGTERM' ? 15 : 1));
		});
}

export interface Exit {
	code: number | null;
	stderr: string;
	timedOut: boolean;
	/** Killed by the idle watchdog after this many minutes without a line. */
	idle?: number;
}

/**
 * Run `bin args`, handing each stdout line to `onLine` (JSON-parsed when it parses).
 * stderr is kept (last 4 KB) for the error message; the process is killed after `timeoutMin`.
 */
export function run(
	bin: string,
	args: string[],
	opts: { cwd: string; env?: Record<string, string>; timeoutMin: number; idleMin?: number; stdin?: boolean },
	onLine: (value: unknown, raw: string) => void,
): Spawned {
	// A `.js`/`.mjs` agent runs under this Node, so scripts work without an exec bit or shebang.
	if (/\.m?js$/.test(bin)) [bin, args] = [process.execPath, [bin, ...args]];
	const child = spawn(bin, args, {
		cwd: opts.cwd,
		env: { ...process.env, ...opts.env },
		stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
	});
	reapOnExit();
	live.add(child);
	child.once('exit', () => live.delete(child));
	let stderr = '';
	let timedOut = false;
	let idle: number | undefined;
	// The watchdog: every stdout line resets it; a worker hung on the network or on stdin
	// otherwise holds its slot until the whole-run timeout, an hour later.
	let idleTimer: NodeJS.Timeout | undefined;
	const pet = () => {
		if (!opts.idleMin) return;
		clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			idle = opts.idleMin;
			child.kill('SIGTERM');
		}, opts.idleMin * 60_000);
		idleTimer.unref();
	};
	pet();
	child.stderr!.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4096)));
	const lines = createInterface({ input: child.stdout! });
	lines.on('line', (raw) => {
		pet();
		let value: unknown = raw;
		if (raw.startsWith('{')) {
			try {
				value = JSON.parse(raw);
			} catch {
				/* a non-JSON line is passed through as text */
			}
		}
		onLine(value, raw);
	});
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill('SIGTERM');
	}, opts.timeoutMin * 60_000);
	timer.unref();
	const closed = new Promise<void>((r) => lines.once('close', r));
	const exited = new Promise<Exit>((resolve) => {
		child.once('error', (e) => {
			clearTimeout(timer);
			clearTimeout(idleTimer);
			resolve({ code: null, stderr: `${e.message}`, timedOut });
		});
		child.once('exit', async (code) => {
			clearTimeout(timer);
			clearTimeout(idleTimer);
			await closed;
			resolve({ code, stderr, timedOut, idle });
		});
	});
	return { child, exited, kill: () => child.kill('SIGTERM') };
}

/** The common tail: turn an exit into an Outcome when the agent never reported one. */
export function outcomeFromExit(
	x: Exit,
	final: Partial<Outcome>,
	emit: Emit,
): Outcome {
	const tail = x.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
	if (x.stderr.trim()) emit({ type: 'log', text: tail });
	const error = x.idle
		? `no output for ${x.idle} min: killed as hung`
		: x.timedOut
			? 'timed out'
			: x.code !== 0
				? final.error || tail || `exit ${x.code}`
				: final.error;
	return {
		summary: final.summary ?? '',
		costUsd: final.costUsd,
		model: final.model,
		...final,
		ok: !x.timedOut && !x.idle && x.code === 0 && final.ok !== false,
		error,
		exitCode: x.code,
	};
}
