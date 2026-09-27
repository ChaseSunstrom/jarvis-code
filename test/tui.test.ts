import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { stripVTControlCharacters as strip } from 'node:util';
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import { DEFAULTS, merge, normalize } from '../src/config.js';
import { Learning } from '../src/learn.js';
import { Orchestrator } from '../src/orchestrator.js';
import { MemorySource } from '../src/tasks.js';
import { App } from '../src/tui/App.js';

function orchestrator() {
	const cwd = mkdtempSync(join(tmpdir(), 'jc-tui-'));
	const config = normalize(merge(DEFAULTS, { agents: { codex: { enabled: false }, opencode: { enabled: false }, claude: { enabled: false } } }));
	const o = new Orchestrator(config, new MemorySource(cwd, 5), new Learning(config.learning, join(cwd, 'l.json')), cwd);
	return { o, config };
}

test('the dashboard shows completions, hides diffs and tool calls until asked', async () => {
	const { o, config } = orchestrator();
	o.note('done', 'T-0001 done: Add the loader');
	o.note('change', 'src/loader.ts', { detail: '+ export const x = 1' });
	o.note('tool', 'Bash npm test');
	const ui = render(createElement(App, { o, config, depth: 'none', done: new Promise(() => {}) }));
	await sleep(50);
	let frame = strip(ui.lastFrame() ?? '');
	assert.match(frame, /J A R V I S/);
	assert.match(frame, /T-0001 done: Add the loader/);
	assert.doesNotMatch(frame, /src\/loader\.ts/, 'diffs are off by default');
	assert.doesNotMatch(frame, /Bash npm test/, 'tool calls are off by default');

	ui.stdin.write('d');
	await sleep(50);
	frame = strip(ui.lastFrame() ?? '');
	assert.match(frame, /src\/loader\.ts/);
	assert.match(frame, /\+ export const x = 1/);
	ui.stdin.write('t');
	await sleep(50);
	assert.match(strip(ui.lastFrame() ?? ''), /Bash npm test/);
	ui.unmount();
});
