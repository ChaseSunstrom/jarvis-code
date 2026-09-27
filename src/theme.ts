/**
 * The Jarvis console palette: `(hex, xterm-256, ansi-16)` per token, re-typed from the
 * Jarvis design system's console theme so the terminal degrades the way the desktop
 * console does. Ink text takes the hex (chalk degrades it); the reactor paints its own
 * escapes through `sgr` because it mixes colours per frame.
 */
export type Swatch = readonly [hex: string, x256: number, a16: number];

export const palette = {
	bg: ['#03070b', 232, 0],
	accent: ['#4fe3ff', 81, 14],
	accentDeep: ['#1fa9c9', 38, 6],
	accentLift: ['#7ee6ff', 117, 7],
	warn: ['#f2b84b', 215, 3],
	warming: ['#ff9e2c', 214, 3],
	danger: ['#ff6b5c', 203, 8],
	dangerText: ['#ff9184', 210, 8],
	ok: ['#6ff2c0', 85, 6],
	text: ['#d3e6ec', 254, 7],
	textBright: ['#f1fafc', 231, 15],
	textDim: ['#7c9ea9', 109, 8],
	textFaint: ['#6f8d99', 66, 8],
	tick: ['#455f68', 240, 8],
	line: ['#16323f', 236, 0],
	lineSoft: ['#0f2430', 234, 0],
	housing: ['#01030a', 232, 0],
	kill: ['#e0344b', 167, 1],
} as const satisfies Record<string, Swatch>;

/** Hex colours for Ink `<Text color>`. */
export const c = Object.fromEntries(Object.entries(palette).map(([k, v]) => [k, v[0]])) as {
	[K in keyof typeof palette]: string;
};

export type ColorDepth = 'truecolor' | '256' | '16' | 'none';

/** The theme's degrade ladder: NO_COLOR, then COLORTERM, then TERM. */
export function colorDepth(env: NodeJS.ProcessEnv = process.env, isTTY = true): ColorDepth {
	if (env.NO_COLOR || env.TERM === 'dumb' || (!isTTY && !env.FORCE_COLOR)) return 'none';
	if (/truecolor|24bit/i.test(env.COLORTERM || '')) return 'truecolor';
	if (/256/.test(env.TERM || '')) return '256';
	return env.TERM || env.FORCE_COLOR ? '16' : 'none';
}

export type RGB = readonly [number, number, number];

export const rgb = (hex: string): RGB => [
	parseInt(hex.slice(1, 3), 16),
	parseInt(hex.slice(3, 5), 16),
	parseInt(hex.slice(5, 7), 16),
];

export const mix = (a: RGB, b: RGB, k: number): RGB => [
	Math.round(a[0] + (b[0] - a[0]) * k),
	Math.round(a[1] + (b[1] - a[1]) * k),
	Math.round(a[2] + (b[2] - a[2]) * k),
];

export const RESET = '\x1b[0m';

/**
 * The escape that paints `swatch` at `lum` (0–1). Truecolor scales toward the housing
 * (the reactor dims, it does not grey); 256/16 cannot, so they use SGR dim below 0.7.
 */
export function sgr(swatch: Swatch, lum: number, depth: ColorDepth, bold = false): string {
	if (depth === 'none') return '';
	const parts: string[] = [];
	if (depth === 'truecolor') {
		const [r, g, b] = mix(rgb(palette.housing[0]), rgb(swatch[0]), Math.max(0, Math.min(1, lum)));
		parts.push(`38;2;${r};${g};${b}`);
	} else if (depth === '256') parts.push(`38;5;${swatch[1]}`);
	else parts.push(String(swatch[2] >= 8 ? 90 + swatch[2] - 8 : 30 + swatch[2]));
	if (depth !== 'truecolor' && lum < 0.7) parts.push('2');
	if (bold) parts.push('1');
	return `\x1b[${parts.join(';')}m`;
}

export const paint = (text: string, swatch: Swatch, lum: number, depth: ColorDepth, bold = false): string => {
	const esc = sgr(swatch, lum, depth, bold);
	return esc ? esc + text + RESET : text;
};
