import { Box, Text } from 'ink';
import { useMemo } from 'react';
import { c } from '../theme.js';
import { Label } from './parts.js';

/** Lines a pager keeps; past this it stops with a count, so a huge patch stays cheap to scroll. */
export const PAGER_MAX = 5000;

/** A pager line: one colour, or coloured parts that make up `text`. */
export interface PagerLine {
	text: string;
	color: string;
	parts?: { text: string; color: string }[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What a patch changes, as `git diff --stat` shows it: a row per file (its path, lines changed
 * and a bar of + and - in proportion, scaled to `width` for the largest), a total, and a blank
 * row; nothing when the text holds no `diff --git` header.
 */
export function diffstat(text: string, width = 30): PagerLine[] {
	const files: { path: string; add: number; del: number; binary: boolean }[] = [];
	let hunk = false;
	for (const l of text.split('\n')) {
		const head = l.match(/^diff --git a\/.* b\/(.*)$/);
		if (head) {
			files.push({ path: head[1], add: 0, del: 0, binary: false });
			hunk = false;
			continue;
		}
		const f = files.at(-1);
		if (!f) continue;
		if (l === 'GIT binary patch' || /^Binary files .* differ$/.test(l)) f.binary = true;
		else if (l.startsWith('@@')) hunk = true;
		else if (hunk && l.startsWith('+')) f.add++;
		else if (hunk && l.startsWith('-')) f.del++;
	}
	if (!files.length) return [];
	const max = Math.max(...files.map((f) => f.add + f.del));
	const nameW = Math.min(40, Math.max(...files.map((f) => f.path.length)));
	const numW = String(max).length;
	const rows = files.map((f): PagerLine => {
		const path = (f.path.length > nameW ? `…${f.path.slice(-(nameW - 1))}` : f.path).padEnd(nameW);
		if (f.binary) return { text: ` ${path} | bin`, color: c.textDim, parts: [{ text: ` ${path}`, color: c.text }, { text: ' | ', color: c.tick }, { text: 'bin', color: c.textDim }] };
		const n = f.add + f.del;
		const cells = max <= width ? n : Math.max(n ? 1 : 0, Math.round((n / max) * width));
		const plus = n ? Math.round((cells * f.add) / n) : 0;
		const parts = [
			{ text: ` ${path}`, color: c.text },
			{ text: ' | ', color: c.tick },
			{ text: `${String(n).padStart(numW)} `, color: c.textDim },
			{ text: '+'.repeat(plus), color: c.ok },
			{ text: '-'.repeat(cells - plus), color: c.danger },
		];
		return { text: parts.map((p) => p.text).join(''), color: c.text, parts };
	});
	const add = files.reduce((s, f) => s + f.add, 0);
	const del = files.reduce((s, f) => s + f.del, 0);
	return [...rows, { text: ` ${plural(files.length, 'file')} changed, ${plural(add, 'insertion')}(+), ${plural(del, 'deletion')}(-)`, color: c.textDim }, { text: '', color: c.text }];
}

/** Plain text as coloured pager lines: diff markers coloured, binary sections folded to [binary], capped at PAGER_MAX. */
export function pageLines(text: string): PagerLine[] {
	const out: PagerLine[] = [];
	// Between `diff --git` and the first `@@` every line is file header, so a removed "-- x" line is never mistaken for one.
	let head = false;
	let binary = false;
	for (const raw of text.replace(/\n+$/, '').split('\n')) {
		// Tabs and control characters would move the terminal's cursor under ink's feet.
		const l = raw.replace(/\t/g, '  ').replace(/[\x00-\x1f\x7f]/g, '');
		if (l.startsWith('diff --git ')) [head, binary] = [true, false];
		else if (binary) continue;
		if (l === 'GIT binary patch' || /^Binary files .* differ$/.test(l)) {
			binary = l === 'GIT binary patch';
			out.push({ text: '[binary]', color: c.textFaint });
			continue;
		}
		if (l.startsWith('@@')) head = false;
		const color = head || l.startsWith('@@') ? c.accent : l.startsWith('+') ? c.ok : l.startsWith('-') ? c.danger : c.text;
		out.push({ text: l, color });
	}
	if (out.length <= PAGER_MAX) return out;
	return [...out.slice(0, PAGER_MAX), { text: `… ${out.length - PAGER_MAX} more lines`, color: c.textFaint }];
}

/** Prose wrapped at word boundaries to `width` columns; long words are cut. Blank lines stay. */
export function wrapText(text: string, width: number): string {
	const w = Math.max(10, width);
	return text
		.split('\n')
		.flatMap((line) => {
			const out: string[] = [];
			let cur = '';
			for (const word of line.split(/\s+/).filter(Boolean)) {
				for (let rest = word; rest; ) {
					if (!cur) {
						cur = rest.slice(0, w);
						rest = rest.slice(w);
					} else if (cur.length + 1 + rest.length <= w) {
						cur += ` ${rest}`;
						rest = '';
					} else {
						out.push(cur);
						cur = '';
					}
				}
			}
			return [...out, cur];
		})
		.join('\n');
}

/** A patch in one line: its diffstat total and the files it touched, e.g. `2 files changed, 3 insertions(+), 1 deletion(-): a.ts, b.ts`. */
export function patchSummary(text: string): string | undefined {
	const stat = diffstat(text);
	if (!stat.length) return undefined;
	const files = stat.slice(0, -2).map((l) => (l.parts?.[0].text ?? l.text).trim().split(' | ')[0].trim());
	return `${stat.at(-2)!.text.trim()}: ${files.join(', ')}`;
}

/** How many lines the pager shows for `text`: its diffstat and patch, or its prose lines. */
export const pagerLength = (text: string, plain?: boolean) => (plain ? text.split('\n').length : diffstat(text).length + pageLines(text).length);

/** `height` lines of `text` from line `top`; with a `title`, a label row above names it and where you are. `plain`: prose, not a patch. */
export function Pager({ text, height, top, title, plain }: { text: string; height: number; top: number; title?: string; plain?: boolean }) {
	// The cockpit renders at its fps while animating: split the text once, not every frame.
	const lines = useMemo(() => (plain ? text.split('\n').map((l): PagerLine => ({ text: l.replace(/[\x00-\x1f\x7f]/g, ''), color: c.text })) : [...diffstat(text), ...pageLines(text)]), [text, plain]);
	const from = Math.max(0, Math.min(top, lines.length - height));
	const shown = lines.slice(from, from + Math.max(1, height));
	return (
		<Box flexDirection="column" width="100%">
			{title !== undefined && <Label text={title} right={`${from + 1}–${from + shown.length} of ${lines.length} · PgUp/PgDn · Esc to close`} />}
			{shown.map((l, i) => (
				<Box key={from + i} flexShrink={0}>
					<Text color={l.color} wrap="truncate-end">
						{l.parts ? l.parts.map((p, k) => <Text key={k} color={p.color}>{p.text}</Text>) : l.text || ' '}
					</Text>
				</Box>
			))}
		</Box>
	);
}
