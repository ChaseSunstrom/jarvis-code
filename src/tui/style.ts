import type { Config } from '../config.js';
import type { Activity, ActivityKind, TaskStatus } from '../orchestrator.js';
import type { palette } from '../theme.js';

type Tone = keyof typeof palette;

type Marks<K extends string> = Record<K, [mark: string, tone: Tone]>;
type Icons = Config['ui']['icons'];

const KIND_TEXT: Marks<ActivityKind> = {
	plan: ['plan', 'accentLift'], start: ['run', 'accent'], done: ['done', 'ok'], fail: ['fail', 'danger'],
	block: ['block', 'warn'], review: ['review', 'warn'], model: ['model', 'warming'], learn: ['learn', 'warn'],
	info: ['info', 'textDim'], error: ['error', 'danger'], tool: ['tool', 'textFaint'], text: ['say', 'textDim'], change: ['diff', 'accentDeep'],
};

const KIND_GLYPH: Marks<ActivityKind> = {
	plan: ['◆', 'accentLift'], start: ['▸', 'accent'], done: ['✓', 'ok'], fail: ['✗', 'danger'],
	block: ['⊘', 'warn'], review: ['◇', 'warn'], model: ['⇅', 'warming'], learn: ['!', 'warn'],
	info: ['·', 'textDim'], error: ['✗', 'danger'], tool: ['›', 'textFaint'], text: ['"', 'textDim'], change: ['±', 'accentDeep'],
};

const STATUS_TEXT: Marks<TaskStatus> = {
	queued: ['queued', 'textFaint'], running: ['run', 'accent'], verifying: ['verify', 'accentLift'], done: ['done', 'ok'],
	failed: ['fail', 'danger'], blocked: ['block', 'warn'], review: ['review', 'warn'], split: ['split', 'textDim'],
};

const STATUS_GLYPH: Marks<TaskStatus> = {
	queued: ['·', 'textFaint'], running: ['◠', 'accent'], verifying: ['◎', 'accentLift'], done: ['✓', 'ok'],
	failed: ['✗', 'danger'], blocked: ['⊘', 'warn'], review: ['◇', 'warn'], split: ['↳', 'textDim'],
};

/** Done items as the coverage check found them; words only, whatever ui.icons says. */
const CLAUSE_TEXT: Marks<'open' | 'met' | 'unmet'> = { open: ['open', 'textFaint'], met: ['met', 'ok'], unmet: ['unmet', 'warn'] };

export const MARKS = { KIND_TEXT, KIND_GLYPH, STATUS_TEXT, STATUS_GLYPH, CLAUSE_TEXT };

/** A text tag padded to its table's widest, so the columns after it line up. */
function mark<K extends string>(text: Marks<K>, glyph: Marks<K>, key: K, icons: Icons): [mark: string, tone: Tone] {
	if (icons === 'glyph') return glyph[key];
	const width = Math.max(...Object.values<[string, Tone]>(text).map(([m]) => m.length));
	return [text[key][0].padEnd(width), text[key][1]];
}

export const kindMark = (kind: ActivityKind, icons: Icons) => mark(KIND_TEXT, KIND_GLYPH, kind, icons);
export const statusMark = (status: TaskStatus, icons: Icons) => mark(STATUS_TEXT, STATUS_GLYPH, status, icons);
export const clauseMark = (state: keyof typeof CLAUSE_TEXT) => mark(CLAUSE_TEXT, CLAUSE_TEXT, state, 'text');

/** Queue order on screen: what is moving, then what needs a human, then what waits, then history. */
export const ORDER: TaskStatus[] = ['running', 'verifying', 'blocked', 'review', 'failed', 'queued', 'done', 'split'];

/** The HUD's label style: uppercase, tracked. */
export const cap = (s: string) => s.toUpperCase().split('').join(' ');

export function elapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export const clock = (at: number) => new Date(at).toTimeString().slice(0, 8);

export interface View {
	showDiffs: boolean;
	showTools: boolean;
	showText: boolean;
	reactor: Config['ui']['reactor'];
	icons: Icons;
	learning: boolean;
}

/** Completions, failures, model switches and learning always show; detail only when asked for. */
export function visible(a: Activity, v: Pick<View, 'showDiffs' | 'showTools' | 'showText'>): boolean {
	if (a.kind === 'change') return v.showDiffs;
	if (a.kind === 'tool') return v.showTools;
	if (a.kind === 'text') return v.showText;
	return true;
}
