import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { clean } from './agents/types.js';
import type { Task } from './tasks.js';

/** Characters of code a task's prompt may carry, by tier. */
const BUDGET: Record<string, number> = { S: 4000, M: 8000, L: 12000 };
/** Lines shown either side of a line ref, and from the top of a file named without one. */
const AROUND = 15;
/** Lines shown either side of a failing check's line ref. */
const FAILURE_AROUND = 10;
/** Lines shown either side of a backticked symbol's definition. */
const SYMBOL_AROUND = 8;
/** At most this many definition hits kept per backticked symbol. */
const SYMBOL_HITS = 3;
const HEAD = 40;
const TITLE = 'Files this task names (excerpts, as they are now):';
const CUT = '\n… (cut)';

// A path-like token with an optional line ref: `a/b.ts:12`, `a/b.ts:12-20` or tsc's `a/b.ts(12,5)`.
const TOKEN = /([\w./@+*-]+)(?::(\d+)(?:-(\d+))?|\((\d+),\d+\))?/g;
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|rb|php|sh|json|ya?ml|toml|md|css|scss|html|vue|svelte|sql)$/;
// Never read, even when a task names them: env files and keys.
const SECRET = /^(\.env.*|.*\.(pem|key)|id_.*)$/;

// A backticked `a.b.c` or `name()` token: no spaces or slashes (those are prose or paths, not symbols).
const SYMBOL = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;
const SHELL_WORDS = new Set(['npm', 'git', 'node', 'true', 'false', 'test', 'grep']);

/** Named paths in first-mention order, each with its line ranges (already widened). */
function mentions(task: Pick<Task, 'title' | 'steps' | 'acs' | 'brief' | 'files'>, cwd: string): Map<string, [number, number][]> {
	// The plan's declared files lead: they are what the task changes, whatever the text happens to mention first.
	const found = new Map<string, [number, number][]>((task.files ?? []).map((f) => [normalize(f), []]));
	const texts = [task.title, task.brief ?? '', ...task.steps, ...task.acs.map((a) => a.text), ...task.acs.map((a) => a.verify ?? '')];
	for (const text of texts)
		for (const m of text.matchAll(TOKEN)) {
			let path = m[1].replace(/\.+$/, '');
			if (path.includes('*') || !(path.includes('/') || SOURCE.test(path))) continue;
			// A verify command runs the build output; the worker edits the source.
			const dist = path.match(/^(?:\.\/)?dist\/((?:src|test)\/.+)\.js$/);
			const src = dist && ['.ts', '.tsx'].map((e) => dist[1] + e).find((f) => existsSync(resolve(cwd, f)));
			if (src) path = src;
			path = normalize(path);
			const refs = found.get(path) ?? [];
			const line = Number(m[2] ?? m[4]);
			if (line) refs.push([line - AROUND, Number(m[3] ?? line) + AROUND]);
			found.set(path, refs);
		}
	return found;
}

/** The last dotted segment of a backticked `a.b.c` or `name()` token, or undefined if it's not symbol-shaped. */
function symbolName(token: string): string | undefined {
	if (!SYMBOL.test(token)) return undefined;
	const last = token.replace(/\(\)$/, '').split('.').pop()!;
	return SHELL_WORDS.has(last) ? undefined : last;
}

/** Backticked symbol names from title, brief, steps and AC text, in first-mention order. */
function symbols(task: Pick<Task, 'title' | 'steps' | 'acs' | 'brief'>): string[] {
	const texts = [task.title, task.brief ?? '', ...task.steps, ...task.acs.map((a) => a.text)];
	const names: string[] = [];
	for (const text of texts)
		for (const m of text.matchAll(/`([^`]+)`/g)) {
			const name = symbolName(m[1]);
			if (name && !names.includes(name)) names.push(name);
		}
	return names;
}

/** Whether `line` looks like where `name` is defined, not just used. */
function looksLikeDef(name: string, line: string): boolean {
	const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const keyword = new RegExp(`^\\s*(export\\s+)?(default\\s+)?(async\\s+)?(function\\*?|class|interface|type|const|let|def|fn)\\s+${esc}\\b`);
	const method = new RegExp(`^\\s*${esc}\\s*\\(`);
	return keyword.test(line) || method.test(line);
}

/** Up to SYMBOL_HITS grep hits for `name`, definition-looking lines first. Empty outside a repo or with no hits. */
function symbolHits(cwd: string, name: string): { path: string; line: number }[] {
	let stdout: string;
	try {
		stdout = execFileSync('git', ['grep', '-n', '-w', '-I', name, '--', '.', ':!node_modules', ':!dist'], { cwd, timeout: 5000, encoding: 'utf8' });
	} catch {
		return [];
	}
	const hits = stdout
		.split('\n')
		.filter(Boolean)
		.map((l) => {
			const m = l.match(/^(.+?):(\d+):(.*)$/);
			return m && { path: m[1], line: Number(m[2]), content: m[3] };
		})
		.filter((h): h is { path: string; line: number; content: string } => !!h);
	hits.sort((a, b) => Number(looksLikeDef(name, b.content)) - Number(looksLikeDef(name, a.content)));
	return hits.slice(0, SYMBOL_HITS);
}

/** Excerpts (±SYMBOL_AROUND lines) around each backticked symbol's definition, grouped by file. */
function symbolExcerpts(cwd: string, root: string, names: string[]): string[] {
	const parts: string[] = [];
	for (const name of names) {
		const byPath = new Map<string, [number, number][]>();
		for (const { path, line } of symbolHits(cwd, name)) {
			const refs = byPath.get(path) ?? [];
			refs.push([line - SYMBOL_AROUND, line + SYMBOL_AROUND]);
			byPath.set(path, refs);
		}
		for (const [path, refs] of byPath) {
			const part = excerpt(cwd, root, path, refs);
			if (part) parts.push(part);
		}
	}
	return parts;
}

function inside(root: string, path: string): boolean {
	const r = relative(root, path);
	return !isAbsolute(r) && r.split(sep)[0] !== '..';
}

/** One file's excerpt, a note that it does not exist, or undefined for anything not to be read. */
function excerpt(cwd: string, root: string, path: string, refs: [number, number][]): string | undefined {
	const full = resolve(cwd, path);
	if (isAbsolute(path) || !inside(cwd, full) || SECRET.test(basename(path))) return undefined;
	// Only a file-like name counts as missing: `and/or` in a sentence is not a path.
	if (!existsSync(full)) return /\.\w+$/.test(basename(path)) ? `${path}: does not exist yet (the task may create it)` : undefined;
	let buf: Buffer;
	try {
		// A symlink can point anywhere: check where it lands, not what it is called.
		const real = realpathSync(full);
		if (!inside(root, real) || SECRET.test(basename(real)) || !statSync(real).isFile()) return undefined;
		buf = readFileSync(real);
	} catch {
		return undefined;
	}
	if (buf.subarray(0, 8192).includes(0)) return undefined;
	const lines = buf.toString('utf8').replace(/\n$/, '').split('\n');
	const ranges = refs.some(([a]) => a <= lines.length) ? refs : [[1, HEAD] as [number, number]];
	const width = String(lines.length).length;
	const out = [`${path} (${lines.length} lines):`];
	let last = 0;
	for (let n = 1; n <= lines.length; n++) {
		if (!ranges.some(([a, b]) => n >= a && n <= b)) continue;
		if (last && n > last + 1) out.push('…');
		out.push(`${String(n).padStart(width)}  ${lines[n - 1]}`);
		last = n;
	}
	return out.join('\n');
}

/**
 * Numbered excerpts of the files a task declares, then those it names (title, notes, steps, AC text and verify commands),
 * within its tier's budget, so a worker starts from the code instead of hunting for it.
 * The repository is not trusted text: nothing outside it, no secrets or binaries, and cleaned.
 * ponytail: whole-file sync reads; cap the read size if tasks start naming huge files.
 */
export function codeExcerpts(task: Pick<Task, 'title' | 'tier' | 'steps' | 'acs' | 'brief' | 'files'>, cwd: string): string {
	let root: string;
	try {
		root = realpathSync(cwd);
	} catch {
		return '';
	}
	const budget = BUDGET[task.tier] ?? BUDGET.S;
	const parts: string[] = [];
	for (const [path, refs] of mentions(task, cwd)) {
		const part = excerpt(cwd, root, path, refs);
		if (part) parts.push(part);
	}
	parts.push(...symbolExcerpts(cwd, root, symbols(task)));
	let out = TITLE;
	for (const part of parts) {
		const next = `${out}\n\n${clean(part)}`;
		if (next.length <= budget) {
			out = next;
			continue;
		}
		out = next.slice(0, next.lastIndexOf('\n', budget - CUT.length)) + CUT;
		break;
	}
	return out === TITLE ? '' : out;
}

// tsc's `path(line,col)`.
const FAILURE_PAREN = /([\w./@+-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs))\((\d+),\d+\)/g;
// `path:line:col`: a plain relative ref, a stack frame's `(/abs/path:line:col)`, or a `file:///abs/path:line:col` URL.
const FAILURE_COLON = /(?:file:\/\/)?(\/?[\w./@+-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)):(\d+)(?::\d+)?/g;

/** path, line refs a failing check printed, in first-mention order. */
function failureRefs(output: string): { path: string; line: number }[] {
	const refs: { path: string; line: number }[] = [];
	for (const re of [FAILURE_PAREN, FAILURE_COLON]) for (const m of output.matchAll(re)) refs.push({ path: m[1], line: Number(m[2]) });
	return refs;
}

/**
 * Numbered excerpts (±FAILURE_AROUND lines) of the files a failing check's output named, so a
 * retry starts at the broken lines instead of re-finding them: tsc's `path(L,C)`, `path:L:C`,
 * a stack frame's `(/abs/path:L:C)`, and `file:///abs/path:L:C` refs, dropping anything outside
 * cwd. A dist/*.js ref names its .ts source instead, since the build erases lines don't survive
 * (types are stripped, not just transpiled): excerpting the built file's line would show the
 * wrong code, so this shows the top of the source file instead.
 */
export function failureExcerpts(output: string, cwd: string, budget = 3000): string {
	let root: string;
	try {
		root = realpathSync(cwd);
	} catch {
		return '';
	}
	const byPath = new Map<string, [number, number][]>();
	for (const { path: raw, line } of failureRefs(output)) {
		const path = isAbsolute(raw) ? relative(cwd, raw) : raw;
		if (isAbsolute(path) || path.split(sep)[0] === '..') continue;
		const dist = path.match(/^(?:\.\/)?dist\/((?:src|test)\/.+)\.js$/);
		const src = dist && ['.ts', '.tsx'].map((e) => dist[1] + e).find((f) => existsSync(resolve(cwd, f)));
		const key = normalize(src ?? path);
		const refs = byPath.get(key) ?? [];
		// A dist ref's line is the built file's, not the source's: name the file, don't excerpt by it.
		if (!src) refs.push([line - FAILURE_AROUND, line + FAILURE_AROUND]);
		byPath.set(key, refs);
	}
	let out = '';
	for (const [path, refs] of byPath) {
		const part = excerpt(cwd, root, path, refs);
		if (!part) continue;
		const next = out ? `${out}\n\n${clean(part)}` : clean(part);
		if (next.length <= budget) {
			out = next;
			continue;
		}
		return next.slice(0, next.lastIndexOf('\n', budget - CUT.length)) + CUT;
	}
	return out;
}
