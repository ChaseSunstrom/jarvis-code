import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
import { KEEP_FINISHED, RunManager } from '../src/runs.js';
import { Project, type StoredTask } from '../src/store.js';
import { Cockpit, matchCommands } from '../src/tui/Cockpit.js';
import { Feed, Header, Tasks } from '../src/tui/parts.js';
import { Reports, TaskDetail, Workers } from '../src/tui/parts.js';
import { clauseMark, kindMark, MARKS, statusMark } from '../src/tui/style.js';
import { DepTree, flow, Graph, Ideas, lanes, Timeline } from '../src/tui/graph.js';
import { diffstat, PAGER_MAX, pageLines, Pager } from '../src/tui/pager.js';
import { Stats } from '../src/tui/stats.js';
import { c } from '../src/theme.js';
import { PULSE_MAX, type Snapshot } from '../src/orchestrator.js';
import { sampleSnapshot } from './sample-snapshot.js';

// ink-testing-library's stdout has no rows, so Ink asks the real terminal (env, then /dev/tty):
// in a tall one a /diff patch fits one page and PgDn has nothing to scroll. Pin the classic size.
process.env.COLUMNS = '100';
process.env.LINES = '24';

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
	assert.deepEqual(matchCommands('/st').map((c) => c.name), ['stop', 'stats'], '/stop stays first, so /st + Tab still stops');
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
	assert.doesNotMatch(f, /tool +(Bash|Read)|\+ const a/, 'diffs and tool calls are hidden by default');
	await type(ui, '/diffs');
	ui.stdin.write('\r');
	await sleep(60);
	await type(ui, '/tools');
	ui.stdin.write('\r');
	await sleep(300);
	f = frame(ui);
	assert.match(f, /diffs · tools/);
	// The run ends with the coverage check's Read, after the last worker's Bash.
	assert.match(f, /tool +(Bash|Read)|\+ const a/);
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

test('RunManager keeps only the newest finished runs', async () => {
	const { manager, root } = machine();
	// An older run still going (id 0, before any real one): prune must never drop it.
	const going = { id: 0, dir: join(root, 'going'), name: 'going', o: undefined as never, done: new Promise<never>(() => {}), finished: false };
	manager.runs.set(0, going);
	const dirs = Array.from({ length: KEEP_FINISHED + 3 }, (_, i) => join(root, `p${i}`));
	for (const d of dirs) {
		mkdirSync(d);
		// No goal and an empty memory queue: the run finishes at once, and launch() prunes.
		await (await manager.start(d, { memory: true })).done;
	}
	const finished = manager.list().filter((r) => r.finished);
	assert.equal(finished.length, KEEP_FINISHED);
	assert.deepEqual(finished.map((r) => r.dir), dirs.slice(-KEEP_FINISHED), 'the newest finished runs survive');
	assert.deepEqual(manager.active(), [going], 'the run still going is kept');
	assert.equal(manager.inDir(dirs.at(-1)!)?.finished, true);
	assert.equal(manager.inDir(dirs[0]), undefined, 'the oldest was dropped');
	assert.ok(manager.inDir(dirs.at(-1)!)!.o.snapshot(), 'a kept finished run still has its snapshot');
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
	assert.match(compact[1], /lens 0, round 1 claude:m +▁{12}\s+reading 0/, 'a quiet agent: a flat pulse');
	const many = rows(9, 6);
	assert.equal(many.length, 6);
	assert.match(many.at(-1)!, /… 5 more/);
});

test('workers pulse: an agent\'s last minute of events as a sparkline, busiest slot full', () => {
	const now = 1_000_000_000_000; // on a 5 s slot boundary
	const beats = [now - 2000, now - 2500, now - 3000, now - 4000, now - 32_000, now - 90_000];
	const w = { key: 'T-0001', task: 'T-0001', title: 't', route: 'claude:m', phase: 'running' as const, started: now - 100_000, lastAt: now - 2000, tools: 6, last: 'editing', cost: 0, beats };
	const ui = render(createElement(Workers, { workers: [w], t: 0, height: 4, now }));
	const f = frame(ui).split('\n');
	ui.unmount();
	// 12 slots of 5 s: 1 event 30-35 s ago (the 6th slot), 4 in the last 5 s (the 12th); the one 90 s ago is out.
	assert.match(f[1], /claude:m  ▁▁▁▁▁▃▁▁▁▁▁█  1m40s · 6 tools$/, 'and its times read from the same now');
	assert.ok(PULSE_MAX >= 60, 'a busy minute fits');
});

test('workers status: each row shows its role, latest line and, once quiet, how long', () => {
	const now = Date.now();
	const w = (key: string, ago: number) => ({ key, task: key.replace('review:', ''), title: key, route: 'claude:m', phase: key.startsWith('review:') ? ('reviewing' as const) : ('running' as const), started: now - 300_000, lastAt: now - ago * 1000, tools: 1, last: `line ${ago}`, cost: 0 });
	const ui = render(createElement(Workers, { workers: [w('T-0001', 10), w('review:T-0002', 60), w('planner', 200)], t: 0, height: 8 }));
	const f = frame(ui).split('\n');
	ui.unmount();
	assert.match(f[1], /worker T-0001 claude:m/);
	assert.doesNotMatch(f[1], /quiet/);
	assert.match(f[2], /└ line 10/);
	assert.match(f[3], /reviewer review T-0002 claude:m +▁+\s+quiet 1m00s/);
	assert.match(f[4], /└ line 60/);
	assert.match(f[5], /planner planner claude:m +▁+\s+quiet 3m20s/);
	assert.match(f[6], /└ line 200/);
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

test('the inspected task is not reread on every frame', async (t) => {
	const { config, manager, proj } = machine();
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: proj }));
	t.after(() => ui.unmount());
	await sleep(50);
	await type(ui, '/task show T-0001');
	ui.stdin.write('\r');
	await sleep(60);
	assert.match(frame(ui), /Wire the parser/);
	const get = Project.prototype.get;
	let reads = 0;
	Project.prototype.get = function (this: Project, id: string) {
		reads++;
		return get.call(this, id);
	};
	try {
		// Each keystroke re-renders the cockpit; none of them changes the task.
		for (let i = 0; i < 25; i++) {
			ui.stdin.write('x');
			await sleep(10);
		}
		assert.match(frame(ui), /x{25}▏/, 'every keystroke rendered');
		assert.ok(reads < 3, `the task was read ${reads} times over 25 renders`);
	} finally {
		Project.prototype.get = get;
	}
	assert.match(frame(ui), /Wire the parser/);
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

test('icons: text tags by default, a glyph table on ui.icons "glyph", no emoji in either', () => {
	const emoji = /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u;
	for (const [name, table] of Object.entries(MARKS))
		for (const [key, [mark]] of Object.entries(table)) assert.doesNotMatch(mark, emoji, `${name}.${key}`);
	assert.equal(DEFAULTS.ui.icons, 'text');
	assert.deepEqual(kindMark('done', 'text'), ['done  ', 'ok']);
	assert.equal(kindMark('review', 'text')[0].length, kindMark('start', 'text')[0].length, 'text tags share one width');
	assert.deepEqual(kindMark('done', 'glyph'), ['✓', 'ok']);
	assert.equal(statusMark('running', 'text')[0].trim(), 'run');
	assert.equal(normalize(merge(DEFAULTS, { ui: { icons: 'glyph' } })).ui.icons, 'glyph');
	assert.throws(() => normalize(merge(DEFAULTS, { ui: { icons: 'emoji' } } as never)), /ui\.icons/);
	const activity = [{ at: 0, kind: 'fail' as const, text: 'broke' }];
	const feed = (icons: 'text' | 'glyph') => {
		const ui = render(createElement(Feed, { activity, v: { ...DEFAULTS.ui, icons, learning: false }, height: 3 }));
		const f = frame(ui);
		ui.unmount();
		return f;
	};
	assert.match(feed('text'), /fail +broke/);
	assert.match(feed('glyph'), /✗ broke/);
	const tasks = [{ id: 'T-1', title: 'wire it', type: 'FIX', tier: 'S', status: 'running' as const, attempts: 1 }];
	const ui = render(createElement(Tasks, { tasks, height: 3, t: 0 }));
	assert.match(frame(ui), /run +T-1 wire it/);
	ui.unmount();
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
	assert.ok(run.o.snapshot().activity.some((a) => /^Brainstorm tree: /.test(a.text)), 'brainstormed (as a tree, the default) even though the prompt writer called it concrete');
});

test('route command: /route sets, lists and clears session routes, refuses a bad key, and runs started afterwards use them', async (t) => {
	const { config, manager, proj } = machine();
	writeFileSync(join(proj, '.jarvis-code.json'), JSON.stringify({ agents: { claude: { kind: 'claude', enabled: true, bin: demoAgent, models: ['claude-fable-5-1'], env: { JC_DEMO_PACE: '2' } } } }));
	const ui = render(createElement(Cockpit, { manager, config: normalize(merge(config, { routes: { planner: ['claude'] } })), depth: 'none', cwd: proj }));
	t.after(() => {
		ui.unmount();
		return manager.stopAll();
	});
	await sleep(50);
	const send = async (line: string) => {
		await type(ui, line);
		ui.stdin.write('\r');
		await sleep(60);
	};
	await send('/route security codex');
	assert.match(frame(ui), /SECURITY → codex from the next run/, 'a lowercase type is taken as the type');
	await send('/route');
	assert.match(frame(ui), /planner claude · SECURITY codex \(session\)/, 'configured and session routes, session ones marked');
	await send('/route SECURITY -');
	assert.match(frame(ui), /SECURITY route cleared/);
	await send('/route');
	assert.match(frame(ui), /planner claude/);
	assert.doesNotMatch(frame(ui), /SECURITY codex/);
	await send('/route bogus codex');
	assert.match(frame(ui), /routes\.bogus: a role/, "normalize()'s message");
	await send('/route');
	assert.doesNotMatch(frame(ui), /bogus/, 'a refused route is not kept');
	await send('/route FIX codex claude');
	await send('/work');
	for (let i = 0; i < 40 && !manager.list().length; i++) await sleep(25);
	const run = manager.list()[0];
	assert.ok(run, 'a run started');
	assert.deepEqual(run.o.config.routes, { SECURITY: [], FIX: ['codex', 'claude'] }, 'the session routes, over the project config');
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
		nodes: [],
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

test('header: beside the large reactor at 100 columns the tasks line stays one row, the bar shrinking to fit', () => {
	const snap: Snapshot = { ...sampleSnapshot(), planning: 0.6, reactor: 'idle' };
	const v = { ...normalize(DEFAULTS).ui, reactor: 'large' as const, learning: false };
	const ui = render(createElement(Header, { snap, t: 0, v, depth: 'none', reactorRows: 17, tempo: 3, width: 100, style: normalize(DEFAULTS).ui.reactorStyle }));
	const f = frame(ui).split('\n');
	ui.unmount();
	const row = f.find((l) => l.includes('TASKS'))!;
	assert.match(row, /TASKS 1\/5 [▰▱]{6,} {2}COST \$1\.20 \(plan \$0\.60\) {2}TIME \d/, 'packed labels: cost, planning and time on the same row');
});

test('header: a stacked status bar, one segment per status, and route scores as bars', () => {
	const snap: Snapshot = { ...sampleSnapshot(), planning: 0, reactor: 'idle', routes: [{ id: 'claude', off: false, score: 0.75, runs: 4 }, { id: 'codex', off: true, score: 0.2, runs: 5 }] };
	const v = { ...normalize(DEFAULTS).ui, reactor: 'off' as const, learning: false };
	const ui = render(createElement(Header, { snap, t: 0, v, depth: 'none', reactorRows: 2, tempo: 3, width: 120, style: normalize(DEFAULTS).ui.reactorStyle }));
	const f = frame(ui);
	ui.unmount();
	// 1 done, 1 running, 1 failed, 2 queued over 30 cells: 6 + 6 + 6 filled, 12 empty.
	const cells = f.match(/[▰▱]+/)?.[0] ?? '';
	assert.equal(cells.length, 30);
	assert.equal([...cells].filter((ch) => ch === '▱').length, 12);
	assert.match(f, /1\/5/);
	assert.match(f, /● claude █+[▏▎▍▌▋▊▉]? *75%/, 'a live route: its score as a bar');
	assert.match(f, /✕ codex/, 'a route that is off says so');
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

test('graph view: goal, the stages that ran and their agent runs; a task lists its worker and reviewer runs', () => {
	const draw = (snap: Snapshot, height = 40) => {
		const ui = render(createElement(Graph, { snap, height }));
		const f = frame(ui).split('\n');
		ui.unmount();
		return f;
	};
	const rows = draw(sampleSnapshot());
	assert.match(rows[0], /G R A P H\s+10 agent runs · Esc to close/);
	assert.equal(rows[1], '● prompt writer 1 ▸ ● brainstorm 2 ▸ ● critique 1 ▸ ● planner 1 ▸ ◉ tasks 4 ▸ ◉ coverage 1', 'the flow: every stage, its state and runs');
	assert.equal(rows[2], 'Modernize the settings system');
	assert.deepEqual(flow([{ ...sampleSnapshot().nodes[0], state: 'failed' }]).map((f) => f.state), ['fail', 'wait', 'wait', 'wait', 'wait', 'wait'], 'a stage whose only run failed; the rest not reached');
	const stages = rows.filter((r) => /^[├└]─ .* runs? · \$/.test(r)).map((r) => r.slice(3).split('  ')[0]);
	assert.deepEqual(stages, ['prompt writer', 'brainstorm', 'critique', 'planner', 'tasks', 'coverage']);
	assert.ok(rows.some((r) => /^│  └─ done +planning prompt  claude:claude-fable-5-1  1m00s · \$0\.12$/.test(r)), 'a node row: state tag, label, route, elapsed, cost');
	assert.ok(rows.some((r) => /^│  └─ fail +users · round 1  claude:claude-fable-5-1/.test(r)), 'a failed run is tagged fail');
	assert.ok(rows.some((r) => /^   └─ run +coverage  claude:claude-fable-5-1  1m3\ds · \$0\.12$/.test(r)), 'a running node counts its time to now');
	const at = rows.findIndex((r) => /T-0001 Add the settings schema/.test(r));
	assert.match(rows[at], /^│  ├─ done +T-0001 Add the settings schema  claude:claude-fable-5-1$/);
	assert.match(rows[at + 1], /^│  │  ├─ done +worker  claude:claude-fable-5-1/);
	assert.match(rows[at + 2], /^│  │  └─ done +reviewer  codex:gpt-5/);
	assert.ok(rows.some((r) => /T-0002 Load settings from disk/.test(r)) && rows.some((r) => /^│  │  └─ run +worker  codex:gpt-5  1m3\ds/.test(r)));
	assert.ok(!rows.some((r) => /T-0004|T-0005/.test(r)), 'tasks no agent ran for are the tree view, not the graph');
	assert.ok(rows.every((r) => r.length <= 100), 'rows are truncated to the pane width');
	assert.match(draw(sampleSnapshot(), 6).at(-1)!, /… \d+ more/);

	const bare: Snapshot = { phase: 'idle', paused: false, source: 'store', tasks: [], workers: [], nodes: [], activity: [], cost: 0, started: Date.now(), reactor: 'idle', stateSince: 0, prevReactor: 'idle', routes: [] };
	assert.match(draw(bare).join('\n'), /0 agent runs[\s\S]*this run: no agent has run yet/);
	// A worker whose task is not in the snapshot, and nodes with no model, end or task.
	const sparse = { ...bare, nodes: [{ id: 'x', role: 'worker' as const, label: 'Gone', task: 'T-0099', route: 'r', state: 'failed' as const, started: 0, cost: 0, last: '', lastAt: 0 }, { id: 'y', role: 'planner' as const, label: 'plan', route: 'r', state: 'running' as const, started: Date.now(), cost: 0, last: '', lastAt: 0 }] };
	const f = draw(sparse).join('\n');
	assert.match(f, /working the queue\n├─ planner[\s\S]*└─ tasks[\s\S]*   └─ T-0099\n      └─ fail +worker  r/);
});

test('graph clauses: done items sit under the goal row with a met, unmet or open tag and the tasks covering them; unmet is warn', () => {
	const draw = (snap: Snapshot) => {
		const ui = render(createElement(Graph, { snap, height: 40, icons: 'glyph' }));
		const f = frame(ui).split('\n');
		ui.unmount();
		return f;
	};
	// Row 1 is the stage flow; the tree starts under it.
	const rows = draw(sampleSnapshot()).slice(1);
	assert.equal(rows[1], 'Modernize the settings system');
	assert.deepEqual(rows.slice(2, 5), [
		'├─ met   settings load from disk  T-0001, T-0002',
		'├─ unmet old settings files still load  T-0003',
		'├─ open  the settings are documented',
	], 'text tags even with glyph icons, before the stages');
	assert.match(rows[5], /^├─ prompt writer/);
	assert.deepEqual([clauseMark('met')[1], clauseMark('unmet')[1], clauseMark('open')[1]], ['ok', 'warn', 'textFaint']);
	assert.ok(!draw({ ...sampleSnapshot(), clauses: undefined }).some((r) => /settings load from disk/.test(r)), 'no clauses, no checklist');
});

test('timeline: every agent run on one time axis, a task\'s runs together, the newest rows kept', () => {
	const snap = sampleSnapshot();
	const now = snap.started + 300_000;
	// Every sample node ran from 90 s to 30 s before the sample's now (the running ones to now).
	const rows = lanes(snap.nodes, snap.started, now, 60);
	assert.equal(rows.length, 10);
	assert.deepEqual(rows.map((r) => r.label).slice(0, 5), ['prompt writer', 'r1 risk', 'r1 users', 'critique · 2 ideas', 'planner']);
	assert.deepEqual([rows[0].from, rows[0].to], [42, 54], '210 s to 270 s of 300 s over 60 cells');
	const t1 = rows.findIndex((r) => r.label === 'T-0001 worker');
	assert.equal(rows[t1 + 1].label, 'T-0001 reviewer', 'a task\'s review sits under its worker');
	const running = rows.find((r) => r.label === 'T-0002 worker')!;
	assert.equal(running.to, 60, 'a running agent reaches now');
	assert.ok(rows.every((r) => r.to > r.from && r.to <= 60));
	// A task's second worker run (a retry) is numbered, so its rows tell apart.
	const retry = lanes([...snap.nodes, { ...snap.nodes[5], id: 'T-0001#11', state: 'failed' }], snap.started, now, 60).filter((r) => r.label.startsWith('T-0001'));
	assert.deepEqual(retry.map((r) => r.label), ['T-0001 worker', 'T-0001 reviewer', 'T-0001 worker 2']);
	// A run that starts and ends in the same instant still gets a cell.
	const blink = lanes([{ ...snap.nodes[0], started: now, ended: now }], snap.started, now, 60)[0];
	assert.deepEqual([blink.from, blink.to], [59, 60]);

	const draw = (height: number) => {
		const ui = render(createElement(Timeline, { snap, height, width: 96, now }));
		const f = frame(ui).split('\n');
		ui.unmount();
		return f;
	};
	const all = draw(20);
	assert.match(all[0], /T I M E L I N E\s+10 agent runs · Esc to close/);
	assert.match(all[1], /prompt.*brainstorm.*critic.*planner.*worker.*reviewer.*coverage/, 'a legend names the colours');
	assert.ok(all.some((r) => /^T-0002 worker +─+█+ +1m3\ds · \$0\.12$/.test(r)), 'a row: label, track, bar to now, time and cost');
	assert.match(all.at(-1)!, /0s +2m30s +5m00s$/, 'the axis: start, middle, now');
	const clipped = draw(8);
	assert.match(clipped[2], /… 6 earlier/);
	assert.ok(clipped.some((r) => r.startsWith('coverage')), 'the newest run stays in view');
});

test('stats: task mix, cost by role and route, route scores and sparklines over the run', () => {
	const snap: Snapshot = { ...sampleSnapshot(), routes: [{ id: 'claude:claude-fable-5-1', off: false, score: 0.8, runs: 5 }, { id: 'codex:gpt-5', off: true, score: 0.2, runs: 4 }] };
	const now = snap.started + 300_000;
	const ui = render(createElement(Stats, { snap, height: 30, width: 96, now }));
	const f = frame(ui);
	ui.unmount();
	assert.match(f, /S T A T S/);
	assert.match(f, /1 done {2}1 running {2}1 failed {2}2 queued/);
	assert.match(f, /brainstorm +█+[▉▊▋▌▍▎▏]? +\$0\.24 · 2 runs, 1 failed/, 'a role: its cost as a bar, runs and failures');
	assert.match(f, /worker +█+ +\$0\.36 · 3 runs, 1 failed/, 'the costliest role fills its bar');
	assert.match(f, /claude:claude-… +█+ +\$0\.96 · 8/, 'cost by route, largest first');
	assert.match(f, /codex:gpt-5 +█*[▉▊▋▌▍▎▏]? +off · 4 runs/, 'a route that is off');
	assert.match(f, /runs done +[▁-█]+ +8/, '8 of the 10 sample runs have ended');
	assert.match(f, /spend +[▁-█]+ +\$0\.96/);
	const empty = render(createElement(Stats, { snap: { ...snap, nodes: [], tasks: [], routes: [] }, height: 30, width: 96, now }));
	// The two columns interleave rows, so each empty note is looked for on its own.
	for (const note of [/no tasks yet/, /no agent has run yet/, /nothing learned yet/]) assert.match(frame(empty), note);
	empty.unmount();
});

test('ideas pane: the brainstorm tree with value bars and critic scores, scrolled by top; flat ideas under their lens', () => {
	const tree: Snapshot['ideas'] = [
		{ id: '1', title: 'Interface', depth: 1 },
		{ id: '1.1', parent: '1', title: 'Charts', depth: 2, effort: 'M', value: 4, critique: { value: 5, effort: 2, risk: 1 }, score: 7 },
		{ id: '1.1.1', parent: '1.1', title: 'Sparklines', depth: 3, effort: 'S', value: 3 },
		{ id: '1.2', parent: '1', title: 'Tabs', depth: 2, value: 2, merged: 2 },
		{ id: '2', title: 'Speed', depth: 1 },
	];
	const draw = (ideas: Snapshot['ideas'], height = 20, top = 0) => {
		const ui = render(createElement(Ideas, { ideas, height, top }));
		const f = frame(ui).split('\n');
		ui.unmount();
		return f;
	};
	const rows = draw(tree);
	assert.match(rows[0], /I D E A S\s+3 ideas · 2 categories · Esc to close/);
	assert.deepEqual(rows.slice(1, 6), [
		'      Interface',
		'█████ ├─ Charts  M  v5 e2 r1',
		'███   │  └─ Sparklines  S',
		'██    └─ Tabs  +2',
		'      Speed',
	], 'the value bars line up in one column, before the tree');
	const scrolled = draw(tree, 3, 2);
	assert.match(scrolled[0], /3–4 of 5 · PgUp\/PgDn/);
	assert.match(scrolled[1], /Sparklines/);
	const flat = draw([{ title: 'Cache it', lens: 'speed' }, { title: 'Guard it', lens: 'safety' }, { title: 'Batch it', lens: 'speed' }]);
	assert.match(flat[0], /3 ideas · 2 angles/);
	assert.deepEqual(flat.slice(1, 6), ['      speed', '      ├─ Cache it', '      └─ Batch it', '      safety', '      └─ Guard it']);
	assert.match(draw(undefined).join('\n'), /no brainstorm in this run yet/);
});

test('tree view: tasks by their depends, a second dependency as a reference row, cycles marked', () => {
	const draw = (tasks: Snapshot['tasks'], height = 30) => {
		const ui = render(createElement(DepTree, { tasks, height }));
		const f = frame(ui).split('\n');
		ui.unmount();
		return f;
	};
	const rows = draw(sampleSnapshot().tasks);
	assert.deepEqual(rows, [
		rows[0],
		'done   T-0001 Add the settings schema  claude:claude-fable-5-1',
		'├─ run    T-0002 Load settings from disk  codex:gpt-5',
		'│  └─ queued T-0004 Migrate old settings files',
		'│     └─ queued T-0005 Document the settings',
		'└─ fail   T-0003 Validate settings on save',
		'   └─ → queued T-0004 Migrate old settings files',
	]);
	assert.match(rows[0], /T R E E\s+5 tasks · Esc to close/);
	assert.equal(rows.filter((r) => r.includes('T-0004')).length, 2, 'the task with two dependencies once, plus one reference row');

	const task = (id: string, ...depends: string[]) => ({ id, title: `task ${id}`, type: 'FIX', tier: 'S', status: 'queued' as const, attempts: 0, depends });
	const cyclic = draw([task('T-1', 'T-2'), task('T-2', 'T-1'), task('T-3', 'T-404'), { ...task('T-4'), depends: undefined }]);
	assert.deepEqual(cyclic.slice(1), [
		'queued T-3 task T-3',
		'queued T-4 task T-4',
		'queued T-1 task T-1  (cycle)',
		'└─ queued T-2 task T-2  (cycle)',
		'   └─ → queued T-1 task T-1  (cycle)',
	]);
	assert.match(draw([]).join('\n'), /no tasks yet/);
});

test('graph command: /graph and /tree toggle a pane over the run body, Esc closes it before going home', async (t) => {
	const { config, manager, root } = machine();
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: root, fast: true }));
	t.after(() => {
		ui.unmount();
		return manager.stopAll();
	});
	const send = async (line: string) => {
		await type(ui, line);
		ui.stdin.write('\r');
		await sleep(60);
		return frame(ui);
	};
	await sleep(50);
	assert.match(await send('/graph'), /\/graph: open a run first/);
	assert.match(await send('/tree'), /\/tree: open a run first/);
	assert.doesNotMatch(frame(ui), /G R A P H|T R E E/);

	await send('/demo');
	for (let i = 0; i < 200 && !manager.list()[0]?.finished; i++) await sleep(50);
	assert.ok(manager.list()[0]?.finished, 'the demo run finished');
	await sleep(100);
	let f = await send('/graph');
	assert.match(f, /G R A P H/);
	assert.match(f, /G R A P H.*\n.*● prompt writer 1 ▸ ● brainstorm \d+ ▸.* ● coverage 1 .*\n.*Modernize the settings system/, 'the flow, whole at 100 columns, then the goal');
	assert.doesNotMatch(f, /Q U E U E/, 'the pane takes the whole body');
	f = await send('/graph');
	assert.doesNotMatch(f, /G R A P H/, 'a second /graph closes it');
	assert.match(f, /Q U E U E/);
	f = await send('/tree');
	assert.match(f, /T R E E/);
	assert.doesNotMatch(f, /Q U E U E/);
	f = await send('/graph');
	assert.match(f, /G R A P H/, '/graph swaps the tree for the graph');
	assert.doesNotMatch(f, /T R E E/);
	f = await send('/timeline');
	assert.match(f, /T I M E L I N E/);
	assert.match(f, /prompt writer.*█/, 'the demo run\'s agent runs are bars');
	assert.doesNotMatch(f, /G R A P H/);
	f = await send('/stats');
	assert.match(f, /S T A T S/);
	assert.match(f, /C O S T   B Y   R O L E/);
	assert.doesNotMatch(f, /T I M E L I N E/);
	f = await send('/ideas');
	assert.match(f, /I D E A S\s+\d+ ideas · 3 categories/, 'the demo brainstorms as a tree');
	assert.match(f, /^.*Interface/m);
	const shown = Number(f.match(/ 1–(\d+) of \d+ · PgUp\/PgDn/)?.[1]);
	assert.ok(shown > 1, 'the demo tree is taller than the pane at 24 rows');
	ui.stdin.write('\x1b[6~');
	await sleep(60);
	assert.match(frame(ui), new RegExp(` ${shown}–\\d+ of \\d+ · PgUp/PgDn`), 'PgDn scrolls the tree a page, keeping a row');
	ui.stdin.write('\x1b[5~');
	await sleep(60);
	assert.match(frame(ui), / 1–\d+ of \d+ · PgUp\/PgDn/, 'PgUp comes back to the top');
	f = await send('/graph');
	ui.stdin.write('\x1b');
	await sleep(60);
	f = frame(ui);
	assert.doesNotMatch(f, /G R A P H/);
	assert.match(f, /Q U E U E/, 'Esc closed the pane and stayed in the run');
	ui.stdin.write('\x1b');
	await sleep(60);
	assert.match(frame(ui), /P R O J E C T S/, 'the next Esc goes home');
});

test('history pane: /history shows the project\'s finished runs with sparklines, read once; Esc closes it', async (t) => {
	const { config, manager, proj } = machine();
	const p = new Project(proj);
	p.recordRun({ at: '2026-09-28T10:00:00.000Z', minutes: 12, goal: 'first goal', total: 4, done: 2, blocked: 1, review: 0, cost: 1.5, planning: 0.5, agents: 9, stopped: false });
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: proj }));
	t.after(() => ui.unmount());
	await sleep(50);
	await type(ui, '/history');
	ui.stdin.write('\r');
	await sleep(60);
	let f = frame(ui);
	assert.match(f, /H I S T O R Y\s+1 run · \/history to close/);
	assert.match(f, /cost +█ +\$1\.50 in all/);
	assert.match(f, /success +▅ +50% of 4 tasks done/);
	assert.match(f, /09-28 10:00 +2\/4 ███ +\$ +1\.50 +12m +first goal/);
	p.recordRun({ at: '2026-09-29T10:00:00.000Z', minutes: 1, goal: 'later goal', total: 1, done: 1, blocked: 0, review: 0, cost: 0.1, planning: 0, agents: 2, stopped: false });
	await sleep(300);
	assert.doesNotMatch(frame(ui), /later goal/, 'read when the command ran, not in render');
	ui.stdin.write('\x1b');
	await sleep(60);
	f = frame(ui);
	assert.doesNotMatch(f, /H I S T O R Y/);
});

test('feed follows the selected task: ↑↓ in a run filters the activity to it; Esc shows everything again', async (t) => {
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
	await sleep(100);
	const feedOf = (f: string) => f.slice(f.indexOf('A C T I V I T Y'));
	assert.match(feedOf(frame(ui)), /M-0007/, 'everything at first');
	ui.stdin.write('\x1b[B');
	await sleep(60);
	let f = frame(ui);
	assert.match(f, /M-0001 only · Esc for all/);
	assert.doesNotMatch(feedOf(f).split('\n').slice(1).join('\n'), /M-000[2-7]/, 'only the selected task\'s lines');
	assert.match(feedOf(f), /M-0001/);
	ui.stdin.write('\x1b');
	await sleep(60);
	f = frame(ui);
	assert.doesNotMatch(f, /only · Esc for all/);
	assert.match(f, /Q U E U E/, 'Esc cleared the selection and stayed in the run');
	assert.match(feedOf(f), /M-0007/);
});

test('ask command: /ask runs a read-only agent on the project and pages its wrapped answer', async (t) => {
	const { config, manager, proj } = machine();
	const log = join(proj, '..', 'ask.jsonl');
	writeFileSync(join(proj, '.jarvis-code.json'), JSON.stringify({ agents: { claude: { kind: 'claude', enabled: true, bin: demoAgent, models: ['claude-fable-5-1'], env: { JC_DEMO_PACE: '2', JC_DEMO_LOG: log } } }, planner: ['claude:claude-fable-5-1'] }));
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: proj }));
	t.after(() => ui.unmount());
	await sleep(50);
	await type(ui, '/ask');
	ui.stdin.write('\r');
	await sleep(60);
	assert.match(frame(ui), /\/ask <question>/);
	await type(ui, '/ask why did T-0001 take so long');
	ui.stdin.write('\r');
	for (let i = 0; i < 100 && !/A N S W E R/.test(frame(ui)); i++) await sleep(50);
	let f = frame(ui);
	assert.match(f, /A N S W E R +1–\d+ of \d+ · PgUp\/PgDn · Esc to close │\n.*Q: why did T-0001 take so long/, 'the title stays one row');
	assert.match(f, /answered by claude:claude-fable-5-1/);
	ui.stdin.write('\x1b[6~');
	await sleep(60);
	f = frame(ui);
	assert.match(f, /You asked: why did T-0001 take so long/);
	assert.ok(f.split('\n').every((l) => l.length <= 100), 'the answer is wrapped to the pane');
	const prompt = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0]);
	assert.match(prompt, /^JARVIS-CODE ASK/);
	assert.match(prompt, /tasks\/T-\*\.json/, 'the prompt maps the store');
	assert.doesNotMatch(prompt, /\[no tools\]/, 'it may read');
});

test('plan command: /plan plans into the queue and stops, the queue waits for /work; refused while a run is going', async (t) => {
	const { config, manager, proj } = machine();
	writeFileSync(join(proj, '.jarvis-code.json'), JSON.stringify({ agents: { claude: { kind: 'claude', enabled: true, bin: demoAgent, models: ['claude-fable-5-1'], env: { JC_DEMO_PACE: '2' } } }, planner: ['claude:claude-fable-5-1'], workers: ['claude:claude-fable-5-1'], planning: { mode: 'direct' } }));
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: proj }));
	t.after(() => {
		ui.unmount();
		return manager.stopAll();
	});
	await sleep(50);
	new Project(proj).enqueue('a goal queued earlier');
	await type(ui, '/plan make the loader faster');
	ui.stdin.write('\r');
	for (let i = 0; i < 100 && !manager.list()[0]?.finished; i++) await sleep(50);
	await sleep(100);
	const f = frame(ui);
	assert.match(f, /Plan only: \d+ tasks? queued, none started/);
	const p = new Project(proj);
	assert.ok(p.tasks().length && p.tasks().every((x) => x.status === 'planned'), 'planned, none worked');
	assert.equal(manager.list().length, 1, 'the queued goal was not drained: it would work the plan');
	assert.deepEqual(p.goals().map((g) => g.goal), ['a goal queued earlier']);
	p.lock({ goal: 'elsewhere', pid: process.pid });
	t.after(() => p.unlock());
	await type(ui, '/plan another');
	ui.stdin.write('\r');
	await sleep(80);
	assert.match(frame(ui), /has a run going: \/plan once it ends/);
});

test('issue command: /issue n reads the issue with gh and starts a run on it', async (t) => {
	const { config, manager, proj } = machine();
	writeFileSync(join(proj, '.jarvis-code.json'), JSON.stringify({ agents: { claude: { kind: 'claude', enabled: true, bin: demoAgent, models: ['claude-fable-5-1'], env: { JC_DEMO_PACE: '2' } } }, planner: ['claude:claude-fable-5-1'], workers: ['claude:claude-fable-5-1'], planning: { mode: 'direct' } }));
	const bin = mkdtempSync(join(tmpdir(), 'jc-gh-'));
	writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nconsole.log(JSON.stringify({ number: 7, title: 'Loader crashes', body: 'It crashes.', url: 'https://github.com/o/r/issues/7' }));\n`, { mode: 0o755 });
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path}`;
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: proj }));
	t.after(() => {
		process.env.PATH = path;
		ui.unmount();
		return manager.stopAll();
	});
	await sleep(50);
	await type(ui, '/issue');
	ui.stdin.write('\r');
	await sleep(60);
	assert.match(frame(ui), /\/issue <n>: a GitHub issue/);
	await type(ui, '/issue 7');
	ui.stdin.write('\r');
	for (let i = 0; i < 60 && !manager.list().length; i++) await sleep(50);
	assert.match(manager.list()[0]?.goal ?? '', /^Resolve GitHub issue #7: Loader crashes \(https:\/\/github\.com\/o\/r\/issues\/7\)\n[\s\S]*^> It crashes\.$/m);
});

test('review pane: every task needing you with why, next and its patch; ↑↓ picks, /task acts on the pick, Enter pages its patch', async (t) => {
	const { config, manager, proj } = machine();
	const p = new Project(proj);
	p.add([{ title: 'Second thing' }, { title: 'Third thing' }]);
	p.setStatus('T-0001', 'blocked', 'jarvis-code: check failed: npm test');
	p.setStatus('T-0002', 'review', 'passed, but its changes do not apply to the main tree as it is now');
	const patch = p.research('patch-T-0002-1-x', 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1,2 @@\n-a\n+b\n+c\n');
	p.update('T-0002', (x) => x.attempts.push({ at: new Date().toISOString(), route: 'claude', ok: true, patch }));
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: proj }));
	t.after(() => ui.unmount());
	await sleep(50);
	await type(ui, '/review');
	ui.stdin.write('\r');
	await sleep(80);
	let f = frame(ui);
	assert.match(f, /R E V I E W\s+1 of 2 need you/);
	assert.match(f, /▌blocked T-0001 Wire the parser/);
	assert.match(f, /why {2}check failed: npm test/);
	assert.match(f, /next jarvis-code task retry T-0001/);
	assert.match(f, /patch none kept/);
	ui.stdin.write('\x1b[B');
	await sleep(60);
	f = frame(ui);
	assert.match(f, /2 of 2 need you/);
	assert.match(f, /▌review {2}T-0002 Second thing/);
	assert.match(f, /patch 1 file changed, 2 insertions\(\+\), 1 deletion\(-\): src\/a\.ts/);
	ui.stdin.write('\r');
	await sleep(60);
	assert.match(frame(ui), /D I F F   T - 0 0 0 2/, 'Enter pages the picked task\'s patch');
	ui.stdin.write('\x1b');
	await sleep(60);
	assert.match(frame(ui), /R E V I E W/, 'Esc comes back to the list');
	await type(ui, '/task drop not needed');
	ui.stdin.write('\r');
	await sleep(100);
	assert.equal(p.get('T-0002')?.status, 'dropped', '/task acted on the picked task');
	f = frame(ui);
	assert.match(f, /1 of 1 need you/, 'the list refreshed');
	assert.match(f, /▌blocked T-0001/);
});

test('find command: /find lists matching tasks with status and where; Esc closes it', async (t) => {
	const { config, manager, proj } = machine();
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: proj }));
	t.after(() => ui.unmount());
	await sleep(50);
	await type(ui, '/find');
	ui.stdin.write('\r');
	await sleep(60);
	assert.match(frame(ui), /\/find <text>/);
	await type(ui, '/find parser');
	ui.stdin.write('\r');
	await sleep(80);
	let f = frame(ui);
	assert.match(f, /F I N D   P A R S E R\s+1 task · Esc to close/);
	assert.match(f, /planned +T-0001 Wire the parser +in title/);
	ui.stdin.write('\x1b');
	await sleep(60);
	f = frame(ui);
	assert.doesNotMatch(f, /F I N D/);
});

test('undo command: /undo needs a task, and one with no landed patch says so', async (t) => {
	const { config, manager, proj } = machine();
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: proj }));
	t.after(() => ui.unmount());
	await sleep(50);
	await type(ui, '/undo');
	ui.stdin.write('\r');
	await sleep(60);
	assert.match(frame(ui), /\/undo \[task\|run\]: pick a task/);
	await type(ui, '/undo t-0001');
	ui.stdin.write('\r');
	await sleep(150);
	assert.match(frame(ui), /no landed patch kept for T-0001: nothing to undo/);
	await type(ui, '/undo run');
	ui.stdin.write('\r');
	await sleep(150);
	assert.match(frame(ui), /no run here has landed tasks still in the tree/);
});

test('pane cycle: with an empty prompt in a run, Tab walks the views and Shift+Tab walks back; a pane takes most of the room', async (t) => {
	const { config, manager, root } = machine();
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: root, fast: true }));
	t.after(() => {
		ui.unmount();
		return manager.stopAll();
	});
	await sleep(50);
	ui.stdin.write('\t');
	await sleep(40);
	assert.match(frame(ui), /P R O J E C T S/, 'at home Tab does nothing');
	await type(ui, '/demo');
	ui.stdin.write('\r');
	for (let i = 0; i < 200 && !manager.list()[0]?.finished; i++) await sleep(50);
	await sleep(100);
	const rowsOf = (f: string, label: RegExp) => {
		const lines = f.split('\n');
		const at = lines.findIndex((l) => label.test(l));
		return lines.slice(at).findIndex((l) => l.includes('╰'));
	};
	const queueRows = rowsOf(frame(ui), /Q U E U E/);
	for (const label of ['G R A P H', 'T R E E', 'T I M E L I N E', 'S T A T S', 'I D E A S', 'Q U E U E']) {
		ui.stdin.write('\t');
		await sleep(60);
		assert.match(frame(ui), new RegExp(label), `Tab reached ${label}`);
	}
	ui.stdin.write('\x1b[Z');
	await sleep(60);
	const f = frame(ui);
	assert.match(f, /I D E A S/, 'Shift+Tab went back');
	assert.ok(rowsOf(f, /I D E A S/) > queueRows, 'the pane is taller than the queue view');
	assert.match(f, /Tab views/);
	await type(ui, '/he');
	ui.stdin.write('\t');
	await sleep(40);
	assert.match(frame(ui), /❯ \/help▏/, 'with text in the prompt, Tab still completes');
});

test('diff pager: markers coloured, binary folded, a window of height lines from top, capped with a count', () => {
	const patch = [
		'diff --git a/x.ts b/x.ts',
		'index 1111111..2222222 100644',
		'--- a/x.ts',
		'+++ b/x.ts',
		'@@ -1,3 +1,3 @@',
		' keep\tme',
		'-old',
		'+new',
		'--- was a comment',
		'diff --git a/img.png b/img.png',
		'new file mode 100644',
		'GIT binary patch',
		'literal 3',
		'KcmZ?wbN>Ja',
		'',
		'literal 0',
		'HcmV?d00001',
		'',
		'diff --git a/y.bin b/y.bin',
		'Binary files a/y.bin and b/y.bin differ',
		'',
	].join('\n');
	const lines = pageLines(patch);
	const color = (text: string) => lines.find((l) => l.text === text)?.color;
	for (const head of ['diff --git a/x.ts b/x.ts', 'index 1111111..2222222 100644', '--- a/x.ts', '+++ b/x.ts', '@@ -1,3 +1,3 @@', 'new file mode 100644']) assert.equal(color(head), c.accent, head);
	assert.equal(color('+new'), c.ok);
	assert.equal(color('-old'), c.danger);
	assert.equal(color('--- was a comment'), c.danger, 'a removed line inside a hunk is not a file header');
	assert.equal(color(' keep  me'), c.text, 'tabs become spaces');
	assert.deepEqual(lines.filter((l) => l.text === '[binary]').length, 2, 'a GIT binary patch and a "Binary files differ" line each show as [binary]');
	assert.ok(!lines.some((l) => /literal|KcmZ|HcmV/.test(l.text)), 'binary contents are not shown');
	assert.equal(lines.at(-1)?.text, '[binary]', 'no trailing blank line');

	// A diffstat opens the pager: a row per file, a total, and a blank row before the patch.
	const stat = diffstat(patch);
	assert.deepEqual(stat.map((l) => l.text), [' x.ts    | 3 +--', ' img.png | bin', ' y.bin   | bin', ' 3 files changed, 1 insertion(+), 2 deletions(-)', '']);
	assert.deepEqual(stat[0].parts?.map((p) => p.color), [c.text, c.tick, c.textDim, c.ok, c.danger], 'the path, the bar: + green and - red');
	const wide = diffstat(`diff --git a/big.ts b/big.ts\n@@ -1 +1 @@\n${'+x\n'.repeat(90)}${'-y\n'.repeat(30)}`, 40);
	assert.equal(wide[0].text, ` big.ts | 120 ${'+'.repeat(30)}${'-'.repeat(10)}`, 'scaled to the width, in proportion');
	assert.deepEqual(diffstat('+row 1\n+row 2'), [], 'not a diff: no stat');

	const ui = render(createElement(Pager, { text: patch, height: 3, top: 10 }));
	const f = frame(ui);
	ui.unmount();
	assert.deepEqual(f.split('\n').map((l) => l.trimEnd()), [' keep  me', '-old', '+new']);
	const head = render(createElement(Pager, { text: patch, height: 2, top: 0 }));
	assert.deepEqual(frame(head).split('\n').map((l) => l.trimEnd()), [' x.ts    | 3 +--', ' img.png | bin']);
	head.unmount();

	const long = Array.from({ length: PAGER_MAX + 3 }, (_, i) => `+row ${i + 1}`).join('\n');
	const capped = pageLines(long);
	assert.equal(capped.length, PAGER_MAX + 1);
	assert.equal(capped.at(-1)?.text, '… 3 more lines');
	const end = render(createElement(Pager, { text: long, height: 2, top: 99_999 }));
	const g = frame(end);
	end.unmount();
	assert.deepEqual(g.split('\n').map((l) => l.trimEnd()), [`+row ${PAGER_MAX}`, '… 3 more lines'], 'top past the end shows the last page');
});

test('diff command: /diff pages a task\'s last patch, read once; no patch says so; the feed keeps diffs off', async (t) => {
	assert.equal(DEFAULTS.ui.showDiffs, false, 'the feed stays completions-first');
	const { config, manager, proj } = machine();
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: proj, fast: true }));
	t.after(() => {
		ui.unmount();
		return manager.stopAll();
	});
	const send = async (line: string) => {
		await type(ui, line);
		ui.stdin.write('\r');
		await sleep(60);
		return frame(ui);
	};
	await sleep(80);
	assert.match(await send('/diff'), /\/diff \[task\]: pick a task/);
	assert.match(await send('/diff T-0001'), /no patch for T-0001/);
	assert.doesNotMatch(frame(ui), /D I F F/);

	const rows = Array.from({ length: 30 }, (_, i) => `+row ${String(i + 1).padStart(2, '0')}`);
	const store = new Project(proj);
	const file = store.research('patch-T-0001-1-x', ['diff --git a/f b/f', '@@ -0,0 +1,30 @@', ...rows].join('\n'));
	store.update('T-0001', (task) => {
		task.attempts.push({ at: new Date().toISOString(), route: 'claude:x', ok: false, patch: file });
		task.attempts.push({ at: new Date().toISOString(), route: 'claude:x', ok: false });
	});
	// The default is the open task; the newest attempt that kept a patch is the one shown.
	await send('/task show T-0001');
	let f = await send('/diff');
	assert.match(f, /D I F F/);
	assert.match(f, / f \| 30 \++/, 'the diffstat comes first');
	assert.match(f, /1 file changed, 30 insertions\(\+\), 0 deletions\(-\)/);
	assert.doesNotMatch(f, /Wire the parser/, 'the pager takes the whole body');
	writeFileSync(file, 'diff --git a/g b/g\n+rewritten\n');
	// Two pages down: past the diffstat and the patch's own header.
	ui.stdin.write('\x1b[6~');
	await sleep(60);
	ui.stdin.write('\x1b[6~');
	await sleep(60);
	f = frame(ui);
	assert.doesNotMatch(f, /1 file changed/, 'PgDn scrolls the pager');
	assert.match(f, /\+row \d/);
	assert.doesNotMatch(f, /rewritten|a\/g/, 'the patch is read once, when the command runs');
	ui.stdin.write('\x1b[5~');
	await sleep(60);
	assert.match(frame(ui), /diff --git a\/f b\/f/, 'PgUp scrolls back');
	ui.stdin.write('\x1b');
	await sleep(60);
	f = frame(ui);
	assert.doesNotMatch(f, /D I F F/, 'Esc closes the pager');
	assert.match(f, /Wire the parser/, 'and goes back to what was open');

	// A live run: the patch comes from the run itself.
	await send('/demo');
	const run = manager.list()[0];
	run.o.patch = (id) => (id === 'T-0002' ? 'diff --git a/live b/live\n+from the run\n' : undefined);
	f = await send('/diff t-0002');
	assert.match(f, /D I F F/);
	assert.match(f, / live \| /, 'the live run\'s patch, from its diffstat on');
});

/** A project whose runs use the slow demo agent, so a run stays live while the test types. */
function slowProject(proj: string) {
	writeFileSync(
		join(proj, '.jarvis-code.json'),
		JSON.stringify({ agents: { claude: { kind: 'claude', enabled: true, bin: demoAgent, models: ['claude-fable-5-1'], env: { JC_DEMO_PACE: '800' } } }, planner: ['claude:claude-fable-5-1'], workers: ['claude:claude-fable-5-1'], planning: { mode: 'direct' } }),
	);
}

test('cockpit queue: goals typed during a run are queued, /queue lists them, /unqueue takes one off, the status line shows them', async (t) => {
	const { config, manager, proj } = machine();
	slowProject(proj);
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: proj }));
	t.after(() => {
		ui.unmount();
		return manager.stopAll();
	});
	await sleep(50);
	const send = async (line: string) => {
		await type(ui, line);
		ui.stdin.write('\r');
		await sleep(80);
	};
	await send('first goal');
	for (let i = 0; i < 40 && !manager.list().length; i++) await sleep(25);
	const run = manager.list()[0];
	assert.ok(run && !run.finished, 'the first goal started a run');
	await send('second goal');
	assert.match(frame(ui), new RegExp(`queued #1 in alpha: starts when run #${run.id} ends`));
	await send('/run third goal');
	assert.match(frame(ui), /queued #2 in alpha/);
	await send('/brainstorm fourth goal');
	assert.match(frame(ui), /queued #3 in alpha.*\(as a/, 'a brainstorm queues its plain goal and says so');
	assert.equal(manager.list().length, 1, 'no second run started');
	ui.stdin.write('\r');
	await sleep(80);
	assert.match(frame(ui), /run #\d+ · next: 1 second goal · 2 third goal/, "the run view's status line shows the queue");
	await send('/queue');
	assert.match(frame(ui), /1 second goal · 2 third goal · 3 fourth goal/);
	await send('/unqueue 1');
	assert.match(frame(ui), /unqueued: second goal/);
	assert.deepEqual(manager.queued(proj).map((g) => g.goal), ['third goal', 'fourth goal']);
	await send('/unqueue 9');
	assert.match(frame(ui), /no queued goal 9/);
	ui.stdin.write('\r');
	await sleep(80);
	assert.match(frame(ui), /next: 1 third goal · 2 fourth goal/, 'the status line follows /unqueue');
	manager.stop(run);
	await run.done;
});

test('tell command: /tell needs an id and a note, keeps the note as the hint with no run, and sends it to a live run', async (t) => {
	const { config, manager, proj } = machine();
	const ui = render(createElement(Cockpit, { manager, config, depth: 'none', cwd: proj }));
	t.after(() => {
		ui.unmount();
		return manager.stopAll();
	});
	await sleep(50);
	const send = async (line: string) => {
		await type(ui, line);
		ui.stdin.write('\r');
		await sleep(80);
	};
	await send('/tell');
	assert.match(frame(ui), /\/tell <task id> <note>/);
	await send('/tell T-0001');
	assert.match(frame(ui), /\/tell <task id> <note>/, 'a note is needed too');
	await send('/tell t-0001 mind the tabs');
	assert.match(frame(ui), /T-0001: note kept as its hint/);
	await send('/tell T-0001 and the quotes');
	assert.equal(Project.open(proj)!.get('T-0001')!.hint, 'mind the tabs\nand the quotes', 'notes add up');
	await send('/tell T-0099 hello');
	assert.match(frame(ui), /no task T-0099/);

	slowProject(proj);
	await send('/work');
	for (let i = 0; i < 100 && manager.list()[0]?.o.snapshot().phase !== 'working'; i++) await sleep(50);
	const run = manager.list()[0];
	assert.ok(run && !run.finished, 'a run is going');
	await send('/tell T-0001 use the fast path');
	assert.match(frame(ui), /T-0001: note kept for its next attempt/);
	assert.ok(run.o.snapshot().activity.some((a) => /T-0001: note kept for its next attempt/.test(a.text)), "the live run's tell took it");
	assert.match(Project.open(proj)!.get('T-0001')!.hint ?? '', /use the fast path/);
	manager.stop(run);
	await run.done;
});
