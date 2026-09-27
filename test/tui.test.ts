import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters as strip } from 'node:util';
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import { DEFAULTS, merge, normalize } from '../src/config.js';
import { Learning } from '../src/learn.js';
import { RunManager } from '../src/runs.js';
import { Project, type StoredTask } from '../src/store.js';
import { Cockpit, matchCommands } from '../src/tui/Cockpit.js';
import { Feed, Header, Tasks } from '../src/tui/parts.js';
import { Reports, TaskDetail, Workers } from '../src/tui/parts.js';

const demoAgent = fileURLToPath(new URL('../src/demo-agent.js', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

/** A machine of our own: jarvis-code state with one project that has tasks. */
function machine() {
	const root = mkdtempSync(join(tmpdir(), 'jc-cockpit-'));
	process.env.JARVIS_CODE_STATE = join(root, 'jc');
	// Runs load their config from disk: a global config with every real agent off means a goal
	// typed by mistake can never reach a real \`claude\`/\`codex\`/\`opencode\` on PATH. Projects
	// that should run enable the demo agent in their own .jarvis-code.json.
	process.env.XDG_CONFIG_HOME = join(root, 'config');
	// The fixture projects name the demo agent in their own config: trusted, as a user would.
	process.env.JARVIS_CODE_TRUST = 'all';
	mkdirSync(join(root, 'config', 'jarvis-code'), { recursive: true });
	writeFileSync(join(root, 'config', 'jarvis-code', 'config.json'), JSON.stringify({ agents: { claude: { enabled: false }, codex: { enabled: false }, opencode: { enabled: false } } }));
	const proj = join(root, 'alpha');
	mkdirSync(proj);
	new Project(proj).add([{ title: 'Wire the parser' }]);
	const config = normalize(merge(DEFAULTS, { agents: { claude: { enabled: false }, codex: { enabled: false }, opencode: { enabled: false } } }));
	const manager = new RunManager(new Learning(config.learning, join(root, 'learning.json')));
	return { root, proj, config, manager };
}

const frame = (ui: { lastFrame(): string | undefined }) => strip(ui.lastFrame() ?? '');
const type = async (ui: { stdin: { write(s: string): void } }, s: string) => {
	for (const ch of s) ui.stdin.write(ch);
	await sleep(30);
};

test('home lists stored projects and the slash menu completes commands', async (t) => {
	const { config, manager, root } = machine();
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: root }));
	t.after(() => ui.unmount());
	await sleep(80);
	assert.match(frame(ui), /P R O J E C T S/);
	assert.match(frame(ui), /alpha/);
	assert.match(frame(ui), /1 open|Wire the parser/);
	await type(ui, '/he');
	assert.match(frame(ui), /\/help\s+what every command does/);
	ui.stdin.write('\t');
	await sleep(30);
	ui.stdin.write('\r');
	await sleep(60);
	assert.match(frame(ui), /C O M M A N D S/);
	assert.deepEqual(matchCommands('/st').map((c) => c.name), ['stop']);
	ui.stdin.write('\x1b');
	await sleep(30);
	ui.stdin.write('a\tb\x07c');
	await sleep(30);
	assert.match(frame(ui), /❯ a bc▏/, 'a pasted chunk keeps no raw control characters');
	ui.stdin.write('\x1b');
	await sleep(30);
	mkdirSync(join(root, 'beta'));
	await type(ui, '/add beta');
	ui.stdin.write('\r');
	await sleep(60);
	assert.ok(frame(ui).includes(`added ${join(root, 'beta')}`), 'a relative path is taken from the cockpit\'s directory, not the process\'s');
	assert.equal(manager.list().length, 0, 'no run was started');
});

test('cockpit: the home header counts what needs you across projects', async (t) => {
	const { config, manager, root } = machine();
	mkdirSync(join(root, 'beta'));
	const b = new Project(join(root, 'beta'));
	const [added] = b.add([{ title: 'Fix the widget' }]);
	b.setStatus(added.id, 'blocked', 'stuck');
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: root }));
	t.after(() => ui.unmount());
	await sleep(80);
	assert.match(frame(ui), /projects? · 1 need you/);
});

test('cockpit: Tab completes /task verbs', async (t) => {
	const { config, manager, root } = machine();
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: root }));
	t.after(() => ui.unmount());
	await sleep(80);
	await type(ui, '/task ap');
	ui.stdin.write('\t');
	await sleep(30);
	assert.match(frame(ui), /❯ \/task approve ▏/);
	ui.stdin.write('\x1b');
	await sleep(30);
	await type(ui, '/task bu');
	ui.stdin.write('\t');
	await sleep(30);
	assert.match(frame(ui), /❯ \/task bump ▏/);
	ui.stdin.write('\x1b');
	await sleep(30);
	await type(ui, '/ta');
	ui.stdin.write('\t');
	await sleep(30);
	assert.match(frame(ui), /❯ \/task ▏/);
});

test('cockpit: the home detail shows lifetime spend', async (t) => {
	const { config, manager, proj } = machine();
	new Project(proj).update('T-0001', (t) => {
		t.attempts.push({ at: new Date().toISOString(), route: 'claude:claude-fable-5-1', ok: true, costUsd: 0.42 });
	});
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: proj }));
	t.after(() => ui.unmount());
	await sleep(80);
	assert.match(frame(ui), /\$0\.42 spent/);
});

test('a typed goal starts a run in the selected project; diffs and tool calls stay hidden until asked', async (t) => {
	const { config, manager, proj } = machine();
	writeFileSync(
		join(proj, '.jarvis-code.json'),
		JSON.stringify({
			agents: { claude: { kind: 'claude', enabled: true, bin: demoAgent, models: ['claude-fable-5-1'], env: { JC_DEMO_PACE: '2' } } },
			planner: ['claude:claude-fable-5-1'],
			workers: ['claude:claude-fable-5-1'],
		}),
	);
	const ui = render(createElement(Cockpit, { manager, config: { ...config }, depth: 'none', cwd: proj }));
	t.after(() => {
		ui.unmount();
		return manager.stopAll();
	});
	await sleep(50);
	await type(ui, 'modernize settings');
	ui.stdin.write('\r');
	for (let i = 0; i < 100 && !(manager.list()[0]?.finished); i++) await sleep(50);
	const run = manager.list()[0];
	assert.ok(run?.finished, 'the run finished');
	assert.equal(run.dir, proj);
	await sleep(300);
	let f = frame(ui);
	assert.match(f, /done: /, 'completions show');
	assert.doesNotMatch(f, /› Bash|\+ const a/, 'diffs and tool calls are hidden by default');
	await type(ui, '/diffs');
	ui.stdin.write('\r');
	await sleep(60);
	await type(ui, '/tools');
	ui.stdin.write('\r');
	await sleep(300);
	f = frame(ui);
	assert.match(f, /diffs · tools/);
	assert.match(f, /› Bash|\+ const a/);
});

test('two projects run at once', async () => {
	const { config, manager, root } = machine();
	const dirs = ['one', 'two'].map((n) => {
		const d = join(root, n);
		mkdirSync(d);
		writeFileSync(
			join(d, '.jarvis-code.json'),
			JSON.stringify({
				agents: { claude: { kind: 'claude', enabled: true, bin: demoAgent, models: ['claude-fable-5-1'], env: { JC_DEMO_PACE: '30' } } },
				planner: ['claude:claude-fable-5-1'],
				workers: ['claude:claude-fable-5-1'],
			}),
		);
		return d;
	});
	void config;
	const runs = await Promise.all(dirs.map((d) => manager.start(d, { goal: 'go', memory: true })));
	assert.equal(manager.active().length, 2, 'concurrent runs');
	await assert.rejects(manager.start(dirs[0], { goal: 'again' }), /already has a run/);
	await Promise.all(runs.map((r) => r.done));
	for (const r of runs) assert.ok(r.o.snapshot().tasks.every((t) => t.status === 'done'));
});

test('the agents panel fits its height: two rows each, then one, then a count', () => {
	const w = (i: number) => ({ key: `idea:${i}`, task: `ideas:lens ${i}`, title: `lens ${i}, round 1`, route: 'claude:m', phase: 'planning' as const, started: Date.now(), tools: 0, last: `reading ${i}`, cost: 0 });
	const rows = (n: number, height: number) => {
		const ui = render(createElement(Workers, { workers: Array.from({ length: n }, (_, i) => w(i)), t: 0, height }));
		const f = frame(ui).split('\n');
		ui.unmount();
		return f;
	};
	const roomy = rows(2, 6);
	assert.equal(roomy.length, 5);
	assert.match(roomy[2], /└ reading 0/);
	const compact = rows(4, 6);
	assert.equal(compact.length, 5);
	assert.match(compact[1], /lens 0, round 1 claude:m\s+reading 0/);
	const many = rows(9, 6);
	assert.equal(many.length, 6);
	assert.match(many.at(-1)!, /… 5 more/);
});

test('reports pane: lists reports and says when there are none', () => {
	const reports = [{ file: '/p/research/report-a.md', at: '2026-01-01T00:00:00.000Z', summary: '2026-01-01T00:00:00.000Z · alpha · 1/1 done · $0.10' }];
	const withReports = render(createElement(Reports, { reports, height: 10 }));
	const f = frame(withReports);
	withReports.unmount();
	assert.match(f, /reports/);
	assert.match(f, /2026-01-01 00:00/);
	assert.match(f, /1\/1 done/);
	assert.match(f, /report-a\.md/);

	const empty = render(createElement(Reports, { reports: [], height: 10 }));
	const g = frame(empty);
	empty.unmount();
	assert.match(g, /no reports yet/);
});

test('cockpit: /reports lists past run reports', async (t) => {
	const { config, manager, proj } = machine();
	new Project(proj).research('report-a', '# jarvis-code run: x\n\n2026-01-01T00:00:00.000Z · alpha · 1/1 done · $0.10\n');
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: proj }));
	t.after(() => ui.unmount());
	await sleep(80);
	await type(ui, '/reports');
	ui.stdin.write('\r');
	await sleep(60);
	let f = frame(ui);
	assert.match(f, /reports/);
	assert.match(f, /1\/1 done/);
	// Read when the pane opens, not on every render (the cockpit renders at its fps while animating).
	new Project(proj).research('report-b', '# jarvis-code run: y\n\n2026-01-02T00:00:00.000Z · alpha · 2/2 done · $0.20\n');
	await type(ui, 'x');
	assert.doesNotMatch(frame(ui), /2\/2 done/);
	ui.stdin.write('\x1b');
	await sleep(60);
	ui.stdin.write('\x1b');
	await sleep(60);
	f = frame(ui);
	assert.doesNotMatch(f, /1\/1 done/);
	await type(ui, '/reports');
	ui.stdin.write('\r');
	await sleep(60);
	assert.match(frame(ui), /2\/2 done/);
});

test('task detail: acceptance checks, attempts with cost, and lessons render', () => {
	const task: StoredTask = {
		id: 'T-0004',
		title: 'Add TaskDetail pane',
		type: 'FEATURE',
		tier: 'S',
		status: 'blocked',
		acs: [
			{ text: 'renders the pane', verify: 'npm test', checked: true },
			{ text: 'fits the height', verify: 'node scripts/verify.mjs', checked: false },
		],
		steps: [],
		depends: ['T-0001'],
		source: 'plan',
		reason: 'waiting on review',
		attempts: [{ at: '2026-01-02T03:04:00.000Z', route: 'claude:claude-fable-5-1', ok: false, error: 'tsc failed', costUsd: 0.3 }],
		evidence: [],
		lessons: ['keep the label glyphs consistent with task show'],
		created: '2026-01-01T00:00:00.000Z',
		updated: '2026-01-02T00:00:00.000Z',
	};
	const tall = render(createElement(TaskDetail, { task, height: 20 }));
	const f = frame(tall);
	tall.unmount();
	assert.match(f, /\$ npm test/);
	assert.match(f, /tsc failed/);
	assert.match(f, /\$0\.30/);
	assert.match(f, /keep the label glyphs consistent with task show/);

	const short = render(createElement(TaskDetail, { task, height: 3 }));
	const g = frame(short);
	short.unmount();
	assert.match(g, /… \d+ more/);
});

test('task detail: failed attempts show their cause, the retry hint and the newest attempts', () => {
	const task: StoredTask = {
		id: 'T-0005',
		title: 'Fix flaky check',
		type: 'FIX',
		tier: 'S',
		status: 'blocked',
		acs: [],
		steps: [],
		depends: [],
		source: 'plan',
		hint: 'run npm ci first',
		attempts: [
			{ at: '2026-01-01T00:00:00.000Z', route: 'claude:claude-fable-5-1', ok: false, error: 'oldest failure, should not render', cause: 'agent' },
			{ at: '2026-01-01T01:00:00.000Z', route: 'claude:claude-fable-5-1', ok: false, error: 'second failure', cause: 'bad-check' },
			{ at: '2026-01-01T02:00:00.000Z', route: 'claude:claude-fable-5-1', ok: false, error: 'third failure', cause: 'missing-context' },
			{ at: '2026-01-01T03:00:00.000Z', route: 'claude:claude-fable-5-1', ok: false, error: 'fourth failure', cause: 'env', costUsd: 0.1 },
			{ at: '2026-01-01T04:00:00.000Z', route: 'claude:claude-fable-5-1', ok: false, error: 'fifth failure', cause: 'env', costUsd: 0.2 },
		],
		evidence: [],
		lessons: [],
		created: '2026-01-01T00:00:00.000Z',
		updated: '2026-01-01T04:00:00.000Z',
	};
	const ui = render(createElement(TaskDetail, { task, height: 20 }));
	const f = frame(ui);
	ui.unmount();
	assert.match(f, /\[env\]/);
	assert.match(f, /hint: run npm ci first/);
	assert.match(f, /2 earlier attempts/);
	assert.doesNotMatch(f, /oldest failure, should not render/);
	assert.match(f, /\$0\.30/);
});

test('task detail: preflight counts show and a check that passed before any change is flagged', () => {
	const task: StoredTask = {
		id: 'T-0027',
		title: 'Show preflight counts',
		type: 'FEATURE',
		tier: 'S',
		status: 'blocked',
		acs: [],
		steps: [],
		depends: [],
		source: 'plan',
		attempts: [
			{ at: '2026-01-01T00:00:00.000Z', route: 'claude:claude-fable-5-1', ok: false, error: 'first failure', preflight: { pass: 1, fail: 1 } },
			{ at: '2026-01-01T01:00:00.000Z', route: 'claude:claude-fable-5-1', ok: false, error: 'second failure', preflight: { pass: 0, fail: 2 } },
		],
		evidence: [],
		lessons: [],
		created: '2026-01-01T00:00:00.000Z',
		updated: '2026-01-01T01:00:00.000Z',
	};
	const ui = render(createElement(TaskDetail, { task, height: 20 }));
	const f = frame(ui);
	ui.unmount();
	assert.match(f, /preflight 1 pass · 1 fail/);
	assert.match(f, /passed before any change/);
	assert.doesNotMatch(f, /preflight 0 pass · 2 fail.*passed before any change/s);
});

test('queue control: /task and /trust change the store and learning; status --all --json sees every project', async (t) => {
	const { config, manager, proj } = machine();
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: proj }));
	t.after(() => ui.unmount());
	await sleep(50);
	const run = async (line: string) => {
		await type(ui, line);
		ui.stdin.write('\r');
		await sleep(60);
		return frame(ui);
	};
	const store = () => Project.open(proj)!;
	assert.match(await run('/task add FIX: parser crashes on empty input'), /added T-0002 parser crashes on empty input/);
	assert.deepEqual([store().get('T-0002')?.type, store().get('T-0002')?.status], ['FIX', 'planned']);
	await run('/task drop T-0002 duplicate');
	assert.deepEqual([store().get('T-0002')?.status, store().get('T-0002')?.reason], ['dropped', 'duplicate']);
	assert.match(await run('/task retry t-0002'), /T-0002 back in the queue/);
	assert.match(await run('/task approve T-0001'), /T-0001 is planned, not waiting for review/);
	store().setStatus('T-0001', 'review', 'no verify command');
	await run('/task approve T-0001');
	assert.equal(store().get('T-0001')?.status, 'done');
	for (let i = 0; i < 4; i++) manager.learning.recordTool('claude', 'Agent(Explore)', false);
	assert.match(await run('/trust Agent(Explore)'), /forgot claude\|Agent\(Explore\)/);
	assert.equal(manager.learning.data.tools['claude|Agent(Explore)'], undefined);
	const out = execFileSync(process.execPath, [cli, 'status', '--all', '--json'], { env: { ...process.env }, encoding: 'utf8' });
	const alpha = (JSON.parse(out) as { path: string; planned: number; done: number }[]).find((p) => p.path === proj);
	assert.deepEqual([alpha?.planned, alpha?.done], [1, 1]);
});

test('prompt history: Ctrl+P/Ctrl+N recall earlier goals and commands', async (t) => {
	const { config, manager, proj } = machine();
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: proj }));
	t.after(() => ui.unmount());
	await sleep(50);
	await type(ui, '/task show T-0001');
	ui.stdin.write('\r');
	await sleep(60);
	await type(ui, '/task defer later');
	ui.stdin.write('\r');
	await sleep(60);
	ui.stdin.write('\x10'); // Ctrl+P: newest entry first
	await sleep(30);
	assert.match(frame(ui), /❯ \/task defer later▏/);
	ui.stdin.write('\x10'); // Ctrl+P again: one entry further back
	await sleep(30);
	assert.match(frame(ui), /❯ \/task show T-0001▏/);
	ui.stdin.write('\x0e'); // Ctrl+N: back to the newer entry
	await sleep(30);
	assert.match(frame(ui), /❯ \/task defer later▏/);
	ui.stdin.write('\x0e'); // Ctrl+N past the newest: back to a blank, placeholder prompt
	await sleep(30);
	assert.match(frame(ui), /❯ a goal for alpha, or \/ for commands▏/);
});

test('cockpit: task show opens a task detail and Esc closes it', async (t) => {
	const { config, manager, proj } = machine();
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: proj }));
	t.after(() => ui.unmount());
	await sleep(50);
	await type(ui, '/task show T-0001');
	ui.stdin.write('\r');
	await sleep(60);
	let f = frame(ui);
	assert.match(f, /T A S K/);
	assert.match(f, /Wire the parser/);
	assert.match(f, /P R O J E C T S/);
	ui.stdin.write('\x1b');
	await sleep(30);
	f = frame(ui);
	assert.match(f, /A L P H A/, 'the project Detail pane is back');
	await type(ui, '/task show T-0099');
	ui.stdin.write('\r');
	await sleep(60);
	assert.match(frame(ui), /no task T-0099 in alpha/);
});

test('cockpit: with a task open the footer names its verbs', async (t) => {
	const { config, manager, proj } = machine();
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: proj }));
	t.after(() => ui.unmount());
	await sleep(50);
	await type(ui, '/task show T-0001');
	ui.stdin.write('\r');
	await sleep(60);
	assert.match(frame(ui), /\/task retry \[why\] · approve · drop · bump · Esc close/);
	ui.stdin.write('\x1b');
	await sleep(30);
	assert.match(frame(ui), /↑↓ select · Enter open · \/help/);
});

test('cockpit: task verbs without an id act on the open task', async (t) => {
	const { config, manager, proj } = machine();
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: proj }));
	t.after(() => ui.unmount());
	await sleep(50);
	await type(ui, '/task show T-0001');
	ui.stdin.write('\r');
	await sleep(60);
	await type(ui, '/task defer later');
	ui.stdin.write('\r');
	await sleep(60);
	const t1 = Project.open(proj)!.get('T-0001')!;
	assert.deepEqual([t1.status, t1.reason], ['deferred', 'later']);
	assert.match(frame(ui), /deferred/);
	ui.stdin.write('\x1b');
	await sleep(30);
	await type(ui, '/task retry');
	ui.stdin.write('\r');
	await sleep(60);
	assert.match(frame(ui), /no task open to act on/);
});

test('cockpit: /task bump moves a task to the front of the queue', async (t) => {
	const { config, manager, proj } = machine();
	new Project(proj).add([{ title: 'Later one' }]);
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: proj }));
	t.after(() => ui.unmount());
	await sleep(50);
	await type(ui, '/task bump T-0002');
	ui.stdin.write('\r');
	await sleep(60);
	assert.equal(Project.open(proj)!.queue()[0].id, 'T-0002');
	assert.match(frame(ui), /T-0002 goes next/);
	await type(ui, '/task show T-0002');
	ui.stdin.write('\r');
	await sleep(60);
	await type(ui, '/task bump');
	ui.stdin.write('\r');
	await sleep(60);
	assert.match(frame(ui), /T-0002 goes next/);
});

test('cockpit: arrow keys pick a task in a run and Enter opens its detail', async (t) => {
	const { config, manager, proj } = machine();
	writeFileSync(
		join(proj, '.jarvis-code.json'),
		JSON.stringify({
			agents: { claude: { kind: 'claude', enabled: true, bin: demoAgent, models: ['claude-fable-5-1'], env: { JC_DEMO_PACE: '2' } } },
			planner: ['claude:claude-fable-5-1'],
			workers: ['claude:claude-fable-5-1'],
		}),
	);
	const ui = render(createElement(Cockpit, { manager, config: { ...config }, depth: 'none', cwd: proj }));
	t.after(() => {
		ui.unmount();
		return manager.stopAll();
	});
	await sleep(50);
	await type(ui, 'modernize settings');
	ui.stdin.write('\r');
	for (let i = 0; i < 100 && !(manager.list()[0]?.finished); i++) await sleep(50);
	assert.ok(manager.list()[0]?.finished, 'the run finished');
	await sleep(100);
	ui.stdin.write('\x1b[B');
	await sleep(60);
	ui.stdin.write('\r');
	await sleep(60);
	const f = frame(ui);
	assert.match(f, /T A S K/);
	assert.match(f, /test -f \.jarvis-demo/);
});

test('scroll: the feed pages back and returns to live; the queue scrolls with its position shown', () => {
	const v = { ...DEFAULTS.ui, learning: false };
	const activity = Array.from({ length: 30 }, (_, i) => ({ at: 0, kind: 'done' as const, text: `event ${i}` }));
	const feed = (back: number) => {
		const ui = render(createElement(Feed, { activity, v, height: 5, back }));
		const f = frame(ui);
		ui.unmount();
		return f;
	};
	assert.match(feed(0), /event 29/);
	assert.match(feed(0), /completions/);
	const paged = feed(10);
	assert.match(paged, /event 19/);
	assert.doesNotMatch(paged, /event 2[0-9]/);
	assert.match(paged, /10 lines back · End for live/);
	assert.match(feed(999), /event 0\b/, 'past the oldest line it shows the oldest page');
	const tasks = Array.from({ length: 12 }, (_, i) => ({ id: `T-${i}`, title: `task ${i}`, type: 'FIX', tier: 'S', status: 'queued' as const, attempts: 0 }));
	const ui = render(createElement(Tasks, { tasks, height: 5, t: 0, top: 4 }));
	const f = frame(ui);
	ui.unmount();
	assert.match(f, /… 4 above/);
	assert.match(f, /T-4 task 4/);
	assert.doesNotMatch(f, /T-3 /);
	assert.match(f, /… \d+ more/);
});

test('scroll: PgUp in the cockpit pages the feed back, End returns to live', async (t) => {
	const { config, manager, root } = machine();
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: root, fast: true }));
	t.after(() => {
		ui.unmount();
		return manager.stopAll();
	});
	await sleep(50);
	await type(ui, '/demo');
	ui.stdin.write('\r');
	for (let i = 0; i < 200 && !manager.list()[0]?.finished; i++) await sleep(50);
	assert.ok(manager.list()[0]?.finished, 'the demo run finished');
	await sleep(100);
	ui.stdin.write('\x1b[5~');
	await sleep(60);
	assert.match(frame(ui), /lines back · End for live/);
	ui.stdin.write('\x1b[F');
	await sleep(60);
	assert.doesNotMatch(frame(ui), /lines back/);
});

test('improve: /improve runs a grounded improvement goal for the selected project with deep planning', async (t) => {
	const { config, manager, proj } = machine();
	writeFileSync(
		join(proj, '.jarvis-code.json'),
		JSON.stringify({
			agents: { claude: { kind: 'claude', enabled: true, bin: demoAgent, models: ['claude-fable-5-1'], env: { JC_DEMO_PACE: '2', JC_DEMO_KIND: 'concrete' } } },
			planner: ['claude:claude-fable-5-1'],
			workers: ['claude:claude-fable-5-1'],
			planning: { lenses: ['user value'], rounds: 2 },
		}),
	);
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: proj }));
	t.after(() => {
		ui.unmount();
		return manager.stopAll();
	});
	await sleep(50);
	await type(ui, '/improve error handling');
	ui.stdin.write('\r');
	for (let i = 0; i < 200 && !manager.list()[0]?.finished; i++) await sleep(50);
	const run = manager.list()[0];
	assert.ok(run?.finished);
	assert.equal(run.dir, proj);
	assert.match(run.goal ?? '', /^Improve this project, focusing on error handling: /);
	assert.doesNotMatch(run.goal ?? '', /jarvis/i, 'about the project, never about jarvis-code');
	assert.equal(run.o.config.planning.mode, 'deep');
	assert.ok(run.o.snapshot().activity.some((a) => /^Brainstorm round 1/.test(a.text)), 'brainstormed even though the prompt writer called it concrete');
});

test('first run: the cockpit shows how to start and which agents it found, until there is work', async (t) => {
	const { config, manager, root } = machine();
	const fresh = join(root, 'fresh');
	process.env.JARVIS_CODE_STATE = join(root, 'fresh-state');
	mkdirSync(fresh);
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: fresh }));
	t.after(() => ui.unmount());
	await sleep(60);
	const f = frame(ui);
	assert.match(f, /W E L C O M E/);
	assert.match(f, /○ claude \(off\)/);
	assert.match(f, /No coding agent found/);

	new Project(fresh).add([{ title: 'First task' }]);
	ui.rerender(createElement(Cockpit, { manager, config, depth: 'none', cwd: fresh }));
	await type(ui, '/add .');
	ui.stdin.write('\r');
	await sleep(80);
	assert.doesNotMatch(frame(ui), /W E L C O M E/, 'gone once a project has tasks');
});

test('header: cost shows the planning part', () => {
	const base = {
		phase: 'idle' as const,
		paused: false,
		source: 'store',
		tasks: [],
		workers: [],
		activity: [],
		started: Date.now(),
		reactor: 'idle' as const,
		stateSince: 0,
		prevReactor: 'idle' as const,
		routes: [],
	};
	const v = { ...normalize(DEFAULTS).ui, reactor: 'off' as const, learning: false };
	const style = normalize(DEFAULTS).ui.reactorStyle;
	const header = (cost: number, planning?: number) => {
		const ui = render(
			createElement(Header, { snap: { ...base, cost, planning }, t: 0, v, depth: 'none', reactorRows: 2, tempo: 3, width: 120, style }),
		);
		const f = frame(ui);
		ui.unmount();
		return f;
	};
	const f = header(1.5, 0.4);
	assert.match(f, /\$1\.50/);
	assert.match(f, /planning \$0\.40/);
	assert.doesNotMatch(header(1.5, 0), /planning \$/);
	assert.doesNotMatch(header(1.5), /planning \$/);
});

test('background: the cockpit shows a run from another process, /stop ends it, and /detach hands its own run to the background', async (t) => {
	const { config, manager, proj } = machine();
	const other = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => process.exit(0)); setTimeout(() => {}, 30000)']);
	new Project(proj).lock({ pid: other.pid, by: 'cli' });
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: proj }));
	t.after(() => {
		ui.unmount();
		return manager.stopAll();
	});
	await sleep(80);
	assert.match(frame(ui), /alpha\s+background 0\/1/);
	assert.match(frame(ui), /running in the background \(pid \d+, since/);
	await type(ui, '/stop');
	ui.stdin.write('\r');
	assert.equal(await new Promise((r) => other.on('exit', r)), 0, 'the background run got SIGTERM');

	writeFileSync(
		join(proj, '.jarvis-code.json'),
		JSON.stringify({ agents: { claude: { kind: 'claude', enabled: true, bin: demoAgent, models: ['claude-fable-5-1'], env: { JC_DEMO_PACE: '800' } } }, planner: ['claude:claude-fable-5-1'], workers: ['claude:claude-fable-5-1'], planning: { mode: 'direct' } }),
	);
	await type(ui, '/work');
	ui.stdin.write('\r');
	for (let i = 0; i < 100 && manager.list()[0]?.o.snapshot().phase !== 'working'; i++) await sleep(50);
	await type(ui, '/detach');
	ui.stdin.write('\r');
	let held;
	for (let i = 0; i < 100 && !((held = Project.open(proj)!.running()) && held.pid !== process.pid); i++) await sleep(50);
	assert.ok(held && held.pid !== process.pid && held.by === 'cli', 'a background process took the project');
	assert.ok(manager.list()[0].finished, "the cockpit's own run stopped");
	process.kill(held.pid, 'SIGTERM');
	for (let i = 0; i < 100 && Project.open(proj)!.running(); i++) await sleep(50);
});
