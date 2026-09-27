import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters as strip } from 'node:util';
import { ease, large, ring, spinner, RING } from '../src/reactor.js';
import { colorDepth, mix, palette, rgb } from '../src/theme.js';

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
	// Finished blades are text-dim at 85% light; count cells painted exactly that colour.
	const [r, g, b] = mix(rgb(palette.housing[0]), rgb(palette.textDim[0]), 0.85);
	const finished = (s: string) => s.split(`38;2;${r};${g};${b}m`).length - 1;
	const none = large('tool', 0, 15, { depth: 'truecolor', style: 'braille', segments: 8, done: 0 }).join('');
	const half = large('tool', 0, 15, { depth: 'truecolor', style: 'braille', segments: 8, done: 4 }).join('');
	assert.equal(finished(none), 0);
	assert.ok(finished(half) > 5, `only ${finished(half)} finished-blade runs`);
	// Progress lights the level arc: more live-colour cells at 4/8 than at 0/8.
	const live = (s: string) => s.split('38;2;').length;
	assert.ok(live(half) >= live(none));
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

test('geometry holds still between frames: the reactor moves light, not dots', () => {
	for (const style of ['blocks', 'braille'] as const)
		for (const state of ['tool', 'thinking', 'idle', 'attention'] as const) {
			const at = (t: number) => large(state, t, 13, { ...tc, style, segments: 7, done: 2 });
			const base = strip(at(10).join('\n'));
			for (let f = 1; f <= 12; f++) assert.equal(strip(at(10 + f / 24).join('\n')), base, `${style} ${state} frame ${f} moved dots`);
			// ...while the colours do move: it is still animated.
			assert.notEqual(at(10).join(''), at(10.5).join(''), `${style} ${state} is not animated`);
		}
});

test('blocks: half-block pixels on a round lens, corners left to the terminal', () => {
	const out = large('tool', 1, 15, { ...tc, style: 'blocks' });
	assert.equal(out.length, 15);
	for (const line of out) assert.equal([...strip(line)].length, 30);
	assert.ok(strip(out[0]).startsWith(' '), 'the top-left corner is outside the lens');
	assert.ok(out.join('').includes('48;2;'), 'full cells carry a background colour: two pixels per cell');
	assert.match(strip(out[7]), /^[▀▄]/, 'the lens reaches the left edge at the middle row');
});

test('a state change crossfades colours instead of cutting', () => {
	const at = (since: number) => large('alert', 5, 13, { ...tc, prev: 'tool', since }).join('');
	assert.notEqual(at(0.05), at(2), 'mid-fade differs from the settled state');
	assert.equal(strip(at(0.05)), strip(at(2)), 'and still only colour changes');
	assert.equal(large('alert', 5, 13, { ...tc, prev: 'alert', since: 0.05 }).join(''), large('alert', 5, 13, { ...tc, since: 0.05 }).join(''));
});
