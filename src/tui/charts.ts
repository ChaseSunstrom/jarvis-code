/**
 * Text charts for the cockpit's panes: pure strings, one column per glyph, coloured by the caller
 * from the theme. Block elements draw the same in any font that draws the reactor.
 */

const TICKS = '▁▂▃▄▅▆▇█';
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

/** The newest `width` values as one row of ticks, scaled so the largest (or `top`, for a fixed scale such as a rate) is a full block. */
export function sparkline(values: number[], width: number, top?: number): string {
	const shown = width > 0 ? values.slice(-width) : [];
	const max = top ?? Math.max(0, ...shown);
	return shown.map((v) => TICKS[max > 0 ? Math.round((Math.max(0, v) / max) * (TICKS.length - 1)) : 0]).join('');
}

/** `value` of `max` as a bar up to `width` cells, to an eighth of a cell; any value above 0 shows. */
export function bar(value: number, max: number, width: number): string {
	if (!(max > 0) || !(value > 0) || width <= 0) return '';
	const eighths = Math.max(1, Math.round((Math.min(value, max) / max) * width * 8));
	return '█'.repeat(Math.floor(eighths / 8)) + EIGHTHS[eighths % 8];
}

/**
 * Cells for each count of a stacked bar `width` wide: proportional, largest remainder first, and
 * every non-zero count gets at least one cell while there are cells to give.
 */
export function split(counts: number[], width: number): number[] {
	const total = counts.reduce((a, b) => a + Math.max(0, b), 0);
	const out = counts.map(() => 0);
	if (!total || width <= 0) return out;
	const live = counts.map((n, i) => ({ i, n: Math.max(0, n) })).filter((x) => x.n > 0);
	// The floor first gives each live count a cell, largest first, while cells last.
	let left = width;
	for (const x of [...live].sort((a, b) => b.n - a.n)) if (left > 0) (out[x.i] = 1), left--;
	const rest = live.map((x) => ({ ...x, exact: (x.n / total) * width - out[x.i] })).filter((x) => x.exact > 0);
	for (const x of rest) {
		const whole = Math.min(left, Math.floor(x.exact));
		out[x.i] += whole;
		left -= whole;
	}
	for (const x of rest.sort((a, b) => (b.exact % 1) - (a.exact % 1))) if (left > 0) out[x.i]++, left--;
	return out;
}

/** How many of `times` fall in each of `n` equal slots from `from` to `to` (the last slot closed); with `weights`, their sum. */
export function bins(times: number[], from: number, to: number, n: number, weights?: number[]): number[] {
	const out = Array<number>(Math.max(0, n)).fill(0);
	if (!n) return out;
	const span = to - from;
	times.forEach((t, i) => {
		if (t < from || t > to) return;
		out[span > 0 ? Math.min(n - 1, Math.floor(((t - from) / span) * n)) : n - 1] += weights ? weights[i] : 1;
	});
	return out;
}
