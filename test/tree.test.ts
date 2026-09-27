import assert from 'node:assert/strict';
import { test } from 'node:test';
import { treeLines, type TreeItem } from '../src/tui/tree.js';

const item = (id: string, ...parents: string[]): TreeItem => ({ id, parents, text: id.toUpperCase() });
const rows = (items: TreeItem[]) => treeLines(items).map((l) => `${l.prefix}${l.ref ? '→ ' : ''}${l.id}${l.cycle ? ' (cycle)' : ''}`);

test('treeLines: a 3-level tree gets exact box-drawing prefixes in input order', () => {
	assert.deepEqual(rows([item('r'), item('a', 'r'), item('c', 'a'), item('b', 'r')]), ['r', '├─ a', '│  └─ c', '└─ b']);
	assert.deepEqual(treeLines([item('r')]), [{ prefix: '', id: 'r', text: 'R' }]);
});

test('treeLines: an item with two parents sits under the first and is a reference row under the second', () => {
	assert.deepEqual(rows([item('r'), item('a', 'r'), item('b', 'r'), item('c', 'a', 'b')]), ['r', '├─ a', '│  └─ c', '└─ b', '   └─ → c']);
});

test('treeLines: a 2-node cycle is drawn once, finite and marked', () => {
	assert.deepEqual(rows([item('a', 'b'), item('b', 'a')]), ['a (cycle)', '└─ b (cycle)', '   └─ → a (cycle)']);
	assert.deepEqual(rows([item('x', 'x')]), ['x (cycle)', '└─ → x (cycle)']);
	// a child of a cycle that no root reaches is drawn under the cycle, not as its own root
	assert.deepEqual(rows([item('c', 'b'), item('a', 'b'), item('b', 'a')]), ['b (cycle)', '├─ c', '└─ a (cycle)', '   └─ → b (cycle)']);
	// a cycle closed only by reference rows on separate branches is still marked
	assert.deepEqual(rows([item('r'), item('s'), item('x', 'r', 'y'), item('y', 's', 'x')]), [
		'r',
		'└─ x (cycle)',
		'   └─ → y (cycle)',
		's',
		'└─ y (cycle)',
		'   └─ → x (cycle)',
	]);
});

test('treeLines: an unknown parent id counts as a root', () => {
	assert.deepEqual(rows([item('a', 'gone'), item('b', 'gone', 'a')]), ['a', '└─ b']);
});
