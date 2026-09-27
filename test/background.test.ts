import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runDetached } from '../src/runs.js';
import { Project } from '../src/store.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const demoAgent = fileURLToPath(new URL('../src/demo-agent.js', import.meta.url));

/** A project whose only agent is the demo, with state and config of its own (no real agent can run). */
function setup(pace: number) {
	const root = mkdtempSync(join(tmpdir(), 'jc-bg-'));
	const env = { ...process.env, JARVIS_CODE_STATE: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config'), JARVIS_CODE_TRUST: 'all' };
	process.env.JARVIS_CODE_STATE = env.JARVIS_CODE_STATE;
	mkdirSync(join(root, 'config', 'jarvis-code'), { recursive: true });
	writeFileSync(join(root, 'config', 'jarvis-code', 'config.json'), JSON.stringify({ agents: { claude: { enabled: false }, codex: { enabled: false }, opencode: { enabled: false } } }));
	const proj = join(root, 'proj');
	mkdirSync(proj);
	writeFileSync(
		join(proj, '.jarvis-code.json'),
		JSON.stringify({ agents: { claude: { kind: 'claude', enabled: true, bin: demoAgent, models: ['claude-fable-5-1'], env: { JC_DEMO_PACE: String(pace) } } }, planner: ['claude:claude-fable-5-1'], workers: ['claude:claude-fable-5-1'], planning: { mode: 'direct' } }),
	);
	const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], { cwd: proj, env, encoding: 'utf8' });
	return { proj, env, run };
}

async function until(what: string, ok: () => boolean, ms = 20_000) {
	for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (ok()) return;
	assert.fail(`timed out waiting for ${what}`);
}

test('background: the run lock holds across processes and a dead run\'s lock is taken over', async () => {
	const { proj, env } = setup(2);
	const p = new Project(proj);
	const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
	p.lock({ pid: other.pid, by: 'cli' });
	assert.throws(() => p.lock({}), new RegExp(`already has a run going \\(pid ${other.pid}`));
	const cliRun = spawn(process.execPath, [cli, 'work', '--plain'], { cwd: proj, env });
	let err = '';
	cliRun.stderr.on('data', (d) => (err += d));
	assert.equal(await new Promise((r) => cliRun.on('exit', r)), 1, 'a second process is refused');
	assert.match(err, /already has a run going/);
	other.kill();
	await new Promise((r) => other.on('exit', r));
	assert.equal(p.lock({}).pid, process.pid, 'a dead run\'s lock is taken over');
	p.unlock();
	assert.equal(p.running(), undefined);
});

test('background: work --detach runs the queue with its log kept in the store; stop ends a background run', async () => {
	const fast = setup(5);
	fast.run('task', 'add', 'Make a', '--ac', 'a exists :: test -f out/a.done');
	const out = fast.run('work', '--detach');
	assert.match(out, /running in the background \(pid \d+\)/);
	const log = out.match(/log: (\S+)/)?.[1];
	assert.ok(log);
	const store = () => Project.open(fast.proj)!;
	await until('the background run to finish', () => store().get('T-0001')?.status === 'done' && !store().running());
	assert.match(readFileSync(log, 'utf8'), /T-0001 done: Make a/);

	const slow = setup(1500);
	slow.run('task', 'add', 'Make b slowly', '--ac', 'b exists :: test -f out/b.done');
	slow.run('work', '--detach');
	const p = () => Project.open(slow.proj)!;
	await until('the background run to take the lock', () => !!p().running());
	assert.match(slow.run('status'), /a run is going: pid \d+ .*in the background, log /);
	assert.match(slow.run('stop'), /stopping the run here/);
	await until('the stopped run to let go', () => !p().running());
	assert.notEqual(p().get('T-0001')?.status, 'done', 'stopped before it finished; the task stays open');
});

test('background: a reused pid is not the run, a detach that fails says why, and old logs are pruned', async () => {
	const { proj } = setup(2);
	const p = new Project(proj);
	const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
	// The lock names a live pid, but a different process start: the run that held it is gone.
	writeFileSync(join(p.dir, 'run.json'), JSON.stringify({ pid: other.pid, started: new Date().toISOString(), by: 'cli', proc: 'not-this-process' }));
	if (process.platform === 'linux') {
		assert.equal(p.running(), undefined);
		assert.equal(p.lock({}).pid, process.pid);
		p.unlock();
	}
	other.kill();
	await assert.rejects(runDetached(proj, ['work', '--no-such-flag']), /the background run did not start: .*no-such-flag/);
	for (let i = 0; i < 25; i++) p.runLog();
	assert.ok(readdirSync(join(p.dir, 'runs')).length <= 20);
});
