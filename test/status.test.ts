import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Project } from '../src/store.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `jc-${p}-`));
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

/** Isolated state + config dirs, agents off: the CLI never starts one. */
function setup() {
	const root = tmp('state');
	process.env.JARVIS_CODE_STATE = join(root, 'jc');
	process.env.XDG_CONFIG_HOME = join(root, 'config');
	mkdirSync(join(root, 'config', 'jarvis-code'), { recursive: true });
	writeFileSync(join(root, 'config', 'jarvis-code', 'config.json'), JSON.stringify({ agents: { claude: { enabled: false }, codex: { enabled: false }, opencode: { enabled: false } } }));
	return tmp('proj');
}

test('status: task show and status print the next step for a stuck task', () => {
	const dir = setup();
	const p = new Project(dir);
	p.add([{ title: 'fix the flaky check' }]);
	p.setStatus('T-0001', 'blocked', 'jarvis-code: check fails the same way on 2 routes (npm test): likely the check or the environment, not the agents');

	const env = { ...process.env, NO_COLOR: '1' };
	const show = execFileSync(process.execPath, [cli, 'task', 'show', 'T-0001'], { cwd: dir, env, encoding: 'utf8' });
	assert.match(show, /next: npm test fails the same way on every route.*jarvis-code task retry T-0001/);

	const status = execFileSync(process.execPath, [cli, 'status'], { cwd: dir, env, encoding: 'utf8' });
	assert.match(status, /next: npm test fails the same way on every route.*jarvis-code task retry T-0001/);
});

test('status: an off route says why, for how long, and how to turn it back on', () => {
	const root = tmp('state');
	process.env.JARVIS_CODE_STATE = join(root, 'jc');
	process.env.XDG_CONFIG_HOME = join(root, 'config');
	mkdirSync(join(root, 'config', 'jarvis-code'), { recursive: true });
	const demoAgent = fileURLToPath(new URL('../src/demo-agent.js', import.meta.url));
	writeFileSync(
		join(root, 'config', 'jarvis-code', 'config.json'),
		JSON.stringify({
			agents: {
				claude: { enabled: false },
				codex: { enabled: false },
				opencode: { enabled: false },
				local: { kind: 'generic', bin: demoAgent, models: ['m'] },
			},
			workers: ['local:m'],
			planner: ['local:m'],
		}),
	);
	const dir = tmp('proj');

	mkdirSync(join(root, 'jc'), { recursive: true });
	const disabledUntil = new Date(Date.now() + 40 * 60_000).toISOString();
	writeFileSync(
		join(root, 'jc', 'learning.json'),
		JSON.stringify({
			routes: { 'local:m': { s: 1, n: 4, runs: 4, ok: 1, disabledUntil, reason: '25% recent success (1/4 runs)' } },
			tools: {},
			kinds: {},
		}),
	);

	const env = { ...process.env, NO_COLOR: '1' };
	const status = execFileSync(process.execPath, [cli, 'status'], { cwd: dir, env, encoding: 'utf8' });
	assert.match(status, /25% recent success \(1\/4 runs\)/);
	assert.match(status, /off for (39|40)m more/);
	assert.match(status, /learn reset local:m/);
});

test('status: a run that died with its lock held is named, with how to resume', async () => {
	const dir = setup();
	const p = new Project(dir);
	const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
	p.lock({ pid: other.pid, by: 'cli' });
	other.kill();
	await new Promise((r) => other.on('exit', r));

	const env = { ...process.env, NO_COLOR: '1' };
	const status = execFileSync(process.execPath, [cli, 'status'], { cwd: dir, env, encoding: 'utf8' });
	assert.match(status, new RegExp(`pid ${other.pid}.*died with its lock held.*jarvis-code work`));

	const all = JSON.parse(execFileSync(process.execPath, [cli, 'status', '--all', '--json'], { cwd: dir, env, encoding: 'utf8' }));
	const row = all.find((r: { path: string }) => r.path === dir);
	assert.equal(row.died, true);
});

test('status: a live run shows its last event, and a quiet one is flagged', async () => {
	const dir = setup();
	const p = new Project(dir);
	const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
	try {
		p.lock({ pid: sleeper.pid, by: 'cli' });
		p.beat({ at: Date.now() - 15 * 60_000, kind: 'tool', text: 'npm test', task: 'T-0001' });

		const env = { ...process.env, NO_COLOR: '1' };
		const status = execFileSync(process.execPath, [cli, 'status'], { cwd: dir, env, encoding: 'utf8' });
		assert.match(status, /quiet for 15m/);
		assert.match(status, /npm test/);

		const all = JSON.parse(execFileSync(process.execPath, [cli, 'status', '--all', '--json'], { cwd: dir, env, encoding: 'utf8' }));
		const row = all.find((r: { path: string }) => r.path === dir);
		assert.ok(row.lastEventAt);
	} finally {
		sleeper.kill();
		await new Promise((r) => sleeper.on('exit', r));
	}
});

test('learn explains a switched-off route or tool: how long, why, and how to turn it back on', () => {
	const dir = setup();
	const until = new Date(Date.now() + 45 * 60_000).toISOString();
	const off = { s: 0.2, n: 4, runs: 4, ok: 0, disabledUntil: until, reason: '10% recent success (0/4 runs)' };
	mkdirSync(process.env.JARVIS_CODE_STATE!, { recursive: true });
	writeFileSync(join(process.env.JARVIS_CODE_STATE!, 'learning.json'), JSON.stringify({ routes: { 'claude:m': off }, tools: { 'claude|Agent(Explore)': off }, kinds: {} }));
	const out = execFileSync(process.execPath, [cli, 'learn'], { cwd: dir, env: { ...process.env }, encoding: 'utf8' });
	assert.match(out, /claude:m .*off for 4[45]m more \(until \d\d:\d\d\): 10% recent success \(0\/4 runs\) · jarvis-code learn reset claude:m turns it back on now/);
	assert.match(out, /claude › Agent\(Explore\) .*jarvis-code learn reset 'claude\|Agent\(Explore\)' turns it back on now/);
	assert.doesNotMatch(out, /\d{4}-\d\d-\d\dT/, 'no raw timestamps');
});
