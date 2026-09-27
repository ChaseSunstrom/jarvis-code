import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, merge, normalize, onPath, type Config } from '../src/config.js';
import { Learning } from '../src/learn.js';
import { Orchestrator, parsePlan, workerContext } from '../src/orchestrator.js';
import { ForemanSource, MemorySource, type PlannedTask } from '../src/tasks.js';

const demoAgent = fileURLToPath(new URL('../src/demo-agent.js', import.meta.url));
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `jc-${p}-`));

function plan(n: number, verify = (i: number) => `test -f out/t${i}.done`): PlannedTask[] {
	return Array.from({ length: n }, (_, i) => ({
		key: `t${i + 1}`,
		title: `Task ${i + 1}`,
		tier: 'S',
		acs: [{ text: `t${i + 1} exists`, verify: verify(i + 1) }],
		steps: ['do it'],
		depends: i ? [`t${i}`] : [],
	}));
}

function setup(over: unknown, planned: PlannedTask[], env: Record<string, string> = {}) {
	const cwd = tmp('repo');
	const agentEnv = { JC_DEMO_PACE: '2', JC_DEMO_PLAN: JSON.stringify({ tasks: planned }), ...env };
	const config: Config = normalize(
		merge(DEFAULTS, {
			agents: {
				claude: { kind: 'claude', enabled: true, bin: demoAgent, models: ['claude-fable-5-1'], env: agentEnv },
				codex: { enabled: false },
				opencode: { enabled: false },
				local: { kind: 'generic', enabled: true, bin: demoAgent, args: ['--model', '{model}', '{prompt}'], models: ['qwen-flaky'], env: agentEnv },
			},
			planner: ['claude:claude-fable-5-1'],
			...(over as object),
		}),
	);
	const learning = new Learning(config.learning, join(tmp('state'), 'learning.json'));
	return { cwd, config, learning };
}

test('parsePlan: fenced JSON, bare JSON, and garbage', () => {
	assert.equal(parsePlan('Here:\n```json\n{"tasks":[{"title":"A","acs":[{"text":"x","verify":"true"}]}]}\n```')?.[0].title, 'A');
	assert.equal(parsePlan('ok {"tasks":[{"title":"B"}]} bye')?.[0].steps?.length, 0);
	assert.equal(parsePlan('no plan here'), undefined);
	assert.equal(parsePlan('{"tasks":[{"nope":1}]}'), undefined);
});

test('a flaky local model is switched off mid-run and the queue finishes on the next route', async () => {
	const { cwd, config, learning } = setup({ workers: ['local:qwen-flaky', 'claude:claude-fable-5-1'] }, plan(4));
	const source = new MemorySource(cwd, 30);
	const o = new Orchestrator(config, source, learning, cwd);
	const result = await o.run('ship four things');
	const snap = o.snapshot();
	assert.deepEqual(result, { done: 4, blocked: 0, review: 0 });
	assert.ok(snap.activity.some((a) => a.kind === 'learn' && a.text.startsWith('Switched off local:qwen-flaky')));
	const byId = Object.fromEntries(snap.tasks.map((t) => [t.title, t]));
	assert.equal(byId['Task 1'].attempts, 2, 'first try on the flaky model, then claude');
	assert.equal(byId['Task 4'].attempts, 1, 'once switched off, the flaky model is skipped');
	assert.equal(byId['Task 4'].route, 'claude:claude-fable-5-1');
	assert.equal(snap.reactor, 'idle');
	// Diff/tool detail is recorded but kept apart from the completion feed.
	assert.ok(snap.activity.some((a) => a.kind === 'change'));
});

test('a Fable downgrade is switched back mid-task', async () => {
	const { cwd, config, learning } = setup({ workers: ['claude:claude-fable-5-1'] }, plan(1), { JC_DEMO_DOWNGRADE: '1' });
	const o = new Orchestrator(config, new MemorySource(cwd, 30), learning, cwd);
	assert.equal((await o.run('one thing')).done, 1);
	const texts = o.snapshot().activity.filter((a) => a.kind === 'model').map((a) => a.text);
	assert.ok(texts.some((t) => t.includes('claude-fable-5-1 → claude-opus-4-8 (refusal:cyber)')), texts.join('\n'));
	assert.ok(texts.some((t) => t.includes('re-upgrading to claude-fable-5-1')));
	assert.ok(texts.some((t) => t.includes('back on claude-fable-5-1')));
	assert.match(readFileSync(join(cwd, 'out/t1.done'), 'utf8'), /by claude-fable-5-1/);
});

test('a task whose checks never pass is blocked after maxAttempts, and the reactor asks for attention', async () => {
	const { cwd, config, learning } = setup({ workers: ['claude:claude-fable-5-1'], maxAttempts: 2 }, plan(1, () => 'false'));
	const source = new MemorySource(cwd, 30);
	const o = new Orchestrator(config, source, learning, cwd);
	assert.deepEqual(await o.run('impossible'), { done: 0, blocked: 1, review: 0 });
	assert.equal(source.tasks[0].status, 'blocked');
	assert.match(source.tasks[0].reason ?? '', /check failed: false/);
	assert.equal(o.snapshot().reactor, 'attention');
});

test('dependents of a blocked task wait instead of running on a broken base', async () => {
	const { cwd, config, learning } = setup({ workers: ['claude:claude-fable-5-1'], maxAttempts: 1 }, plan(3, (i) => (i === 1 ? 'false' : `test -f out/t${i}.done`)));
	const source = new MemorySource(cwd, 30);
	const o = new Orchestrator(config, source, learning, cwd);
	assert.deepEqual(await o.run('chain'), { done: 0, blocked: 1, review: 0 });
	assert.deepEqual(o.snapshot().tasks.map((t) => t.status), ['blocked', 'queued', 'queued'], 'all planned tasks are listed from the start');
});

test('learned-off tools are named in every worker prompt, plugin or not', () => {
	const ctx = workerContext(['Agent(Explore)', 'mcp__docs__search']);
	assert.match(ctx, /do not use: Agent\(Explore\), mcp__docs__search/);
	assert.doesNotMatch(workerContext([]), /do not use/);
});

test('end to end with real Foreman: planned briefs are worked, verified and closed', { skip: !onPath('fm') && 'fm not on PATH' }, async () => {
	const cwd = tmp('fm-repo');
	execFileSync('git', ['init', '-q'], { cwd });
	const prev = process.env.FOREMAN_STATE;
	process.env.FOREMAN_STATE = tmp('fm-state');
	try {
		execFileSync('fm', ['init'], { cwd, stdio: 'ignore' });
		const { config, learning } = setup({ workers: ['claude:claude-fable-5-1'] }, plan(2));
		const source = new ForemanSource('fm', cwd, 60);
		const o = new Orchestrator(config, source, learning, cwd);
		assert.deepEqual(await o.run('two things'), { done: 2, blocked: 0, review: 0 });
		const ids = o.snapshot().tasks.map((t) => t.id);
		assert.deepEqual(ids, ['T-0001', 'T-0002']);
		for (const id of ids) {
			const t = JSON.parse(execFileSync('fm', ['task', 'show', id, '--json'], { cwd, encoding: 'utf8' }));
			assert.equal(t.status, 'done', `${id} closed in Foreman`);
		}
		assert.equal(JSON.parse(execFileSync('fm', ['queue', '--json'], { cwd, encoding: 'utf8' })).order.length, 0);
	} finally {
		if (prev === undefined) delete process.env.FOREMAN_STATE;
		else process.env.FOREMAN_STATE = prev;
	}
});
