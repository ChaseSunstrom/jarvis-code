import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Project } from '../src/store.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `jc-mcp-${p}-`));

/** `jarvis-code mcp` in `cwd` with isolated state and every real agent off; `call` sends one request and waits for its answer. */
function server(cwd: string, env: Record<string, string> = {}) {
	const child = spawn(process.execPath, [cli, 'mcp'], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
	const waiting = new Map<number, (r: any) => void>();
	createInterface({ input: child.stdout! }).on('line', (l) => {
		const m = JSON.parse(l);
		waiting.get(m.id)?.(m);
	});
	let id = 0;
	const call = (method: string, params: unknown = {}) =>
		new Promise<any>((resolve) => {
			waiting.set(++id, resolve);
			child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
		});
	const tool = async (name: string, args: Record<string, unknown> = {}) => {
		const r = await call('tools/call', { name, arguments: args });
		return { text: r.result.content.map((c: { text: string }) => c.text).join('\n') as string, error: !!r.result.isError };
	};
	return { child, call, tool, notify: (method: string) => child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n') };
}

function machine() {
	const root = tmp('state');
	const env = { JARVIS_CODE_STATE: join(root, 'jc'), XDG_CONFIG_HOME: join(root, 'config'), JARVIS_CODE_RUN: '', NO_COLOR: '1' };
	mkdirSync(join(root, 'config', 'jarvis-code'), { recursive: true });
	writeFileSync(join(root, 'config', 'jarvis-code', 'config.json'), JSON.stringify({ agents: { claude: { enabled: false }, codex: { enabled: false }, opencode: { enabled: false } } }));
	process.env.JARVIS_CODE_STATE = env.JARVIS_CODE_STATE;
	return { env, proj: tmp('proj') };
}

test('mcp: initialize, the tool list with read-only hints, and every tool against the project store', async (t) => {
	const { env, proj } = machine();
	const p = new Project(proj);
	p.add([{ title: 'Wire the parser', acs: [{ text: 'parses', verify: 'npm test' }] }]);
	p.setStatus('T-0001', 'blocked', 'jarvis-code: check failed: npm test');
	p.recordRun({ at: '2026-09-29T10:00:00.000Z', minutes: 2, goal: 'an earlier goal', total: 1, done: 0, blocked: 1, review: 0, cost: 0.3, planning: 0.1, agents: 3, stopped: false });
	const s = server(proj, env);
	t.after(() => s.child.kill());

	const init = await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
	assert.equal(init.result.protocolVersion, '2025-06-18', 'the client\'s version, echoed');
	assert.deepEqual(init.result.capabilities, { tools: {} });
	assert.equal(init.result.serverInfo.name, 'jarvis-code');
	s.notify('notifications/initialized');
	assert.deepEqual((await s.call('ping')).result, {});
	assert.equal((await s.call('no/such/method')).error.code, -32601);

	const { tools } = (await s.call('tools/list')).result;
	const names = tools.map((x: { name: string }) => x.name);
	assert.deepEqual(names, ['status', 'tasks', 'task_show', 'history', 'queue_goal', 'add_task', 'tell']);
	const hint = (n: string) => tools.find((x: { name: string }) => x.name === n).annotations.readOnlyHint;
	assert.deepEqual(names.map(hint), [true, true, true, true, false, false, false], 'hosts ask before the changing tools');
	for (const x of tools) assert.equal(x.inputSchema.type, 'object');

	let r = await s.tool('status');
	assert.match(r.text, /1 blocked/);
	assert.match(r.text, /T-0001 FEATURE S +Wire the parser.*check failed: npm test/);
	assert.match(r.text, /next: /, 'the step that unsticks it');
	r = await s.tool('add_task', { title: 'Document the parser', type: 'CLEAN' });
	assert.match(r.text, /added T-0002 Document the parser/);
	assert.equal(p.get('T-0002')?.type, 'CLEAN');
	assert.match((await s.tool('tasks')).text, /T-0002 CLEAN S +Document the parser/);
	r = await s.tool('tell', { id: 't-0001', note: 'the fixture moved to test/fixtures' });
	assert.match(r.text, /T-0001: note kept/);
	assert.equal(p.get('T-0001')?.hint, 'the fixture moved to test/fixtures');
	r = await s.tool('task_show', { id: 'T-0001' });
	assert.match(r.text, /Wire the parser \(FEATURE S, blocked\)/);
	assert.match(r.text, /AC1 parses +\$ npm test/);
	assert.match(r.text, /hint: the fixture moved/);
	assert.match((await s.tool('history')).text, /0\/1 .*an earlier goal/);
	r = await s.tool('task_show', { id: 'T-0404' });
	assert.ok(r.error);
	assert.match(r.text, /no task T-0404/);

	// A run holds the project (this test's own process stands in for it): the goal waits for it.
	p.lock({ goal: 'the current goal', by: 'cockpit' });
	r = await s.tool('queue_goal', { goal: 'add a --json flag' });
	assert.match(r.text, /queued #1 .*runs after the current run/);
	assert.deepEqual(p.goals().map((g) => g.goal), ['add a --json flag']);
	r = await s.tool('queue_goal', { goal: '--help' });
	assert.ok(r.error, 'a goal that reads as an option is refused');
	assert.ok((await s.tool('queue_goal', {})).error, 'a goal is required');
	p.unlock();
	assert.ok((await s.tool('nope')).error);

	// The session's project and what is inside it, nothing else.
	const elsewhere = tmp('other');
	for (const dir of [elsewhere, '..', '../..', '/'])
		for (const name of ['queue_goal', 'add_task', 'status']) {
			r = await s.tool(name, { dir, goal: 'x', title: 'x' });
			assert.ok(r.error && /this project or a directory inside it/.test(r.text), `${name} in ${dir}: ${r.text}`);
		}
	assert.equal(Project.open(elsewhere), undefined, 'nothing was written elsewhere');
	mkdirSync(join(proj, 'pkg'));
	assert.match((await s.tool('add_task', { dir: 'pkg', title: 'inside is fine' })).text, /added T-0001 inside is fine/);

	// Sizes are capped before anything is stored.
	r = await s.tool('add_task', { title: 'x'.repeat(5000) });
	assert.equal(p.get('T-0003')?.title.length, 200);
	await s.tool('tell', { id: 'T-0001', note: 'y'.repeat(5000) });
	assert.ok(p.get('T-0001')!.hint!.length < 1100, 'a note is capped');
	p.lock({ goal: 'the current goal', by: 'cockpit' });
	await s.tool('queue_goal', { goal: 'z'.repeat(5000) });
	assert.equal(p.goals().at(-1)!.goal.length, 2000, 'a goal is capped');
	p.unlock();

	// A JSON-RPC batch gets an error, not silence.
	const batch = await new Promise<any>((resolve) => {
		s.child.stdout!.once('data', (d) => resolve(JSON.parse(String(d).split('\n')[0])));
		s.child.stdin!.write(JSON.stringify([{ jsonrpc: '2.0', id: 99, method: 'ping' }]) + '\n');
	});
	assert.equal(batch.error.code, -32600);
});

test('mcp: inside a jarvis-code worker it offers no tools and refuses every call', async (t) => {
	const { env, proj } = machine();
	const s = server(proj, { ...env, JARVIS_CODE_RUN: '1', JARVIS_CODE_ROLE: 'worker' });
	t.after(() => s.child.kill());
	await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
	assert.deepEqual((await s.call('tools/list')).result.tools, []);
	const r = await s.tool('add_task', { title: 'sneak one in' });
	assert.ok(r.error);
	assert.match(r.text, /jarvis-code owns the queue/);
	assert.equal(Project.open(proj), undefined, 'nothing was written');
});
