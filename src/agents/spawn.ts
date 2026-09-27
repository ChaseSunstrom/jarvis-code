import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Emit, Outcome } from './types.js';

export interface Spawned {
	child: ChildProcess;
	/** Resolves once the process has exited and every stdout line was handled. */
	exited: Promise<{ code: number | null; stderr: string; timedOut: boolean }>;
	kill(): void;
}

/**
 * Run `bin args`, handing each stdout line to `onLine` (JSON-parsed when it parses).
 * stderr is kept (last 4 KB) for the error message; the process is killed after `timeoutMin`.
 */
export function run(
	bin: string,
	args: string[],
	opts: { cwd: string; env?: Record<string, string>; timeoutMin: number; stdin?: boolean },
	onLine: (value: unknown, raw: string) => void,
): Spawned {
	// A `.js`/`.mjs` agent runs under this Node, so scripts work without an exec bit or shebang.
	if (/\.m?js$/.test(bin)) [bin, args] = [process.execPath, [bin, ...args]];
	const child = spawn(bin, args, {
		cwd: opts.cwd,
		env: { ...process.env, ...opts.env },
		stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
	});
	let stderr = '';
	let timedOut = false;
	child.stderr!.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4096)));
	const lines = createInterface({ input: child.stdout! });
	lines.on('line', (raw) => {
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
	const exited = new Promise<{ code: number | null; stderr: string; timedOut: boolean }>((resolve) => {
		child.once('error', (e) => {
			clearTimeout(timer);
			resolve({ code: null, stderr: `${e.message}`, timedOut });
		});
		child.once('exit', async (code) => {
			clearTimeout(timer);
			await closed;
			resolve({ code, stderr, timedOut });
		});
	});
	return { child, exited, kill: () => child.kill('SIGTERM') };
}

/** The common tail: turn an exit into an Outcome when the agent never reported one. */
export function outcomeFromExit(
	x: { code: number | null; stderr: string; timedOut: boolean },
	final: Partial<Outcome>,
	emit: Emit,
): Outcome {
	const tail = x.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
	if (x.stderr.trim()) emit({ type: 'log', text: tail });
	const error = x.timedOut ? 'timed out' : x.code !== 0 ? final.error || tail || `exit ${x.code}` : final.error;
	return {
		summary: final.summary ?? '',
		costUsd: final.costUsd,
		model: final.model,
		...final,
		ok: !x.timedOut && x.code === 0 && final.ok !== false,
		error,
		exitCode: x.code,
	};
}
