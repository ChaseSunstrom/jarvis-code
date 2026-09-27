import type { Config } from '../config.js';
import type { Activity, ActivityKind, TaskStatus } from '../orchestrator.js';
import type { palette } from '../theme.js';

type Tone = keyof typeof palette;

export const KIND: Record<ActivityKind, [icon: string, tone: Tone]> = {
	plan: ['◆', 'accentLift'], start: ['▸', 'accent'], done: ['✓', 'ok'], fail: ['✗', 'danger'],
	block: ['⊘', 'warn'], review: ['◇', 'warn'], model: ['⇅', 'warming'], learn: ['⚑', 'warn'],
	info: ['·', 'textDim'], error: ['✗', 'danger'], tool: ['›', 'textFaint'], text: ['“', 'textDim'], change: ['±', 'accentDeep'],
};

export const STATUS: Record<TaskStatus, [icon: string, tone: Tone]> = {
	queued: ['·', 'textFaint'], running: ['◠', 'accent'], verifying: ['◎', 'accentLift'], done: ['✓', 'ok'],
	failed: ['✗', 'danger'], blocked: ['⊘', 'warn'], review: ['◇', 'warn'],
};

/** Queue order on screen: what is moving, then what needs a human, then what waits, then history. */
export const ORDER: TaskStatus[] = ['running', 'verifying', 'blocked', 'review', 'failed', 'queued', 'done'];

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
	learning: boolean;
}

/** Completions, failures, model switches and learning always show; detail only when asked for. */
export function visible(a: Activity, v: Pick<View, 'showDiffs' | 'showTools' | 'showText'>): boolean {
	if (a.kind === 'change') return v.showDiffs;
	if (a.kind === 'tool') return v.showTools;
	if (a.kind === 'text') return v.showText;
	return true;
}
