import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bar, bins, sparkline, split } from '../src/tui/charts.js';

test('sparkline: scaled to the max, the newest width values, flat zero is the floor', () => {
	assert.equal(sparkline([0, 1, 2, 3, 4, 5, 6, 7], 8), '▁▂▃▄▅▆▇█');
	assert.equal(sparkline([9, 0, 8], 2), '▁█', 'keeps the newest values');
	assert.equal(sparkline([0, 0, 0], 3), '▁▁▁');
	assert.equal(sparkline([], 4), '');
	assert.equal(sparkline([5], 0), '');
	assert.equal(sparkline([0.5, 0.5, 1], 3, 1), '▅▅█', 'a fixed top: a steady half is half, not full');
});

test('bar: whole cells plus an eighth-block tail, never wider than width', () => {
	assert.equal(bar(1, 1, 4), '████');
	assert.equal(bar(0.5, 1, 4), '██');
	assert.equal(bar(1, 8, 1), '▏');
	assert.equal(bar(3, 16, 2), '▍');
	assert.equal(bar(0, 5, 4), '');
	assert.equal(bar(9, 5, 3), '███', 'over max is capped');
	assert.equal(bar(1, 0, 3), '', 'no max draws nothing');
	// A value that rounds to nothing still shows a sliver, so "some" never reads as "none".
	assert.equal(bar(1, 1000, 4), '▏');
});

test('split: widths sum to width, every non-zero count gets a cell when there is room', () => {
	assert.deepEqual(split([1, 1], 10), [5, 5]);
	assert.deepEqual(split([3, 0, 1], 8), [6, 0, 2]);
	assert.deepEqual(split([100, 1], 10), [9, 1], 'a small share still shows');
	assert.deepEqual(split([0, 0], 5), [0, 0]);
	assert.equal(split([7, 3, 5, 1], 13).reduce((a, b) => a + b, 0), 13);
	assert.equal(split([1, 1, 1], 2).reduce((a, b) => a + b, 0), 2, 'fewer cells than counts: still exactly width');
});

test('bins: counts of times per equal slot, the last slot closed', () => {
	assert.deepEqual(bins([0, 1, 5, 9, 10], 0, 10, 2), [2, 3]);
	assert.deepEqual(bins([-1, 11], 0, 10, 2), [0, 0], 'outside the range is dropped');
	assert.deepEqual(bins([5], 5, 5, 3), [0, 0, 1], 'an empty range puts everything in the last slot');
});

test('stats bins: weights sum per slot instead of counting', () => {
	assert.deepEqual(bins([0, 1, 9], 0, 10, 2, [0.5, 0.25, 2]), [0.75, 2]);
});
