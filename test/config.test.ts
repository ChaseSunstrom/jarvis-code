import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, loadConfig, merge } from '../src/config.js';

function sandbox() {
	const root = mkdtempSync(join(tmpdir(), 'jc-config-'));
	process.env.XDG_CONFIG_HOME = join(root, 'xdg');
	mkdirSync(join(root, 'xdg', 'jarvis-code'), { recursive: true });
	const cwd = join(root, 'repo');
	mkdirSync(cwd);
	return { root, cwd, global: join(root, 'xdg', 'jarvis-code', 'config.json') };
}

test('merge: objects merge, arrays replace', () => {
	assert.deepEqual(merge({ a: { b: 1, c: [1, 2] } }, { a: { c: [3] } }), { a: { b: 1, c: [3] } });
	assert.equal(merge({ a: 1 }, undefined).a, 1);
});

test('defaults: diffs and tool calls are off', () => {
	const { cwd } = sandbox();
	const { config, sources } = loadConfig(cwd);
	assert.equal(config.ui.showDiffs, false);
	assert.equal(config.ui.showTools, false);
	assert.deepEqual(sources, []);
	assert.deepEqual(config.agents.claude.disablePlugins, ['foreman@foreman']);
});

test('project config overrides global, overrides beat both', () => {
	const { cwd, global } = sandbox();
	writeFileSync(global, JSON.stringify({ ui: { fps: 10, showDiffs: true }, maxAttempts: 5 }));
	writeFileSync(join(cwd, '.jarvis-code.json'), JSON.stringify({ ui: { fps: 12 } }));
	const { config, sources } = loadConfig(cwd, { maxAttempts: 2 });
	assert.equal(config.ui.fps, 12);
	assert.equal(config.ui.showDiffs, true);
	assert.equal(config.maxAttempts, 2);
	assert.equal(sources.length, 2);
	assert.equal(config.ui.reactor, DEFAULTS.ui.reactor);
});

test('a custom agent inherits its kind defaults', () => {
	const { cwd } = sandbox();
	writeFileSync(join(cwd, '.jarvis-code.json'), JSON.stringify({ agents: { local: { kind: 'opencode', models: ['ollama/qwen3-coder'] } } }));
	const { config } = loadConfig(cwd);
	assert.equal(config.agents.local.bin, 'opencode');
	assert.equal(config.agents.local.timeoutMin, 60);
	assert.deepEqual(config.agents.local.models, ['ollama/qwen3-coder']);
});

test('bad config is refused with the offending key', () => {
	const { cwd } = sandbox();
	writeFileSync(join(cwd, '.jarvis-code.json'), JSON.stringify({ agents: { x: { kind: 'nope' } } }));
	assert.throws(() => loadConfig(cwd), /agents\.x\.kind/);
	writeFileSync(join(cwd, '.jarvis-code.json'), JSON.stringify({ agents: { g: { kind: 'generic' } } }));
	assert.throws(() => loadConfig(cwd), /agents\.g\.bin/);
	writeFileSync(join(cwd, '.jarvis-code.json'), '{oops');
	assert.throws(() => loadConfig(cwd), /\.jarvis-code\.json/);
});
