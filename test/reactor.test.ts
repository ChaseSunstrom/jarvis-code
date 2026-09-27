import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters as strip } from 'node:util';
import { ease, large, ring, spinner, RING } from '../src/reactor.js';
import { colorDepth } from '../src/theme.js';

const tc = { depth: 'truecolor' as const, tempo: 3 };

test('ease follows the standard curve and clamps', () => {
	assert.equal(ease(-1), 0);
	assert.equal(ease(2), 1);
	assert.ok(Math.abs(ease(0.5) - 0.8715) < 0.01);
});

test('large reactor is rows tall and 2×rows wide', () => {
	for (const rows of [7, 11, 15]) {
		const out = large('tool', 1, rows, tc);
		assert.equal(out.length, rows);
		for (const line of out) assert.equal([...strip(line)].length, rows * 2);
	}
});

test('large reactor animates while working and holds still when stopped', () => {
	const at = (st: 'tool' | 'thinking' | 'kill', t: number) => large(st, t, 15, { ...tc, segments: 6, done: 2 }).join('\n');
	assert.notEqual(at('tool', 0), at('tool', 0.5));
	assert.notEqual(at('thinking', 0), at('thinking', 0.5));
	// Consecutive frames at 24 fps differ too: motion, not a slideshow.
	let changed = 0;
	for (let f = 0; f < 24; f++) if (at('tool', f / 24) !== at('tool', (f + 1) / 24)) changed++;
	assert.ok(changed >= 18, `only ${changed}/24 frames changed`);
	assert.equal(strip(at('kill', 0)), strip(at('kill', 5)));
});

test('plan progress lights the level arc and dims finished blades', () => {
	const count = (s: string, hex: string) => {
		const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
		return s.split(`38;2;${r};${g};${b}m`).length - 1;
	};
	const none = large('tool', 0, 15, { depth: 'truecolor', segments: 8, done: 0 }).join('');
	const half = large('tool', 0, 15, { depth: 'truecolor', segments: 8, done: 4 }).join('');
	// Finished blades are text-dim at full light; nothing is finished at 0/8.
	assert.equal(count(none, '#7c9ea9') < count(half, '#7c9ea9'), true);
});

test('no colour means no escapes', () => {
	const out = large('tool', 0, 9, { depth: 'none' }).concat(ring('tool', 0, { depth: 'none' }));
	for (const line of out) assert.equal(line, strip(line));
});

test('ring: thinking sweeps a two-cell arc, kill lights only the bottom', () => {
	const lit = (rows: string[]) => rows.join('').replace(/\x1b\[[0-9;]*m/g, '|').length;
	const think = ring('thinking', 0, { depth: 'none' });
	assert.equal(think.join('').replace(/ /g, '').length, 2);
	assert.notEqual(think.join(''), ring('thinking', 1.6, { depth: 'none' }).join(''));
	assert.deepEqual(ring('kill', 3, { depth: 'none' }), ['   ', ' ◡ ']);
	assert.ok(lit(ring('idle', 0, { depth: 'truecolor' })) > 6);
	assert.ok(RING.includes(spinner(0.3) as (typeof RING)[number]));
});

test('colour depth follows NO_COLOR, COLORTERM, TERM', () => {
	assert.equal(colorDepth({ NO_COLOR: '1', COLORTERM: 'truecolor' }), 'none');
	assert.equal(colorDepth({ COLORTERM: 'truecolor', TERM: 'xterm' }), 'truecolor');
	assert.equal(colorDepth({ TERM: 'xterm-256color' }), '256');
	assert.equal(colorDepth({ TERM: 'xterm' }), '16');
	assert.equal(colorDepth({ TERM: 'xterm' }, false), 'none');
});
