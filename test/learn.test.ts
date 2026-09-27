import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, merge, type Config } from '../src/config.js';
import { decide } from '../src/downgrade.js';
import { Learning, learnable, pick, routesFor } from '../src/learn.js';

function fresh(now = { t: Date.parse('2026-09-27T00:00:00Z') }) {
	const file = join(mkdtempSync(join(tmpdir(), 'jc-learn-')), 'learning.json');
	return { l: new Learning(DEFAULTS.learning, file, () => now.t), file, now };
}

const config = (over: unknown): Config => merge(DEFAULTS, over);

test('a local model that keeps failing is switched off, and the next route is used', () => {
	const { l } = fresh();
	const cfg = config({
		agents: { claude: { enabled: true }, local: { kind: 'opencode', enabled: true, bin: 'opencode', models: ['ollama/qwen3'], args: [], env: {}, disablePlugins: [], timeoutMin: 60 } },
		workers: ['local:ollama/qwen3', 'claude'],
	});
	const routes = routesFor(cfg, 'worker', (a) => a.enabled === true);
	assert.deepEqual(routes.map((r) => r.id), ['local:ollama/qwen3', 'claude']);
	assert.equal(pick(routes, l, 'priority')!.id, 'local:ollama/qwen3');
	l.recordRoute('local:ollama/qwen3', false);
	l.recordRoute('local:ollama/qwen3', false);
	assert.equal(l.routeOff('local:ollama/qwen3'), false, 'not before minSamples');
	const why = l.recordRoute('local:ollama/qwen3', false);
	assert.match(why ?? '', /0\/3 runs/);
	assert.equal(pick(routes, l, 'priority')!.id, 'claude');
});

test('after the cooldown a switched-off route gets one probe; failing it doubles the wait', () => {
	const { l, now } = fresh();
	for (let i = 0; i < 3; i++) l.recordRoute('r', false);
	const first = Date.parse(l.data.routes.r.disabledUntil!) - now.t;
	now.t += first + 1;
	assert.equal(l.routeOff('r'), false, 'probe allowed');
	l.recordRoute('r', false);
	assert.equal(Date.parse(l.data.routes.r.disabledUntil!) - now.t, first * 2);
	now.t += first * 2 + 1;
	l.recordRoute('r', true);
	assert.equal(l.routeOff('r'), false);
	assert.equal(l.data.routes.r.disabledUntil, undefined);
});

test('a mixed record stays on; best strategy prefers the higher score', () => {
	const { l } = fresh();
	for (const ok of [true, false, true, false, true]) l.recordRoute('a', ok);
	for (const ok of [true, true, true]) l.recordRoute('b', ok);
	assert.equal(l.routeOff('a'), false);
	const routes = [{ id: 'a', agent: 'a' }, { id: 'b', agent: 'b' }];
	assert.equal(pick(routes, l, 'best')!.id, 'b');
	assert.equal(pick(routes, l, 'priority', new Set(['a']))!.id, 'b');
});

test('when every route is off the one cooling down first is probed, not a stall', () => {
	const { l, now } = fresh();
	for (let i = 0; i < 3; i++) l.recordRoute('a', false);
	now.t += 1000;
	for (let i = 0; i < 3; i++) l.recordRoute('b', false);
	assert.equal(pick([{ id: 'b', agent: 'b' }, { id: 'a', agent: 'a' }], l, 'priority')!.id, 'a');
});

test('subagents and MCP tools are learned per orchestrator; core tools never are', () => {
	const { l, file } = fresh();
	for (let i = 0; i < 3; i++) {
		l.recordTool('claude', 'Agent(Explore)', false);
		l.recordTool('claude', 'Bash', false);
	}
	assert.deepEqual(l.blockedTools('claude'), ['Agent(Explore)']);
	assert.deepEqual(l.blockedTools('codex'), [], 'another orchestrator is judged on its own record');
	assert.equal(learnable('Read'), false);
	assert.equal(learnable('mcp__docs__search'), true);
	assert.equal(learnable('WebFetch', ['WebFetch']), false);
	l.save();
	assert.deepEqual(new Learning(DEFAULTS.learning, file).blockedTools('claude'), ['Agent(Explore)']);
});

test('learning off records nothing', () => {
	const l = new Learning({ ...DEFAULTS.learning, enabled: false }, join(mkdtempSync(join(tmpdir(), 'jc-')), 'x.json'));
	for (let i = 0; i < 5; i++) l.recordRoute('r', false);
	assert.equal(l.routeOff('r'), false);
});

test('downgrade policy: sticky refusal re-upgrades to the configured model, up to max', () => {
	const cfg = config({ downgrade: { models: { 'claude-fable*': { action: 'reupgrade', to: 'claude-fable-5-1', max: 2 } } } }).downgrade;
	const ev = { from: 'claude-fable-5', to: 'claude-opus-4-8', reason: 'refusal:cyber', sticky: true };
	assert.deepEqual(decide(cfg, ev, 0), { action: 'reupgrade', model: 'claude-fable-5-1', why: 'refusal:cyber: claude-fable-5 → claude-opus-4-8' });
	assert.equal(decide(cfg, ev, 2).action, 'accept');
	assert.equal(decide(cfg, { ...ev, sticky: false }, 0).action, 'accept');
	assert.equal(decide(cfg, { ...ev, reason: 'consent' }, 0).action, 'accept');
	// Unlisted models take the default policy: back to the model it left.
	assert.deepEqual(decide(DEFAULTS.downgrade, { ...ev, from: 'claude-opus-5-5' }, 0).model, 'claude-opus-5-5');
	const retry = config({ downgrade: { default: { action: 'retry', max: 1 } } }).downgrade;
	assert.equal(decide(retry, ev, 0).action, 'retry');
});
