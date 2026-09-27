/**
 * The Jarvis C2 arc reactor for a terminal.
 *
 * Two renderers, one design (the Jarvis reactor geometry, palette and motion clock):
 * - `ring`: the console reactor's six arc glyphs (◜◠◝ over ◟◡◞), a two-row status mark.
 * - `large`: the full instrument rasterised to braille — bezel ticks, the 36-blade ring
 *   (blades become the task plan: done / running / pending) with its walking glint, the
 *   counter-rotating coil, the level arc (plan progress), the lens rim, both iris arcs,
 *   the thinking ring and the hot core. Its dots never move; its light does.
 *
 * Nothing here writes to a stream: each call returns rows for the caller to print.
 */
import { mix, palette, paint, RESET, rgb, type ColorDepth, type RGB as RGBt, type Swatch } from './theme.js';

export type ReactorState = 'idle' | 'thinking' | 'tool' | 'attention' | 'warming' | 'alert' | 'kill' | 'offline';

export const WORDS: Record<ReactorState, string> = {
	idle: 'Ready',
	thinking: 'Planning',
	tool: 'Working',
	attention: 'Needs you',
	warming: 'Starting',
	alert: 'Alert',
	kill: 'Stopped',
	offline: 'Offline',
};

/** States with no motion: nothing moves in a stopped or dead reactor. */
export const STILL: ReadonlySet<ReactorState> = new Set(['kill', 'offline']);

const p = palette;
/** What is lit now (level arc, rim, glint, glow). */
const LIVE: Record<ReactorState, Swatch> = {
	idle: p.accentDeep, thinking: p.accent, tool: p.accent, attention: p.warn,
	warming: p.warming, alert: p.danger, kill: p.kill, offline: p.tick,
};
/** The core dot. */
const HOT: Record<ReactorState, Swatch> = {
	idle: p.accent, thinking: p.accentLift, tool: p.accentLift, attention: p.warn,
	warming: p.warming, alert: p.dangerText, kill: p.kill, offline: p.tick,
};
const DEEP: Record<ReactorState, Swatch> = {
	idle: p.accentDeep, thinking: p.accentDeep, tool: p.accentDeep, attention: p.warn,
	warming: p.warming, alert: p.danger, kill: p.kill, offline: p.tick,
};
const RIM: Partial<Record<ReactorState, number>> = { attention: 0.85, alert: 0.9 };
const THINK: Partial<Record<ReactorState, number>> = { thinking: 0.55, tool: 0.55 };
const DIM: Partial<Record<ReactorState, number>> = { kill: 0.55, offline: 0.4 };

/** motion.reactor_ms and motion.durations_ms. */
const PERIOD = { blades: 90_000, coil: 60_000, irisA: 20_000, irisB: 32_000, breathe: 5_000, glint: 14_000, level: 3_400, think: 9_000 };
const DUR = { pulse: 620, enter: 900, blink: 2_400 };

/** motion.ease_standard, cubic-bezier(0.22, 0.61, 0.36, 1) sampled at 16 points. */
const EASE = [0, 0.183, 0.353, 0.501, 0.622, 0.717, 0.792, 0.849, 0.894, 0.927, 0.953, 0.972, 0.985, 0.994, 0.999, 1];

export function ease(x: number): number {
	if (x <= 0) return 0;
	if (x >= 1) return 1;
	const f = x * (EASE.length - 1);
	const i = Math.floor(f);
	return EASE[i] + (EASE[i + 1] - EASE[i]) * (f - i);
}

const frac = (x: number) => x - Math.floor(x);
/** 0 → 1 → 0 over one period, eased both ways: a breath, a pulse. */
const tri = (t: number, ms: number) => {
	const ph = frac((t * 1000) / ms);
	return ph < 0.5 ? ease(ph * 2) : ease((1 - ph) * 2);
};

/** Luminance the state's motion gives at `t` (s); `since` is seconds in this state. */
function lum(state: ReactorState, t: number, since: number, progress: number): number {
	switch (state) {
		case 'idle':
			return 0.6 + 0.2 * tri(t, PERIOD.breathe);
		case 'attention': {
			// Rise over dur.pulse, hold, fall, on a dur.blink cycle: held, not blinking.
			const ph = (since * 1000) % DUR.blink;
			const k = ph < DUR.pulse ? ease(ph / DUR.pulse) : ph < DUR.blink - DUR.pulse ? 1 : ease((DUR.blink - ph) / DUR.pulse);
			return 0.55 + 0.45 * k;
		}
		case 'warming':
			return 0.2 + 0.8 * Math.max(0, Math.min(1, progress));
		case 'alert':
			// Three fast cycles, then held lit.
			return since * 1000 >= DUR.pulse * 3 ? 1 : 0.5 + 0.5 * tri(since, DUR.pulse);
		default:
			return 1;
	}
}

export interface ReactorOpts {
	depth: ColorDepth;
	/** Seconds since the state was entered (alert/attention motions). Defaults to `t`. */
	since?: number;
	/** Plan: total tasks and finished ones. `segments` 0 = no plan. */
	segments?: number;
	done?: number;
	/** Workers running (the ring lights this many cells in `tool`). */
	running?: number;
	/** Warming progress 0–1. */
	progress?: number;
	/** A goal is active: the goal dot orbits the ring. */
	goal?: boolean;
	/** Clock multiplier for rotations (the web's periods read as stillness at braille size). */
	tempo?: number;
	/** The state before this one: colours crossfade from it over motion.dur.base. */
	prev?: ReactorState;
	/** `blocks` (anti-aliased half blocks, truecolor only) or `braille`. */
	style?: 'blocks' | 'braille';
}

// --- the six-arc ring -------------------------------------------------------------

export const RING = ['◜', '◠', '◝', '◞', '◡', '◟'] as const;
const CELLS = [[0, 1, 2], [5, 4, 3]];

/** One glyph that walks the ring: the per-agent "working" spinner. */
export function spinner(t: number, fps = 8): string {
	return RING[Math.floor(t * fps) % RING.length];
}

/** The console reactor: two rows of three arc glyphs lit by the state. */
export function ring(state: ReactorState, t: number, o: ReactorOpts): string[] {
	if (STILL.has(state)) t = 0;
	const since = STILL.has(state) ? 0 : o.since ?? t;
	const tempo = o.tempo ?? 1;
	const l = lum(state, t, since, o.progress ?? 0);
	const cells = RING.map((glyph) => ({ glyph: glyph as string, lit: true, lum: l, sw: LIVE[state] }));
	if (state === 'thinking') {
		// One lit arc of two cells sweeps clockwise once per motion.reactor.think.
		const head = Math.floor(frac((t * tempo * 1000) / PERIOD.think) * 6);
		cells.forEach((c, i) => (c.lit = i === head || i === (head + 1) % 6));
	} else if (state === 'tool') {
		const n = Math.max(1, Math.min(6, o.running ?? 1));
		// The lit block turns, so a steady worker count still reads as motion.
		const off = Math.floor(frac((t * tempo * 1000) / PERIOD.think) * 6);
		cells.forEach((c, i) => (c.lit = (i - off + 6) % 6 < n));
	} else if (state === 'attention') cells[1].lit = false;
	else if (state === 'alert' && since * 1000 >= DUR.pulse * 3) cells[4].glyph = '⊖';
	else if (state === 'kill') cells.forEach((c, i) => ((c.lit = i === 4), (c.lum = 1)));
	else if (state === 'offline') cells.forEach((c) => (c.lum = 0.6));
	if (o.goal && !STILL.has(state)) {
		const at = Math.floor(frac((t * tempo * 1000) / PERIOD.irisB) * 6);
		Object.assign(cells[at], { glyph: '⊙', lit: true, sw: p.accentDeep });
	}
	return CELLS.map((row) =>
		row
			.map((i) => {
				const c = cells[i];
				if (c.lit) return paint(c.glyph, c.sw, c.lum, o.depth);
				return o.depth === 'none' ? ' ' : paint(c.glyph, p.line, 1, o.depth);
			})
			.join(''),
	);
}

// --- the instrument in braille -------------------------------------------------------
//
// Braille gives 2×4 dots and one colour per cell, so anything that moves its dots aliases:
// a rotating segmented ring re-samples its gaps every frame and shimmers. The instrument
// therefore keeps every dot where it is and animates light — a comet glint runs round the
// blades, a wave counter-rotates on the coil, the iris and thinking arcs are bright
// stretches travelling round fixed rings. That is how an LED ring reads as spinning.

type Layer = 'hot' | 'glow' | 'level' | 'rim' | 'irisA' | 'irisB' | 'think' | 'blade' | 'coil' | 'tick' | 'longTick';

/** Which layer wins a cell's one colour; brightness breaks ties within a layer. */
const PRIO: Record<Layer, number> = { hot: 9, glow: 8, level: 6, think: 5, rim: 4, blade: 3, irisA: 3, irisB: 2, coil: 1, tick: 1, longTick: 1 };

interface Dot {
	layer: Layer;
	/** Angle from the top, clockwise. */
	a: number;
	/** Blade index. */
	i: number;
}

interface Cell {
	bits: number;
	dots: Dot[];
}

const TAU = 2 * Math.PI;
/** Braille bit for dot (dx, dy) inside a 2×4 cell. */
const BIT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
const BLADES = 36;
const instruments = new Map<string, Cell[][]>();

/**
 * Every dot of a reactor `rows` tall (2×rows cells wide) and the layer it belongs to,
 * computed once per size. The web's radii (blade .85, coil .74, level .65, core .56, iris
 * .50/.46, think .47) sit 1–2 dots apart at braille size and merge into one band, so the
 * terminal spreads the inner rings ≥2 dots apart in the same order, and drops the rings a
 * small reactor has no room for.
 */
function instrument(rows: number, think: boolean): Cell[][] {
	const key = `${rows}:${think}`;
	const cached = instruments.get(key);
	if (cached) return cached;
	const size = rows * 4; // 2 cols × 2 dots across, 4 dots down: square dots on a 1:2 cell
	const c = (size - 1) / 2;
	const R = c - 0.2;
	const small = rows < 11;
	const nTicks = [120, 60, 36, 24, 12].find((n) => (TAU * R) / n >= 2.5) ?? 12;
	const longEvery = nTicks / 12;
	const rBlade = R * 0.84;
	const rCoil = R * 0.69;
	const rLevel = R * 0.58;
	const rCore = R * 0.47;
	const rIrisA = R * 0.39;
	const rIrisB = R * 0.33;
	const rThink = R * 0.26;
	const bladeStep = TAU / BLADES;
	const bladeGap = Math.max((3 * Math.PI) / 180, 1.2 / rBlade);
	const dotR = Math.max(0.9, R / 35);
	const glowR = Math.max(2.1, R / 14);

	const layerOf = (r: number, a: number): Layer | null => {
		const near = (rr: number, hw = 0.5) => Math.abs(r - rr) < hw;
		const dotted = (rr: number, every: number) => ((a * rr) % every) < 1.2;
		if (r <= dotR) return 'hot';
		if (r <= glowR) return 'glow';
		if (near(rLevel, 0.75)) return 'level';
		if (near(rCore)) return 'rim';
		if (near(rIrisA, 0.45)) return 'irisA';
		if (think && !small && near(rThink, 0.45) && dotted(rThink, 3)) return 'think';
		if (!small && near(rIrisB, 0.45)) return 'irisB';
		if (near(rBlade, 1.2)) return a - Math.floor(a / bladeStep) * bladeStep > bladeStep - bladeGap ? null : 'blade';
		if (rows >= 9 && near(rCoil) && dotted(rCoil, 4)) return 'coil';
		if (r <= R && r >= R - Math.max(1, R * 0.07)) {
			const f = (a / TAU) * nTicks;
			const long = Math.round(f) % nTicks % longEvery === 0;
			const len = long ? Math.max(2, R * 0.07) : Math.max(1, R * 0.032);
			if (Math.abs(f - Math.round(f)) * ((TAU * R) / nTicks) < 0.6 && r >= R - len) return long ? 'longTick' : 'tick';
		}
		return null;
	};

	const cells: Cell[][] = Array.from({ length: rows }, () => Array.from({ length: rows * 2 }, () => ({ bits: 0, dots: [] })));
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++) {
			const dx = x - c;
			const dy = y - c;
			let a = Math.atan2(dy, dx) + Math.PI / 2; // 0 at the top, clockwise (y points down)
			if (a < 0) a += TAU;
			const layer = layerOf(Math.hypot(dx, dy), a);
			if (!layer) continue;
			const cell = cells[y >> 2][x >> 1];
			cell.bits |= BIT[y & 3][x & 1];
			cell.dots.push({ layer, a, i: Math.floor(a / bladeStep) % BLADES });
		}
	instruments.set(key, cells);
	return cells;
}

/** How far behind a moving head angle `a` lies, 0…TAU, clockwise motion. */
const behind = (head: number, a: number) => (((head - a) % TAU) + TAU) % TAU;
/** A comet: full light at the head, fading to nothing `tail` radians behind it. */
const comet = (head: number, a: number, tail: number) => {
	const d = behind(head, a);
	return d < tail ? (1 - d / tail) ** 2 : 0;
};
/** A lit arc `sweep` radians long ending at `head`, with soft ends. */
const arcLight = (head: number, a: number, sweep: number) => {
	const d = behind(head, a);
	return d > sweep ? 0 : Math.min(1, Math.min(d, sweep - d) / 0.3);
};

const hex = (c: readonly [number, number, number]) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

/** A frame's lighting: what colour and light each layer's point has at time `t`. */
function lighting(state: ReactorState, t: number, o: ReactorOpts, blades: number) {
	if (STILL.has(state)) t = 0;
	const since = STILL.has(state) ? 0 : o.since ?? t;
	const tempo = o.tempo ?? 1;
	const tt = t * tempo * 1000; // rotation clock, ms
	const spin = (ms: number) => ((tt / ms) % 1) * TAU;
	const dim = DIM[state] ?? 1;
	const base = lum(state, t, since, o.progress ?? 0);
	const segments = o.segments ?? 0;
	const done = Math.min(o.done ?? 0, segments);
	const plan = segments > 0;
	const level = state === 'warming' ? o.progress ?? 0 : plan ? done / segments : 0;
	const breath = state === 'idle' ? 0.14 * tri(t, PERIOD.level) : 0;

	// Crossfade: the state tables' colours run from the previous state's over dur.base.
	const fade = o.prev && o.prev !== state && since < 0.26 ? ease(since / 0.26) : 1;
	const toneCache = new Map<Record<ReactorState, Swatch>, Swatch>();
	const tone = (table: Record<ReactorState, Swatch>): Swatch => {
		if (fade >= 1) return table[state];
		let s = toneCache.get(table);
		if (!s) {
			const to = table[state];
			s = [hex(mix(rgb(table[o.prev!][0]), rgb(to[0]), fade)), to[1], to[2]];
			toneCache.set(table, s);
		}
		return s;
	};
	const live = tone(LIVE);
	const deep = tone(DEEP);
	const hot = tone(HOT);

	const glint = spin(PERIOD.glint);
	const coilPhase = spin(PERIOD.coil);
	const irisA = spin(PERIOD.irisA);
	const irisB = Math.PI - spin(PERIOD.irisB);
	const thinkHead = spin(PERIOD.think);
	const pulse = tri(since, DUR.pulse * 2); // the running blade: live ↔ deep
	const glowK = state === 'attention' || state === 'alert' ? 0.25 + 0.45 * tri(since, DUR.enter * 2) : 0.7;
	const thinkLum = THINK[state] ?? 0;
	const rimLum = RIM[state] ?? 0.55;
	const bladeStep = TAU / blades;

	const light = (d: Dot): [Swatch, number] => {
		switch (d.layer) {
			case 'hot':
				return [hot, state === 'idle' ? 0.75 + 0.25 * tri(t, PERIOD.breathe) : 1];
			case 'glow':
				return [live, glowK];
			case 'level': {
				const lit = level + breath;
				if (lit <= 0 || d.a / TAU > lit) return [p.lineSoft, 1];
				// The head of the arc glows a little brighter: progress has a leading edge.
				const head = lit * TAU - d.a < 0.14 ? 0.15 * tri(since, DUR.pulse * 2) : 0;
				return [live, Math.min(1, base * (0.85 + head))];
			}
			case 'rim':
				return [live, rimLum * base];
			case 'irisA':
				return [deep, 0.2 + 0.6 * arcLight(irisA, d.a, 1.25 * Math.PI)];
			case 'irisB':
				return [p.textDim, 0.12 + 0.45 * arcLight(irisB + 1.1 * Math.PI, d.a, 1.1 * Math.PI)];
			case 'think':
				return [live, thinkLum * (0.35 + 0.65 * comet(thinkHead, d.a, Math.PI / 2))];
			case 'blade': {
				const k = comet(glint, (d.i + 0.5) * bladeStep, 0.9);
				let sw: Swatch = p.tick;
				let l = d.i % 3 === 2 ? 0.62 : 0.9;
				if (plan) {
					const slot = Math.floor((d.i * segments) / blades);
					if (slot < done) [sw, l] = [p.textDim, 0.85];
					else if (slot === done && done < segments) [sw, l] = [pulse > 0.5 ? live : deep, 0.6 + 0.4 * pulse];
					else l = 0.55;
				}
				return k > 0.3 ? [live, Math.max(l, 0.35 + 0.65 * k)] : [sw, Math.max(l, l + 0.5 * k)];
			}
			case 'coil': {
				// Three bright lobes counter-rotating round the coil.
				const wave = 0.5 + 0.5 * Math.cos(3 * d.a + coilPhase);
				return [p.tick, 0.35 + 0.6 * wave * wave];
			}
			case 'tick':
				return [p.tick, 1];
			case 'longTick':
				return [p.textDim, 1];
		}
	};

	return { light, dim };
}

/**
 * The full reactor, `rows` tall and `2*rows` cells wide: anti-aliased half blocks in
 * truecolor (the default: every pixel its own colour, independent of the font's braille),
 * braille otherwise. The same state and size always give the same shapes; light moves.
 */
export function large(state: ReactorState, t: number, rows: number, o: ReactorOpts): string[] {
	return (o.style ?? 'blocks') === 'blocks' && o.depth === 'truecolor' ? blocks(state, t, rows, o) : braille(state, t, rows, o);
}

/** The braille instrument: each cell takes the colour of its strongest dot (by layer, then light). */
function braille(state: ReactorState, t: number, rows: number, o: ReactorOpts): string[] {
	const { light, dim } = lighting(state, t, o, BLADES);
	const thinkLum = THINK[state] ?? 0;
	const out: string[] = [];
	for (const row of instrument(rows, thinkLum > 0)) {
		let line = '';
		let run = '';
		let runKey = '';
		let runSw: Swatch | null = null;
		let runLum = 1;
		const flush = () => {
			if (run) line += runSw ? paint(run, runSw, runLum, o.depth) : run;
			run = '';
		};
		for (const cell of row) {
			let best: [Swatch, number] | null = null;
			let bestScore = -1;
			for (const d of cell.dots) {
				const lit = light(d);
				const score = PRIO[d.layer] + lit[1];
				if (score > bestScore) [best, bestScore] = [lit, score];
			}
			// Quantise light so neighbouring cells share one escape.
			const l = best ? Math.round(best[1] * dim * 20) / 20 : 1;
			const key = best && o.depth !== 'none' ? `${best[0][0]}|${l}` : '';
			if (key !== runKey) {
				flush();
				runKey = key;
				runSw = key ? best![0] : null;
				runLum = l;
			}
			run += cell.bits ? String.fromCharCode(0x2800 + cell.bits) : ' ';
		}
		flush();
		out.push(line);
	}
	return out;
}

// --- the instrument in half blocks ------------------------------------------------------
//
// `▀` with a foreground and a background colour is two square pixels per cell, each its own
// truecolor. The reactor is drawn on its dark lens (a disc; the corners stay the terminal's
// own background), every pixel supersampled 3×3 so thin rings are soft instead of jagged.

interface Px {
	/** Inside the lens disc: painted. */
	disc: boolean;
	/** Layers touching this pixel, back to front, with how much of the pixel each covers. */
	parts: { layer: Layer; cov: number; a: number; i: number }[];
}

const pixelMaps = new Map<string, { px: Px[]; size: number; blades: number }>();

/** Layer order for compositing, back to front. */
const DEPTH: Layer[] = ['tick', 'longTick', 'coil', 'blade', 'level', 'rim', 'irisB', 'irisA', 'think', 'glow', 'hot'];

function pixelMap(rows: number, think: boolean) {
	const key = `${rows}:${think}`;
	const hit = pixelMaps.get(key);
	if (hit) return hit;
	const size = rows * 2; // rows cells × 2 pixels tall; 2·rows cells × 1 pixel wide
	const c = size / 2;
	const R = c - 0.4;
	// Blades at least ~3.5 pixels long: finer segments blur into noise at this resolution.
	const blades = [36, 24, 18, 12].find((n) => (TAU * R * 0.84) / n >= 3.5) ?? 12;
	const bladeStep = TAU / blades;
	const roomy = size >= 36;
	const rings = {
		blade: [R * 0.84, 0.8],
		coil: [R * 0.69, 0.45],
		level: [R * 0.57, 0.75],
		rim: [R * 0.45, 0.4],
		irisA: [R * 0.36, 0.4],
		irisB: [R * 0.3, 0.35],
		think: [R * 0.25, 0.35],
	} as const;
	const glowR = Math.max(2.2, R * 0.2);
	const layerAt = (r: number, a: number): Layer | null => {
		const on = (k: keyof typeof rings) => Math.abs(r - rings[k][0]) < rings[k][1];
		if (r < 1.1) return 'hot';
		if (r < glowR) return 'glow';
		if (on('level')) return 'level';
		if (on('rim')) return 'rim';
		if (on('irisA')) return 'irisA';
		if (roomy && on('irisB')) return 'irisB';
		if (think && roomy && on('think')) return 'think';
		if (on('blade')) return a % bladeStep > bladeStep - 1 / rings.blade[0] ? null : 'blade';
		if (roomy && on('coil') && (a * rings.coil[0]) % 3 < 1.1) return 'coil';
		if (r <= R && r > R - 2.4) {
			// Twelve long ticks on a thin continuous bezel: short ticks at this size read as teeth.
			const f = (a / TAU) * 12;
			if (Math.abs(f - Math.round(f)) * ((TAU * R) / 12) < 0.5) return 'longTick';
			if (r > R - 0.8) return 'tick';
		}
		return null;
	};
	const angle = (dx: number, dy: number) => {
		const a = Math.atan2(dy, dx) + Math.PI / 2;
		return a < 0 ? a + TAU : a;
	};
	const px: Px[] = [];
	const S = 3;
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++) {
			const counts = new Map<Layer, number>();
			for (let sy = 0; sy < S; sy++)
				for (let sx = 0; sx < S; sx++) {
					const dx = x + (sx + 0.5) / S - c;
					const dy = y + (sy + 0.5) / S - c;
					const l = layerAt(Math.hypot(dx, dy), angle(dx, dy));
					if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
				}
			const dx = x + 0.5 - c;
			const dy = y + 0.5 - c;
			const a = angle(dx, dy);
			px.push({
				disc: Math.hypot(dx, dy) <= R + 0.5,
				parts: DEPTH.filter((l) => counts.has(l)).map((layer) => ({ layer, cov: counts.get(layer)! / (S * S), a, i: Math.floor(a / bladeStep) % blades })),
			});
		}
	const map = { px, size, blades };
	pixelMaps.set(key, map);
	return map;
}

function blocks(state: ReactorState, t: number, rows: number, o: ReactorOpts): string[] {
	const thinkLum = THINK[state] ?? 0;
	const { px, size, blades } = pixelMap(rows, thinkLum > 0);
	const { light, dim } = lighting(state, t, o, blades);
	const housing = rgb(palette.housing[0]);
	const lens = rgb(palette.bg[0]);
	const colour = (p: Px): RGBt | null => {
		if (!p.disc) return null;
		let c: RGBt = lens;
		for (const part of p.parts) {
			const [sw, l] = light(part);
			c = mix(c, mix(housing, rgb(sw[0]), Math.min(1, l * dim)), part.cov);
		}
		return c;
	};
	const esc = (fg: RGBt, bg: RGBt | null) => `\x1b[38;2;${fg[0]};${fg[1]};${fg[2]}${bg ? `;48;2;${bg[0]};${bg[1]};${bg[2]}` : ';49'}m`;
	const out: string[] = [];
	for (let row = 0; row < rows; row++) {
		let line = '';
		let last = '';
		for (let x = 0; x < size; x++) {
			const top = colour(px[row * 2 * size + x]);
			const bottom = colour(px[(row * 2 + 1) * size + x]);
			let seq: string;
			let ch: string;
			if (!top && !bottom) [seq, ch] = ['\x1b[0m', ' '];
			else if (top && !bottom) [seq, ch] = [esc(top, null), '▀'];
			else if (!top && bottom) [seq, ch] = [esc(bottom, null), '▄'];
			else [seq, ch] = [esc(top!, bottom), '▀'];
			if (seq !== last) line += seq;
			last = seq;
			line += ch;
		}
		out.push(line + RESET);
	}
	return out;
}
