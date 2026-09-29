import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decideTask, listStored, nextStep, Project, type RunRecord } from '../src/store.js';
import { readIntent } from '../src/intent.js';
import { MemorySource, StoreSource } from '../src/tasks.js';
import { undo, undoRun } from '../src/worktree.js';
import { Learning } from '../src/learn.js';
import { DEFAULTS } from '../src/config.js';
import { workerPrompt } from '../src/orchestrator.js';
import { contextPack } from '../src/context.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `jc-${p}-`));
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('store: ids are unique, plan keys resolve to ids, and open() never creates', () => {
	const root = tmp('store');
	const dir = tmp('proj');
	assert.equal(Project.open(dir, root), undefined);
	const p = new Project(dir, root);
	const [a, b] = p.add([{ key: 'x', title: 'A' }, { title: 'B', depends: ['x', 'nonsense'] }], { goal: 'g', source: 'plan' });
	assert.deepEqual([a.id, b.id], ['T-0001', 'T-0002']);
	assert.deepEqual(b.depends, ['T-0001']);
	assert.equal(b.goal, 'g');
	// A second handle on the same project sees the same tasks and continues the numbering.
	const again = Project.open(dir, root)!;
	assert.equal(again.add([{ title: 'C' }])[0].id, 'T-0003');
	assert.deepEqual(listStored(root).map((m) => m.path), [p.meta.path]);
});

test('store: a task keeps the files its plan declared', async () => {
	const dir = tmp('proj');
	const root = tmp('store');
	const files = ['src/a.ts', 'test/a.test.ts'];
	const [t] = await new StoreSource(new Project(dir, root), dir, 30).add([{ title: 'A', files }, { title: 'B' }]).then((ids) => ids.map((id) => Project.open(dir, root)!.get(id)!));
	assert.deepEqual(t.files, files);
	const queued = await new StoreSource(Project.open(dir, root)!, dir, 30).next(new Set());
	assert.deepEqual(queued.map((q) => q.files), [files, undefined]);
	const mem = new MemorySource(dir, 30);
	await mem.add([{ title: 'A', files }]);
	assert.deepEqual((await mem.next(new Set()))[0].files, files);
});

test('store: queue follows type order, but a dependency always comes first', () => {
	const p = new Project(tmp('proj'), tmp('store'));
	p.add([
		{ key: 'f', title: 'feature', type: 'FEATURE' },
		{ key: 'c', title: 'clean', type: 'CLEAN' },
		{ key: 'x', title: 'fix after feature', type: 'FIX', depends: ['f'] },
		{ key: 'r', title: 'research', type: 'RESEARCH' },
	]);
	assert.deepEqual(p.queue().map((t) => t.title), ['research', 'clean', 'feature', 'fix after feature']);
	p.setStatus('T-0001', 'done');
	p.setStatus('T-0002', 'blocked', 'needs a key');
	assert.deepEqual(p.queue().map((t) => t.title), ['research', 'fix after feature']);
	assert.equal(p.get('T-0002')?.reason, 'needs a key');
	assert.deepEqual(p.summary(), { planned: 2, active: 0, review: 0, blocked: 1, deferred: 0, done: 1, dropped: 0 });
});

test('store: a bumped task goes first among ready tasks', () => {
	const p = new Project(tmp('proj'), tmp('store'));
	p.add([
		{ key: 'r', title: 'research', type: 'RESEARCH' },
		{ key: 'f', title: 'feature', type: 'FEATURE' },
		{ key: 'x', title: 'fix after feature', type: 'FIX', depends: ['f'] },
	]);
	p.bump('T-0003');
	assert.deepEqual(p.queue().map((t) => t.title), ['feature', 'fix after feature', 'research']);

	p.setStatus('T-0001', 'done');
	assert.throws(() => p.bump('T-0001'), /no queued task/);

	const events = readFileSync(join(p.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
	assert.ok(events.some((e) => e.event === 'bumped' && e.id === 'T-0003'));
});

test('store: lessons come newest first', () => {
	const p = new Project(tmp('proj'), tmp('store'));
	p.add([{ title: 'one' }, { title: 'two' }]);
	p.update('T-0001', (t) => t.lessons.push('old'));
	p.update('T-0002', (t) => t.lessons.push('new'));
	assert.deepEqual(p.lessons(), ['new', 'old']);
});

test('store: lifetime spend sums attempt costs and status --all --json reports it', () => {
	const root = tmp('state');
	process.env.JARVIS_CODE_STATE = join(root, 'jc');
	process.env.XDG_CONFIG_HOME = join(root, 'config');
	mkdirSync(join(root, 'config', 'jarvis-code'), { recursive: true });
	writeFileSync(join(root, 'config', 'jarvis-code', 'config.json'), JSON.stringify({ agents: { claude: { enabled: false }, codex: { enabled: false }, opencode: { enabled: false } } }));
	const dir = tmp('proj');
	const p = new Project(dir);
	p.add([{ title: 'one' }, { title: 'two' }]);
	p.update('T-0001', (t) => t.attempts.push({ at: new Date().toISOString(), route: 'claude:m', ok: true, costUsd: 0.25 }));
	p.update('T-0002', (t) => t.attempts.push({ at: new Date().toISOString(), route: 'claude:m', ok: true, costUsd: 0.17 }));
	p.update('T-0002', (t) => t.attempts.push({ at: new Date().toISOString(), route: 'claude:m', ok: false }));
	assert.ok(Math.abs(p.spent() - 0.42) < 1e-9, `expected ~0.42, got ${p.spent()}`);

	const out = execFileSync(process.execPath, [cli, 'status', '--all', '--json'], { env: { ...process.env }, encoding: 'utf8' });
	const row = (JSON.parse(out) as { path: string; spent: number }[]).find((r) => r.path === dir);
	assert.ok(row, 'the project appears in status --all --json');
	assert.ok(Math.abs(row!.spent - 0.42) < 1e-9, `expected ~0.42 from the CLI, got ${row!.spent}`);
});

test('store: a decision on a status word acts on every task in it', () => {
	const p = new Project(tmp('proj'), tmp('store'));
	p.add([{ title: 'a' }, { title: 'b' }, { title: 'c' }]);
	p.setStatus('T-0001', 'blocked', 'x');
	p.setStatus('T-0002', 'blocked', 'y');

	const msg = decideTask(p, 'retry', 'blocked');
	assert.match(msg, /2 tasks back in the queue: T-0001, T-0002/);
	assert.equal(p.get('T-0001')?.status, 'planned');
	assert.equal(p.get('T-0002')?.status, 'planned');
	assert.equal(p.get('T-0003')?.status, 'planned');

	const events = readFileSync(join(p.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
	assert.equal(events.filter((e) => e.event === 'planned').length, 2);

	assert.throws(() => decideTask(p, 'approve', 'review'));
});

test('intent decisions: drop and approve record the title and project, one per task in bulk; off records nothing', () => {
	process.env.JARVIS_CODE_STATE = join(tmp('state'), 'jc');
	const dir = tmp('proj');
	const p = new Project(dir, tmp('store'));
	p.add([{ title: 'rewrite the router' }, { title: 'add dark mode' }, { title: 'fix login' }, { title: 'port to rust' }]);
	decideTask(p, 'drop', 'T-0004', 'not now', { intent: false });
	decideTask(p, 'retry', 'T-0004', undefined, { intent: true });
	assert.deepEqual(readIntent(), []);

	decideTask(p, 'drop', 'T-0001', 'not wanted', { intent: true });
	p.setStatus('T-0002', 'review', 'no verify command');
	p.setStatus('T-0003', 'review', 'no verify command');
	decideTask(p, 'approve', 'review', undefined, { intent: true });
	const name = p.meta.name;
	assert.deepEqual(
		readIntent().map((e) => [e.kind, e.text, e.project]),
		[['dropped', 'rewrite the router', name], ['accepted', 'add dark mode', name], ['accepted', 'fix login', name]],
	);
});

test('store: a retry with a why carries it to the next worker as a hint', () => {
	const p = new Project(tmp('proj'), tmp('store'));
	const dir = tmp('cwd');
	p.add([{ title: 'a' }]);
	p.setStatus('T-0001', 'blocked', 'x');

	decideTask(p, 'retry', 'T-0001', 'the fixture is in test/data');
	assert.equal(p.get('T-0001')?.hint, 'the fixture is in test/data');

	const source = new StoreSource(p, dir, 60);
	const next = source.next(new Set());
	return next.then((tasks) => {
		const task = tasks.find((t) => t.id === 'T-0001')!;
		assert.equal(task.hint, 'the fixture is in test/data');
		assert.match(workerPrompt(task, dir, {}), /A person's notes on this task \(sent with it or while it ran\):\nthe fixture is in test\/data/);

		p.setStatus('T-0001', 'blocked', 'y');
		decideTask(p, 'retry', 'T-0001');
		assert.equal(p.get('T-0001')?.hint, undefined);
	});
});

test('store: a plain retry after two failures with the same cause warns', () => {
	const p = new Project(tmp('proj'), tmp('store'));
	const attempt = (cause: string) => ({ at: new Date().toISOString(), route: 'claude', ok: false, cause });

	p.add([{ title: 'a' }]);
	p.setStatus('T-0001', 'blocked', 'x');
	p.update('T-0001', (t) => { t.attempts = [attempt('env'), attempt('env')]; });
	const msg = decideTask(p, 'retry', 'T-0001');
	assert.match(msg, /likely fail again/);
	assert.equal(p.get('T-0001')?.status, 'planned');

	p.add([{ title: 'b' }]);
	p.setStatus('T-0002', 'blocked', 'x');
	p.update('T-0002', (t) => { t.attempts = [attempt('env'), attempt('env')]; });
	assert.doesNotMatch(decideTask(p, 'retry', 'T-0002', 'try again with more memory'), /likely fail again/);

	p.add([{ title: 'c' }]);
	p.setStatus('T-0003', 'blocked', 'x');
	p.update('T-0003', (t) => { t.attempts = [attempt('env'), attempt('timeout')]; });
	assert.doesNotMatch(decideTask(p, 'retry', 'T-0003'), /likely fail again/);

	p.add([{ title: 'd' }]);
	p.setStatus('T-0004', 'blocked', 'x');
	p.update('T-0004', (t) => { t.attempts = [attempt('flaky'), attempt('flaky')]; });
	assert.doesNotMatch(decideTask(p, 'retry', 'T-0004'), /likely fail again/);
});

test('store: nextStep names the command that resolves each kind of stuck task', () => {
	const id = 'T-0001';
	const at = (status: 'planned' | 'active' | 'review' | 'blocked' | 'deferred' | 'done' | 'dropped', reason?: string) => nextStep({ id, status, reason });

	assert.match(
		at('blocked', 'jarvis-code: check fails the same way on 2 routes (npm test): likely the check or the environment, not the agents')!,
		/npm test.*fails the same way on every route.*jarvis-code task retry T-0001/,
	);
	assert.match(at('blocked', 'jarvis-code: review asked for changes: add a test')!, /jarvis-code task retry T-0001/);
	assert.match(at('blocked', 'jarvis-code: no agent route available')!, /jarvis-code status.*jarvis-code learn reset/);
	assert.match(at('blocked', 'jarvis-code: agent failed')!, /jarvis-code task retry T-0001 "<what the next worker should know>"/);
	assert.match(
		at('review', 'passed, but its changes do not apply to the main tree as it is now (patch does not apply)')!,
		/jarvis-code task retry T-0001/,
	);
	assert.match(
		at('review', 'its changes landed, then failed npm test, and could not be taken back out (git revert failed): they are in your tree')!,
		/jarvis-code task approve T-0001/,
	);
	assert.match(at('review', 'passed, needs review')!, /jarvis-code task approve T-0001/);
	assert.match(at('deferred', 'found while working T-0000')!, /jarvis-code task retry T-0001/);

	for (const status of ['planned', 'active', 'done', 'dropped'] as const) assert.equal(at(status), undefined);
});

test('store: reports lists past run reports newest first', () => {
	const p = new Project(tmp('proj'), tmp('store'));
	assert.deepEqual(p.reports(), []);

	const older = p.research('report-old', '# one\n\n2024-01-01T00:00:00.000Z · proj · did a thing\n');
	const newer = p.research('report-new', '# two\n\n2024-01-02T00:00:00.000Z · proj · did another thing\n');
	p.research('plan-x', '# plan\n\nnotes\n');
	utimesSync(older, new Date('2024-01-01'), new Date('2024-01-01'));
	utimesSync(newer, new Date('2024-01-02'), new Date('2024-01-02'));

	const reports = p.reports();
	assert.deepEqual(reports.map((r) => r.file), ['report-new.md', 'report-old.md']);
	assert.equal(reports[0].at, new Date('2024-01-02').toISOString());
	assert.equal(reports[0].summary, '2024-01-02T00:00:00.000Z · proj · did another thing');
	assert.equal(reports[1].summary, '2024-01-01T00:00:00.000Z · proj · did a thing');
});

test('store: first-try rate by tier reaches the planner', () => {
	const dir = tmp('proj');
	const p = new Project(dir, tmp('store'));
	assert.equal(p.firstTry(), undefined);
	p.add([{ title: 'a' }, { title: 'b' }, { title: 'c' }, { title: 'd' }, { title: 'e', tier: 'm' }, { title: 'untried' }]);
	const tries = (...oks: boolean[]) => (t: { attempts: { at: string; route: string; ok: boolean }[] }) => (t.attempts = oks.map((ok) => ({ at: 'x', route: 'r', ok })));
	for (const id of ['T-0001', 'T-0002', 'T-0003']) p.update(id, tries(true));
	p.update('T-0004', tries(false, true));
	p.update('T-0005', tries(false));
	const sizing = p.firstTry();
	assert.equal(sizing, 'S: 3 of 4 passed on the first attempt; M: 0 of 1');
	assert.equal(new StoreSource(p, dir, 30).sizing(), sizing);
	assert.match(contextPack(tmp('cwd'), { sizing, workers: ['claude'] }), /How tasks here went, by tier: S: 3 of 4 passed on the first attempt; M: 0 of 1\n\nWorkers available/);
	assert.doesNotMatch(contextPack(tmp('cwd'), { workers: ['claude'] }), /How tasks here went/);
});

test('store: failure causes of failed attempts reach the planner, most common first', () => {
	const p = new Project(tmp('proj'), tmp('store'));
	p.add([{ title: 'a' }, { title: 'b' }]);
	const fail = (cause?: string) => ({ at: 'x', route: 'r', ok: false, cause });
	p.update('T-0001', (t) => (t.attempts = [fail('agent'), fail('too-big'), { at: 'x', route: 'r', ok: true }]));
	p.update('T-0002', (t) => (t.attempts = [fail('too-big'), fail()]));
	assert.equal(p.firstTry(), 'S: 0 of 2 passed on the first attempt; failed attempts by cause: too-big 2, agent 1');
});

test('goal queue: positions, no duplicates, oldest first, survives a new handle, a bad file is empty', () => {
	const dir = tmp('proj');
	const root = tmp('store');
	const p = new Project(dir, root);
	assert.deepEqual(p.goals(), []);
	assert.equal(p.nextGoal(), undefined);
	assert.equal(p.enqueue('add a'), 1);
	assert.equal(p.enqueue('add b'), 2);
	assert.equal(p.enqueue('add a'), 1);
	assert.equal(p.enqueue('add c'), 3);
	assert.deepEqual(p.goals().map((g) => g.goal), ['add a', 'add b', 'add c']);
	assert.equal(typeof p.goals()[0].at, 'string');
	// Another handle on the same project sees the same queue.
	const again = Project.open(dir, root)!;
	assert.equal(again.unqueue(2)?.goal, 'add b');
	assert.equal(again.unqueue(5), undefined);
	assert.equal(p.nextGoal(), 'add a');
	assert.deepEqual(p.goals().map((g) => g.goal), ['add c']);
	const events = readFileSync(join(p.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).event);
	assert.deepEqual(events.filter((e) => e === 'queue' || e === 'unqueue'), ['queue', 'queue', 'queue', 'unqueue', 'unqueue']);
	writeFileSync(join(p.dir, 'goals.json'), '{ not json');
	assert.deepEqual(p.goals(), []);
	assert.equal(p.enqueue('add d'), 1);
});

test('history: each finished run appends a line; read newest first, the newest 500 kept', () => {
	const p = new Project(mkdtempSync(join(tmpdir(), 'jc-hist-')), mkdtempSync(join(tmpdir(), 'jc-hist-store-')));
	assert.deepEqual(p.history(), [], 'no runs yet');
	const run = (n: number): RunRecord => ({ at: new Date(Date.UTC(2026, 8, 29, 0, n)).toISOString(), minutes: n, goal: `goal ${n}`, total: 4, done: n % 5, blocked: 0, review: 0, cost: n / 10, planning: 0.1, agents: 3, stopped: false });
	for (let n = 1; n <= 3; n++) p.recordRun(run(n));
	assert.deepEqual(p.history().map((r) => r.goal), ['goal 3', 'goal 2', 'goal 1']);
	writeFileSync(join(p.dir, 'runs.jsonl'), `${readFileSync(join(p.dir, 'runs.jsonl'), 'utf8')}not json\n`);
	assert.equal(p.history().length, 3, 'a torn line is skipped, not fatal');
	for (let n = 4; n <= 505; n++) p.recordRun(run(n));
	const all = p.history();
	assert.equal(all.length, 500);
	assert.equal(all[0].goal, 'goal 505');
	assert.equal(all.at(-1)!.goal, 'goal 6');
});

test('undo: a landed task\'s kept patch is taken back out and the task deferred; a patch that no longer reverses changes nothing', async () => {
	const repo = mkdtempSync(join(tmpdir(), 'jc-undo-'));
	const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
	git('init', '-q');
	writeFileSync(join(repo, 'a.txt'), 'one\n');
	git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
	git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
	writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
	const patch = git('diff');
	const p = new Project(repo, mkdtempSync(join(tmpdir(), 'jc-undo-store-')));
	const [t] = p.add([{ title: 'add line two' }]);
	const file = p.research(`patch-${t.id}-1-x`, patch);
	p.update(t.id, (x) => x.attempts.push({ at: new Date().toISOString(), route: 'claude', ok: true, patch: file }));
	p.setStatus(t.id, 'done');
	const learning = new Learning({ ...DEFAULTS.learning, minSamples: 1 }, join(mkdtempSync(join(tmpdir(), 'jc-undo-l-')), 'l.json'));
	const told: { kind: string; text: string }[] = [];
	p.lock({ goal: 'another task' });
	await assert.rejects(undo(p, repo, t.id), /a run is going in this project: stop it first/, 'a live run may be editing the same tree');
	p.unlock();
	assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'one\ntwo\n');
	assert.match(await undo(p, repo, t.id, { learning, intent: (e) => told.push(e) }), /took T-0001's changes back out.*claude marked down/);
	assert.equal(learning.data.routes.claude.runs, 1, 'the route that did it is charged');
	assert.equal(learning.data.routes.claude.ok, 0);
	assert.equal(learning.kind('claude', 'FEATURE')?.runs, 1, 'and for its task type');
	assert.deepEqual(told, [{ kind: 'dropped', text: 'add line two', project: p.meta.name }].map(({ kind, text }) => ({ kind, text, project: p.meta.name })));
	assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'one\n');
	assert.equal(p.get(t.id)?.status, 'deferred');
	assert.match(p.get(t.id)?.reason ?? '', /undone/);
	await assert.rejects(undo(p, repo, t.id), /could not take T-0001's changes back out/, 'already out: git apply refuses, all or nothing');
	assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'one\n');
	const [u] = p.add([{ title: 'never landed' }]);
	await assert.rejects(undo(p, repo, u.id), /no landed patch kept for T-0002/);
	await assert.rejects(undo(p, repo, 'T-0404'), /no task T-0404/);
});

test('undo run: the newest run still standing comes out newest first, then the one before; a patch that will not reverse stops it', async () => {
	const repo = mkdtempSync(join(tmpdir(), 'jc-undorun-'));
	const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });
	git('init', '-q');
	writeFileSync(join(repo, 'a.txt'), 'one\n');
	git('add', '.');
	git('commit', '-qm', 'base');
	const p = new Project(repo, mkdtempSync(join(tmpdir(), 'jc-undorun-store-')));
	const lands = (file: string, text: string) => {
		const [t] = p.add([{ title: `write ${file}` }]);
		writeFileSync(join(repo, file), text);
		git('add', '-A');
		const patch = git('diff', '--cached');
		git('commit', '-qm', t.id);
		const kept = p.research(`patch-${t.id}-1-x`, patch);
		p.update(t.id, (x) => x.attempts.push({ at: new Date().toISOString(), route: 'claude', ok: true, patch: kept }));
		p.setStatus(t.id, 'done');
		return t.id;
	};
	const record = (n: number, landed: string[]) => p.recordRun({ at: new Date(Date.UTC(2026, 8, 29, 0, n)).toISOString(), minutes: 1, total: landed.length, done: landed.length, blocked: 0, review: 0, cost: 0, planning: 0, agents: 1, stopped: false, landed });
	const read = (f: string) => (existsSync(join(repo, f)) ? readFileSync(join(repo, f), 'utf8') : undefined);
	await assert.rejects(undoRun(p, repo), /no run here has landed tasks still in the tree/);
	record(1, [lands('a.txt', 'one\ntwo\n')]);
	record(2, [lands('b.txt', 'b\n'), lands('a.txt', 'one\ntwo\nthree\n')]);
	assert.match(await undoRun(p, repo), /took the 2026-09-29 00:02 run's 2 landed tasks back out of .*, newest first: T-0003, T-0002; each is deferred/);
	assert.deepEqual([read('a.txt'), read('b.txt')], ['one\ntwo\n', undefined]);
	assert.match(await undoRun(p, repo), /00:01 run's 1 landed task back out.*: T-0001;/, 'again: the run before');
	assert.equal(read('a.txt'), 'one\n');
	assert.deepEqual(p.tasks().map((t) => t.status), ['deferred', 'deferred', 'deferred']);
	await assert.rejects(undoRun(p, repo), /no run here has landed tasks still in the tree/);
	record(3, [lands('c.txt', 'c\n'), lands('d.txt', 'd\n')]);
	writeFileSync(join(repo, 'c.txt'), 'changed since\n');
	await assert.rejects(undoRun(p, repo), /^Error: took T-0005 back out, then stopped at T-0004: could not take T-0004's changes back out \(nothing was changed\).*; T-0004 stays in the tree$/);
	assert.deepEqual([read('c.txt'), read('d.txt'), p.get('T-0004')?.status, p.get('T-0005')?.status], ['changed since\n', undefined, 'done', 'deferred']);
});

test('find: tasks matching in any field or by a file their patch touched, case-insensitive, with where', () => {
	const p = new Project(mkdtempSync(join(tmpdir(), 'jc-find-')), mkdtempSync(join(tmpdir(), 'jc-find-store-')));
	const [a, b, c] = p.add([
		{ title: 'Add the settings loader', brief: 'reads JSON', files: ['src/settings.ts'] },
		{ title: 'Speed up startup', acs: [{ text: 'boots fast', verify: 'npm run bench' }] },
		{ title: 'Unrelated' },
	]);
	const patch = p.research('patch-T-0002-1-x', 'diff --git a/src/Loader.ts b/src/Loader.ts\n@@ -1 +1 @@\n-a\n+b\n');
	p.update(b.id, (t) => t.attempts.push({ at: new Date().toISOString(), route: 'claude', ok: true, patch, summary: 'cached the config' }));
	p.update(c.id, (t) => (t.lessons = ['the LOADER needs a warm cache']));
	const found = p.find('loader');
	assert.deepEqual(found.map((f) => [f.task.id, f.where]), [[a.id, ['title']], [b.id, ['patch: src/Loader.ts']], [c.id, ['lessons']]]);
	assert.deepEqual(p.find('settings.ts').map((f) => f.where), [['files']]);
	assert.deepEqual(p.find('bench').map((f) => f.where), [['criteria']]);
	assert.deepEqual(p.find('cached').map((f) => f.where), [['attempts']]);
	assert.deepEqual(p.find('  '), [], 'blank finds nothing');
});
