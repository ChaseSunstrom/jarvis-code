/**
 * The Jarvis C2 arc reactor for a terminal.
 *
 * Two renderers, one design (the Jarvis reactor geometry, palette and motion clock):
 * - `ring`: the console reactor's six arc glyphs (◜◠◝ over ◟◡◞), a two-row status mark.
 * - `large`: the full instrument rasterised to braille — bezel ticks, the 36-blade ring
 *   with its walking glint (blades become the task plan: done / running / pending), the
 *   counter-rotating coil, the level arc (plan progress), the lens rim, both iris arcs,
 *   the dashed thinking ring and the hot core.
 *
 * Nothing here writes to a stream: each call returns rows for the caller to print.
 */
import { palette, paint, type ColorDepth, type Swatch } from './theme.js';

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

interface Dot { r: number; a: number }
const geometry = new Map<number, { w: number; h: number; R: number; dots: Dot[] }>();

/** Polar coordinates of every braille dot for a reactor `rows` tall (2×rows cells wide). */
function grid(rows: number) {
	let g = geometry.get(rows);
	if (g) return g;
	const w = rows * 4; // 2 cols × 2 dots, square dots on a 1:2 cell
	const h = rows * 4;
	const cx = (w - 1) / 2;
	const cy = (h - 1) / 2;
	const dots: Dot[] = [];
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const dx = x - cx;
			const dy = y - cy;
			// 0 at the top, growing clockwise (y points down).
			let a = Math.atan2(dy, dx) + Math.PI / 2;
			if (a < 0) a += 2 * Math.PI;
			dots.push({ r: Math.hypot(dx, dy), a });
		}
	g = { w, h, R: Math.min(cx, cy) - 0.2, dots };
	geometry.set(rows, g);
	return g;
}

const TAU = 2 * Math.PI;
/** Braille bit for dot (dx, dy) inside a 2×4 cell. */
const BIT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];

interface Mark { sw: Swatch; lum: number; prio: number }

/**
 * The full reactor, `rows` tall and `2*rows` cells wide. Each braille cell takes the
 * colour of its highest-priority lit dot, mixed toward the housing by that dot's light.
 */
export function large(state: ReactorState, t: number, rows: number, o: ReactorOpts): string[] {
	const { w, h, R, dots } = grid(rows);
	if (STILL.has(state)) t = 0;
	const since = STILL.has(state) ? 0 : o.since ?? t;
	const tempo = o.tempo ?? 1;
	const tt = t * tempo * 1000; // rotation clock, ms
	const spin = (ms: number) => frac(tt / ms) * TAU;
	const dim = DIM[state] ?? 1;
	const base = lum(state, t, since, o.progress ?? 0);
	const live = LIVE[state];
	const segments = o.segments ?? 0;
	const done = Math.min(o.done ?? 0, segments);
	const plan = segments > 0;
	const level = state === 'warming' ? o.progress ?? 0 : plan ? done / segments : 0;
	const breath = state === 'idle' ? 0.14 * tri(t, PERIOD.level) : 0;

	// Adaptive bezel: the densest tick count that keeps ≥2.5 dots between ticks.
	const nTicks = [120, 60, 36, 24, 12].find((n) => (TAU * R) / n >= 2.5) ?? 12;
	const longEvery = nTicks / 12;
	// The web's radii (blade .85, coil .74, level .65, core .56, iris .50/.46, think .47)
	// sit 1–2 dots apart at braille size and merge into one band, so the terminal spreads
	// the inner rings to ≥2 dots apart, keeping their order.
	const rBlade = R * 0.84;
	const rCoil = R * 0.69;
	const rLevel = R * 0.58;
	const rCore = R * 0.47;
	const rIrisA = R * 0.39;
	const rIrisB = R * 0.33;
	const rThink = R * 0.26;
	const bladeStep = TAU / 36;
	const bladeGap = Math.max((3 * Math.PI) / 180, 1.2 / rBlade);
	const rotBlades = spin(PERIOD.blades);
	const rotCoil = -spin(PERIOD.coil);
	const rotIrisA = spin(PERIOD.irisA);
	const rotIrisB = -spin(PERIOD.irisB);
	const rotThink = spin(PERIOD.think);
	const glintPh = frac(tt / PERIOD.glint);
	const pulse = tri(since, DUR.pulse * 2); // running blade: live ↔ deep
	const glowK = state === 'attention' || state === 'alert' ? 0.25 + 0.45 * tri(since, DUR.enter * 2) : 0.7;
	const thinkLum = THINK[state] ?? 0;
	const rimLum = RIM[state] ?? 0.55;
	const dotR = Math.max(0.9, R / 35);
	const glowR = Math.max(2.1, R / 14);

	const mark = (d: Dot): Mark | null => {
		const { r, a } = d;
		const near = (rr: number, hw = 0.5) => Math.abs(r - rr) < hw;
		if (r <= dotR) return { sw: HOT[state], lum: 1, prio: 9 };
		if (r <= glowR) return { sw: live, lum: glowK, prio: 8 };
		// Level arc, filled clockwise from the top.
		if (near(rLevel, 0.75)) {
			const lit = level + breath;
			if (lit > 0 && a / TAU <= lit) return { sw: live, lum: base, prio: 6 };
			return { sw: p.lineSoft, lum: 1, prio: 2 };
		}
		if (near(rCore, 0.5)) return { sw: live, lum: rimLum * base, prio: 4 };
		if (near(rIrisA, 0.45)) {
			const local = (a - rotIrisA + 2 * TAU) % TAU;
			if (local <= 1.25 * Math.PI) return { sw: DEEP[state], lum: 0.7, prio: 3 };
		}
		if (thinkLum > 0 && near(rThink, 0.45)) {
			const s = ((a - rotThink + 2 * TAU) % TAU) * rThink;
			if (s % 4 < 1.2) return { sw: live, lum: thinkLum, prio: 5 };
		}
		if (near(rIrisB, 0.45)) {
			const local = (a - rotIrisB - Math.PI + 2 * TAU) % TAU;
			if (local <= 1.1 * Math.PI) return { sw: p.textDim, lum: 0.6, prio: 3 };
		}
		if (near(rBlade, 1.2)) {
			const local = (a - rotBlades + 2 * TAU) % TAU;
			const i = Math.floor(local / bladeStep) % 36;
			if (local - i * bladeStep > bladeStep - bladeGap) return null;
			if (plan) {
				const slot = Math.floor((i * segments) / 36);
				if (slot < done) return { sw: p.textDim, lum: 1, prio: 5 };
				if (slot === done && done < segments) return { sw: pulse > 0.5 ? live : DEEP[state], lum: 0.7 + 0.3 * pulse, prio: 7 };
				return { sw: p.tick, lum: 0.55, prio: 2 };
			}
			// The glint walks the blades: 0% line, 3% live, 11% line (the web keyframes).
			const ph = frac(glintPh + i / 36);
			const k = ph < 0.03 ? ph / 0.03 : ph < 0.11 ? 1 - (ph - 0.03) / 0.08 : 0;
			if (k > 0.15) return { sw: live, lum: 0.35 + 0.65 * k, prio: 7 };
			return { sw: p.tick, lum: i % 3 === 2 ? 0.6 : 0.85, prio: 2 };
		}
		if (near(rCoil, 0.5)) {
			const s = ((a - rotCoil + 2 * TAU) % TAU) * rCoil;
			if (s % 4 < 1.2) return { sw: p.tick, lum: 0.8, prio: 1 };
		}
		if (r <= R && r >= R - Math.max(1, R * 0.07)) {
			const f = (a / TAU) * nTicks;
			const n = Math.round(f) % nTicks;
			const long = n % longEvery === 0;
			const len = long ? Math.max(2, R * 0.07) : Math.max(1, R * 0.032);
			if (Math.abs(f - Math.round(f)) * ((TAU * R) / nTicks) < 0.6 && r >= R - len)
				return { sw: long ? p.textDim : p.tick, lum: 1, prio: 1 };
		}
		return null;
	};

	const out: string[] = [];
	for (let cy = 0; cy < h / 4; cy++) {
		let line = '';
		let run = '';
		let runKey = '';
		let runSw: Swatch | null = null;
		let runLum = 1;
		const flush = () => {
			if (run) line += runSw ? paint(run, runSw, runLum, o.depth) : run;
			run = '';
		};
		for (let cx = 0; cx < w / 2; cx++) {
			let bits = 0;
			let best: Mark | null = null;
			for (let dy = 0; dy < 4; dy++)
				for (let dx = 0; dx < 2; dx++) {
					const m = mark(dots[(cy * 4 + dy) * w + cx * 2 + dx]);
					if (!m) continue;
					bits |= BIT[dy][dx];
					if (!best || m.prio > best.prio || (m.prio === best.prio && m.lum > best.lum)) best = m;
				}
			const ch = bits ? String.fromCharCode(0x2800 + bits) : ' ';
			// Quantise light so neighbouring cells share one escape.
			const l = best ? Math.round(best.lum * dim * 20) / 20 : 1;
			const key = best && o.depth !== 'none' ? `${best.sw[0]}|${l}` : '';
			if (key !== runKey) {
				flush();
				runKey = key;
				runSw = key ? best!.sw : null;
				runLum = l;
			}
			run += ch;
		}
		flush();
		out.push(line);
	}
	return out;
}
