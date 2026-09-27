import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, merge, normalize } from '../src/config.js';
import { Learning } from '../src/learn.js';
import { improveGoal } from '../src/pipeline.js';
import { RunManager, type Improved } from '../src/runs.js';
import { Project } from '../src/store.js';

const demoAgent = fileURLToPath(new URL('../src/demo-agent.js', import.meta.url));

/** A machine of our own (as in tui.test.ts): real agents off, one project that runs the demo agent. */
function machine(pace = '2') {
	const root = mkdtempSync(join(tmpdir(), 'jc-queue-'));
	process.env.JARVIS_CODE_STATE = join(root, 'jc');
	process.env.XDG_CONFIG_HOME = join(root, 'config');
	process.env.JARVIS_CODE_TRUST = 'all';
	mkdirSync(join(root, 'config', 'jarvis-code'), { recursive: true });
	writeFileSync(join(root, 'config', 'jarvis-code', 'config.json'), JSON.stringify({ agents: { claude: { enabled: false }, codex: { enabled: false }, opencode: { enabled: false } } }));
	const proj = join(root, 'alpha');
	mkdirSync(proj);
	const plan = { tasks: [{ title: 'Make q', tier: 'S', acs: [{ text: 'q exists', verify: 'test -f out/q.done' }] }] };
	writeFileSync(
		join(proj, '.jarvis-code.json'),
		JSON.stringify({
			agents: { claude: { kind: 'claude', enabled: true, bin: demoAgent, models: ['claude-fable-5-1'], env: { JC_DEMO_PACE: pace, JC_DEMO_PLAN: JSON.stringify(plan) } } },
			planner: ['claude:claude-fable-5-1'],
			workers: ['claude:claude-fable-5-1'],
			planning: { mode: 'direct' },
		}),
	);
	const config = normalize(merge(DEFAULTS, { agents: { claude: { enabled: false }, codex: { enabled: false }, opencode: { enabled: false } } }));
	const manager = new RunManager(new Learning(config.learning, join(root, 'learning.json')));
	return { proj, manager };
}

const until = async (ok: () => boolean) => {
	for (let i = 0; i < 200 && !ok(); i++) await sleep(50);
	assert.ok(ok(), 'timed out waiting');
};

test('run queue: a goal sent while the run is going waits, then runs next', async (t) => {
	const { proj, manager } = machine();
	t.after(() => manager.stopAll());
	const first = await manager.submit(proj, { goal: 'first' });
	assert.ok(first.run && first.queued === undefined, 'a free project starts at once');
	assert.deepEqual(await manager.submit(proj, { goal: 'second' }), { queued: 1 });
	assert.deepEqual(await manager.submit(proj, { goal: 'third' }), { queued: 2 });
	assert.deepEqual(manager.queued(proj).map((g) => g.goal), ['second', 'third']);
	assert.equal(manager.unqueue(proj, 2)?.goal, 'third');
	assert.equal(manager.unqueue(proj, 5), undefined);
	await assert.rejects(manager.submit(proj, { goal: 'mem', memory: true }), /already has a run/, 'a memory run has no queue');
	await assert.rejects(manager.start(proj, { goal: 'direct' }), /already has a run/, 'start() still refuses a busy project');
	await first.run!.done;
	await until(() => manager.list().length === 2);
	const next = manager.inDir(proj)!;
	assert.equal(next.goal, 'second');
	assert.deepEqual(manager.queued(proj), []);
	await next.done;
	await sleep(100);
	assert.equal(manager.list().length, 2, 'an empty queue starts nothing');
});

test('run queue: a run the user stopped leaves the queue alone', async (t) => {
	const { proj, manager } = machine('300');
	t.after(() => manager.stopAll());
	const { run } = await manager.submit(proj, { goal: 'first' });
	assert.deepEqual(await manager.submit(proj, { goal: 'later' }), { queued: 1 });
	manager.stop(run!);
	await run!.done;
	assert.equal(run!.o.snapshot().phase, 'stopped');
	await sleep(200);
	assert.equal(manager.list().length, 1, 'nothing started after a stop');
	assert.deepEqual(manager.queued(proj).map((g) => g.goal), ['later']);
});

test('run queue: a run held by another process queues the goal', async () => {
	const { proj, manager } = machine();
	const project = new Project(proj);
	project.lock({ pid: process.ppid, by: 'cli' });
	try {
		assert.deepEqual(await manager.submit(proj, { goal: 'wait' }), { queued: 1 });
		assert.equal(manager.list().length, 0);
	} finally {
		project.unlock(process.ppid);
	}
});

test('improve rounds: each round is a deep-planned run on what the last landed, until the cap, a dry round or a stop; queued goals wait for the end', async (t) => {
	const { proj, manager } = machine();
	t.after(() => manager.stopAll());
	const ended: { e: Improved; queue: string[] }[] = [];
	manager.on('improved', (e: Improved) => ended.push({ e, queue: manager.queued(e.dir).map((g) => g.goal) }));
	const first = await manager.improve(proj, { focus: 'q', rounds: 2, minLanded: 1 });
	assert.equal(first.goal, improveGoal('q'));
	assert.equal(first.o.config.planning.mode, 'deep', 'rounds plan deep');
	assert.deepEqual(await manager.submit(proj, { goal: 'after' }), { queued: 1 });
	await until(() => ended.length === 1);
	assert.deepEqual(ended[0], { e: { dir: proj, round: 2, reason: 'rounds' }, queue: ['after'] }, 'the queued goal waits for the loop, not for a round');
	const [one, two] = manager.list();
	assert.equal(two.goal, improveGoal('q', ['Make q']), 'round 2 builds on what round 1 closed');
	assert.equal(two.o.config.planning.mode, 'deep');
	await until(() => manager.list().length === 3);
	assert.equal(manager.inDir(proj)!.goal, 'after', 'then the queue drains');
	assert.equal(manager.inDir(proj)!.o.config.planning.mode, 'direct', 'as a plain goal');
	await manager.inDir(proj)!.done;
	assert.ok(one.finished && two.finished);

	await manager.improve(proj, { rounds: 3, minLanded: 5 });
	await until(() => ended.length === 2);
	assert.deepEqual(ended[1].e, { dir: proj, round: 1, reason: 'dry' });
	await sleep(100);
	assert.equal(manager.list().length, 4, 'a dry round starts no other');

	const slow = machine('300');
	t.after(() => slow.manager.stopAll());
	const stopped: Improved[] = [];
	slow.manager.on('improved', (e: Improved) => stopped.push(e));
	const run = await slow.manager.improve(slow.proj, { rounds: 3, minLanded: 0 });
	slow.manager.stop(run);
	await until(() => stopped.length === 1);
	assert.deepEqual(stopped, [{ dir: slow.proj, round: 1, reason: 'stopped' }]);
	assert.equal(slow.manager.list().length, 1, 'a stop ends the loop');
});
