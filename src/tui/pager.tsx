import { Box, Text } from 'ink';
import { useMemo } from 'react';
import { c } from '../theme.js';
import { Label } from './parts.js';

/** Lines a pager keeps; past this it stops with a count, so a huge patch stays cheap to scroll. */
export const PAGER_MAX = 5000;

/** Plain text as coloured pager lines: diff markers coloured, binary sections folded to [binary], capped at PAGER_MAX. */
export function pageLines(text: string): { text: string; color: string }[] {
	const out: { text: string; color: string }[] = [];
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

/** `height` lines of `text` from line `top`; with a `title`, a label row above names it and where you are. */
export function Pager({ text, height, top, title }: { text: string; height: number; top: number; title?: string }) {
	// The cockpit renders at its fps while animating: split the text once, not every frame.
	const lines = useMemo(() => pageLines(text), [text]);
	const from = Math.max(0, Math.min(top, lines.length - height));
	const shown = lines.slice(from, from + Math.max(1, height));
	return (
		<Box flexDirection="column" width="100%">
			{title !== undefined && <Label text={title} right={`${from + 1}–${from + shown.length} of ${lines.length} · PgUp/PgDn · Esc to close`} />}
			{shown.map((l, i) => (
				<Box key={from + i} flexShrink={0}>
					<Text color={l.color} wrap="truncate-end">
						{l.text || ' '}
					</Text>
				</Box>
			))}
		</Box>
	);
}
