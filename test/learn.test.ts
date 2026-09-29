import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, merge, type Config } from '../src/config.js';
import { decide } from '../src/downgrade.js';
import { choose, kindSummary, Learning, learnable, pick, routesFor, type Role } from '../src/learn.js';

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
	// The reload reads the fixture clock too: on the real one the 24 h cooldown ran out on 2026-09-28.
	const { l, file, now } = fresh();
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
	assert.deepEqual(new Learning(DEFAULTS.learning, file, () => now.t).blockedTools('claude'), ['Agent(Explore)']);
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

test('task type: a route off for one type still takes others; best ranks by the type\'s own record', () => {
	const l = new Learning({ ...DEFAULTS.learning, minSamples: 3, disableBelow: 0.35 }, join(mkdtempSync(join(tmpdir(), 'jc-kind-')), 'l.json'));
	const r = (id: string) => ({ id, agent: id.split(':')[0], model: id.split(':')[1] });
	const routes = [r('local:cheap'), r('claude:strong')];
	for (let i = 0; i < 4; i++) l.recordKind('local:cheap', 'SECURITY', false);
	assert.equal(choose(routes, l, 'priority', new Set(), { type: 'SECURITY' })?.route.id, 'claude:strong', 'off for SECURITY');
	assert.equal(choose(routes, l, 'priority', new Set(), { type: 'CLEAN' })?.route.id, 'local:cheap', 'still fine for CLEAN');
	for (let i = 0; i < 4; i++) {
		l.recordKind('local:cheap', 'FIX', true);
		l.recordKind('claude:strong', 'FIX', false);
		l.recordRoute('claude:strong', true);
	}
	const best = choose(routes, l, 'best', new Set(), { type: 'FIX' });
	assert.equal(best?.route.id, 'local:cheap');
	assert.match(best?.why ?? '', /^best for FIX: \d+% of 4$/);
	assert.deepEqual(l.forgive('local:cheap@SECURITY'), ['local:cheap@SECURITY']);
	assert.equal(choose(routes, l, 'priority', new Set(), { type: 'SECURITY' })?.route.id, 'local:cheap');
});

test('task type: escalate starts small tasks cheap, big and security tasks strong, and climbs on failure', () => {
	const l = new Learning(DEFAULTS.learning, join(mkdtempSync(join(tmpdir(), 'jc-esc-')), 'l.json'));
	const r = (id: string) => ({ id, agent: id.split(':')[0], model: id.split(':')[1] });
	const routes = [r('local:cheap'), r('codex:mid'), r('claude:strong')];
	const first = (task: { tier: string; type: string }, failed: string[] = []) => choose(routes, l, 'escalate', new Set(failed), task);
	assert.deepEqual([first({ tier: 'S', type: 'FIX' })?.route.id, first({ tier: 'S', type: 'FIX' })?.why], ['local:cheap', 'S task: starts cheapest']);
	assert.equal(first({ tier: 'M', type: 'FEATURE' })?.route.id, 'codex:mid');
	assert.deepEqual([first({ tier: 'L', type: 'FEATURE' })?.route.id, first({ tier: 'S', type: 'SECURITY' })?.route.id], ['claude:strong', 'claude:strong']);
	assert.deepEqual([first({ tier: 'S', type: 'FIX' }, ['local:cheap'])?.route.id, first({ tier: 'S', type: 'FIX' }, ['local:cheap'])?.why], ['codex:mid', 'escalating after a failed attempt']);
});

test('task type: kindSummary lists each type record of a route', () => {
	const { l } = fresh();
	assert.equal(kindSummary(l, 'claude'), '', 'no record yet');
	for (const ok of [true, true, true, false]) l.recordKind('claude', 'FIX', ok);
	for (const ok of [true, true, true, true, true, false]) l.recordKind('claude', 'FEATURE', ok);
	for (const ok of [true, false]) l.recordKind('claude', 'CLEAN', ok);
	l.recordKind('claude', 'PERF', true);
	l.recordKind('claude', 'SECURITY', false);
	assert.equal(kindSummary(l, 'claude'), 'FEATURE 5/6, FIX 3/4, CLEAN 1/2, PERF 1/1', 'most runs first, at most 4');
});

test('routes resolve: using, the task type (workers only), the role, the legacy lists, default, then every enabled agent', () => {
	const agents = { claude: { enabled: true }, codex: { enabled: true }, opencode: { enabled: false } };
	const ids = (cfg: Config, role: Role, opts: { type?: string; using?: string[] } = {}) => routesFor(cfg, role, (a) => a.enabled === true, opts).map((r) => r.id);
	const cfg = config({
		agents,
		planner: ['codex'],
		workers: ['claude', 'codex'],
		routes: { SECURITY: ['codex'], FIX: ['opencode'], critic: ['claude'], brainstorm: ['nope'], default: ['claude'] },
	});
	assert.deepEqual(ids(cfg, 'worker', { using: ['opencode', 'claude', 'codex'], type: 'SECURITY' }), ['claude', 'codex'], 'using first, disabled dropped');
	assert.deepEqual(ids(cfg, 'worker', { type: 'security' }), ['codex'], 'the task type');
	assert.deepEqual(ids(cfg, 'worker', { type: 'FIX' }), ['claude', 'codex'], 'a disabled type route falls through to the workers list');
	assert.deepEqual(ids(cfg, 'critic', { type: 'SECURITY' }), ['claude'], 'the role; a type route is for workers only');
	assert.deepEqual(ids(cfg, 'planner', { type: 'FIX' }), ['codex'], 'legacy planner list');
	assert.deepEqual(ids(cfg, 'brainstorm'), ['codex', 'claude'], 'an unknown agent falls through to both lists, deduped');
	assert.deepEqual(ids(cfg, 'reviewer'), ['codex', 'claude']);
	assert.deepEqual(ids(config({ agents, workers: ['claude'], routes: { workers: ['codex'] } }), 'worker'), ['codex'], 'routes.workers beats the workers list');
	assert.deepEqual(ids(config({ agents, routes: { default: ['codex'] } }), 'promptWriter'), ['codex'], 'default');
	assert.deepEqual(ids(config({ agents, routes: { default: ['opencode'] } }), 'worker'), ['claude', 'codex'], 'every enabled agent last');
});
