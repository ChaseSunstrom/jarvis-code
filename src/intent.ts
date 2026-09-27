/**
 * Intent memory: one append-only JSONL file, across projects, of what the user asked for and
 * turned down. Only the user's own words and decisions go in, never agent text, so no repository
 * can write into every later project's prompts. It is summarised when read: no schema, no migration.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { paths } from './config.js';

export type IntentKind = 'asked' | 'accepted' | 'dropped';
export interface Intent {
	at: string;
	kind: IntentKind;
	text: string;
	project: string;
}

const KINDS: IntentKind[] = ['asked', 'accepted', 'dropped'];
/** Past TRIM_AT lines the file is rewritten to the newest KEEP. */
const TRIM_AT = 600;
const KEEP = 500;
const CAP = 300;

export const intentFile = () => join(paths.stateDir(), 'intent.jsonl');

// API keys by prefix, then any 32+ char run of word characters with a digit in it (hex, base64-ish tokens).
const SECRET = /\b(?:sk-[\w-]{16,}|gh[pousr]_\w{20,}|xox[a-z]-[\w-]{10,}|AKIA[0-9A-Z]{16})|\b(?=[\w-]*\d)[\w-]{32,}/g;

/** Secrets out, the home dir as ~, one line, at most CAP chars. */
export function redact(s: string): string {
	const home = homedir();
	if (home.length > 1) s = s.replace(new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w.-])', 'g'), '~');
	return s.replace(SECRET, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, CAP);
}

export function recordIntent(e: { kind: IntentKind; text: string; project: string }): void {
	const entry: Intent = { at: new Date().toISOString(), kind: e.kind, text: redact(e.text), project: redact(e.project) };
	if (!entry.text) return;
	const f = intentFile();
	mkdirSync(paths.stateDir(), { recursive: true });
	appendFileSync(f, JSON.stringify(entry) + '\n');
	const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
	if (lines.length <= TRIM_AT) return;
	const tmp = `${f}.${process.pid}.tmp`;
	writeFileSync(tmp, lines.slice(-KEEP).join('\n') + '\n');
	renameSync(tmp, f);
}

/** Every well-formed entry, oldest first; bad lines are skipped. */
export function readIntent(): Intent[] {
	let raw: string;
	try {
		raw = readFileSync(intentFile(), 'utf8');
	} catch {
		return [];
	}
	return raw.split('\n').flatMap((l) => {
		try {
			const e = JSON.parse(l);
			return KINDS.includes(e?.kind) && typeof e.text === 'string' && typeof e.project === 'string' ? [e as Intent] : [];
		} catch {
			return [];
		}
	});
}

/** Recent distinct asks and drops, newest first, at most 3 lines per project, within `max` chars ('' when none). */
export function intentSummary(max = 1200): string {
	const out: string[] = [];
	const seen = new Set<string>();
	const perProject = new Map<string, number>();
	let len = 0;
	for (const e of readIntent().reverse()) {
		if (e.kind === 'accepted') continue;
		const key = `${e.kind} ${e.text.toLowerCase()}`;
		const n = perProject.get(e.project) ?? 0;
		if (seen.has(key) || n >= 3) continue;
		const line = `- ${e.project}: ${e.kind === 'asked' ? 'asked for' : 'turned down'} ${e.text}`;
		if (len + line.length + (out.length ? 1 : 0) > max) continue;
		seen.add(key);
		perProject.set(e.project, n + 1);
		len += line.length + (out.length ? 1 : 0);
		out.push(line);
	}
	return out.join('\n');
}

export function resetIntent(): void {
	if (existsSync(intentFile())) writeFileSync(intentFile(), '');
}
