#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { agentEnabled, DEFAULTS, loadConfig, merge, normalize, onPath, paths, trustProject, untrustProject, type Config } from './config.js';
import { intentFile, intentSummary, resetIntent } from './intent.js';
import { Learning, routesFor, score } from './learn.js';
import { Orchestrator } from './orchestrator.js';
import { improveGoal, nextRound } from './pipeline.js';
import { attachPlain } from './plain.js';
import { install, installed, PLUGIN_DIR, ROOT, TARGETS, uninstall, type Target } from './plugin.js';
import { RunManager, demoConfig, runDetached, stopElsewhere, type Run } from './runs.js';
import { BULK, decideTask, DECISIONS, listStored, nextStep, Project, TYPES, type Decision, type Status, type StoredTask } from './store.js';
import { MemorySource, StoreSource, type TaskSource } from './tasks.js';
import { colorDepth, paint, palette } from './theme.js';

const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;

const HELP = `jarvis-code ${VERSION} — orchestration for Claude Code, Codex, OpenCode and other coding agents

Usage
  jarvis-code                     the cockpit: every project, runs, a prompt for goals and /commands
  jarvis-code "<goal>"            plan the goal into tasks, then work them (opens the cockpit on the run)
  jarvis-code work                work this project's open tasks, no planning
  jarvis-code improve [focus]     find and make the most valuable improvements here (brainstormed first),
                                  in rounds that each build on the last until one lands too little
  jarvis-code demo                simulated agents: see the TUI, learning and re-upgrades (no API calls)
  jarvis-code status              the queue, the agents and their learned health
  jarvis-code stop                end this project's background or CLI run
  jarvis-code tasks [--all]       this project's tasks (--all includes done and dropped)
  jarvis-code task add "<title>" [--type T] [--tier S|M|L] [--ac "<done when> :: <verify cmd>"]...
  jarvis-code task show|retry|defer|drop|approve ID|blocked|review [why]
  jarvis-code status --all [--json]   every project's queue (JSON for scripts)
  jarvis-code learn [reset [KEY]] what was learned about routes and tools; forget it
  jarvis-code intent [reset]      what you asked for and turned down, across projects (redacted); forget it
  jarvis-code config [show|path|init [--project]|trust|untrust]
  jarvis-code plugin <install|uninstall|status> [claude|codex|opencode]
  jarvis-code doctor              check agents, plugin and terminal

Options
  --plain                 line output instead of the TUI (automatic when not a terminal)
  --detach                run in the background (a goal, work or improve); the log is kept with the tasks
  --tasks store|memory    where tasks live (default: store, jarvis-code's own per-project state)
  --planning MODE         auto: a prompt writer grounds the goal, open goals are brainstormed first (default)
                          direct: one planner · deep: always brainstorm
  --worker ROUTE          worker route, repeatable, in preference order (agent or agent:model)
  --planner ROUTE         planner route, repeatable
  --parallel N            workers at once (default 1; >1 shares one working tree)
  --attempts N            attempts per task across routes (default 3)
  --budget USD            stop the run once it has cost this much (kills its workers)
  --max-minutes N         stop the run after N minutes
  --rounds N --min K      improve: at most N rounds (default 3); a round landing under K tasks ends it (default 1)
  --show-diffs --show-tools --show-text   feed detail (off by default)
  --reactor large|small|off   --reduced-motion   --cwd DIR
  --fast                  demo: run at test speed
`;

function die(msg: string, code = 2): never {
	process.stderr.write(`jarvis-code: ${msg}\n`);
	process.exit(code);
}

const depth = colorDepth(process.env, !!process.stdout.isTTY);
const say = (s = '') => process.stdout.write(s + '\n');
const tone = (s: string, t: keyof typeof palette) => paint(s, palette[t], 1, depth);

async function main(argv: string[]) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				plain: { type: 'boolean' },
				tasks: { type: 'string' },
				planning: { type: 'string' },
				worker: { type: 'string', multiple: true },
				planner: { type: 'string', multiple: true },
				parallel: { type: 'string' },
				attempts: { type: 'string' },
				budget: { type: 'string' },
				'max-minutes': { type: 'string' },
				rounds: { type: 'string' },
				min: { type: 'string' },
				detach: { type: 'boolean' },
				'show-diffs': { type: 'boolean' },
				'show-tools': { type: 'boolean' },
				'show-text': { type: 'boolean' },
				reactor: { type: 'string' },
				'reduced-motion': { type: 'boolean' },
				cwd: { type: 'string' },
				fast: { type: 'boolean' },
				project: { type: 'boolean' },
				all: { type: 'boolean' },
				json: { type: 'boolean' },
				type: { type: 'string' },
				tier: { type: 'string' },
				ac: { type: 'string', multiple: true },
				help: { type: 'boolean', short: 'h' },
				version: { type: 'boolean', short: 'v' },
			},
		});
	} catch (e) {
		die((e as Error).message);
	}
	const { values: f, positionals: pos } = parsed;
	if (f.help) return say(HELP);
	if (f.version) return say(VERSION);
	const cwd = resolve(f.cwd ?? process.cwd());
	const int = (v: string | undefined, name: string) => {
		if (v === undefined) return undefined;
		const n = Number(v);
		if (!Number.isInteger(n) || n < 1) die(`--${name} must be a positive integer`);
		return n;
	};
	const whole = (v: string, name: string) => {
		if (!/^\d+$/.test(v)) die(`--${name} must be a whole number, 0 or more`);
		return Number(v);
	};
	const positive = (v: string, name: string) => {
		const n = Number(v);
		if (!(n > 0)) die(`--${name} must be a number above 0`);
		return n;
	};
	if (f.reactor && !['large', 'small', 'off'].includes(f.reactor)) die('--reactor must be large, small or off');
	if (f.planning && !['auto', 'direct', 'deep'].includes(f.planning)) die('--planning must be auto, direct or deep');
	const overrides = {
		...(f.worker && { workers: f.worker }),
		...(f.planner && { planner: f.planner }),
		...(f.parallel && { maxParallel: int(f.parallel, 'parallel') }),
		...(f.attempts && { maxAttempts: int(f.attempts, 'attempts') }),
		...(f.planning && { planning: { mode: f.planning } }),
		...((f.rounds !== undefined || f.min !== undefined) && { improve: { ...(f.rounds !== undefined && { rounds: int(f.rounds, 'rounds') }), ...(f.min !== undefined && { minLanded: whole(f.min, 'min') }) } }),
		...((f.budget || f['max-minutes']) && { budget: { ...(f.budget && { usd: positive(f.budget, 'budget') }), ...(f['max-minutes'] && { minutes: positive(f['max-minutes'], 'max-minutes') }) } }),
		ui: {
			...(f['show-diffs'] && { showDiffs: true }),
			...(f['show-tools'] && { showTools: true }),
			...(f['show-text'] && { showText: true }),
			...(f.reactor && { reactor: f.reactor }),
			...(f['reduced-motion'] && { reducedMotion: true }),
		},
	};
	let config: Config;
	let sources: string[];
	let warnings: string[];
	try {
		({ config, sources, warnings } = loadConfig(cwd, overrides));
	} catch (e) {
		die((e as Error).message);
	}
	if (pos[0] !== 'config') for (const w of warnings) process.stderr.write(`${tone('jarvis-code', 'warn')}: ${w}\n`);

	const [cmd, ...rest] = pos;
	const tui = !f.plain && !!process.stdout.isTTY && !!process.stdin.isTTY;
	switch (cmd) {
		case 'demo':
			if (tui) return cockpit(config, cwd, overrides, (m) => m.startDemo(!!f.fast), !!f.fast);
			return demo(config, !!f.fast);
		case 'status':
			return f.all ? statusAll(!!f.json) : status(config, cwd);
		case 'stop':
			return stopCmd(cwd);
		case 'tasks':
			return tasksCmd(cwd, !!f.all);
		case 'task':
			return taskCmd(cwd, rest, { type: f.type, tier: f.tier, ac: f.ac, intent: config.intent });
		case 'learn':
			return learn(config, rest);
		case 'intent':
			return intentCmd(config, rest);
		case 'config':
			return configCmd(config, sources, cwd, rest, !!f.project);
		case 'plugin':
			return pluginCmd(rest);
		case 'doctor':
			return doctor(config, cwd, sources);
		case 'help':
			return say(HELP);
		case 'improve': {
			const focus = rest.join(' ') || undefined;
			const goal = improveGoal(focus);
			const deep = { planning: { mode: 'deep' } };
			if (f.detach) return detach(cwd, argv, f.tasks);
			if (tui) return cockpit(config, cwd, overrides, (m) => m.improve(cwd, { focus, ...config.improve }));
			return run(normalize(merge(config, deep)), cwd, goal, f.tasks, { focus });
		}
		case 'work':
		case 'run':
		case undefined:
		default: {
			const goal = cmd === 'work' || cmd === undefined ? undefined : (cmd === 'run' ? rest : pos).join(' ') || undefined;
			if (f.detach && cmd !== undefined) return detach(cwd, argv, f.tasks);
			if (tui) {
				if (f.tasks && f.tasks !== 'store' && f.tasks !== 'memory') die('--tasks must be store or memory');
				const memory = f.tasks === 'memory';
				if (cmd === undefined) return cockpit(config, cwd, overrides);
				return cockpit(config, cwd, overrides, (m) => m.start(cwd, { goal, memory }));
			}
			if (cmd === undefined) return say(HELP);
			return run(config, cwd, goal, f.tasks);
		}
	}
}

/**
 * The cockpit: every project and run, a prompt for goals and commands. `start` opens it on a
 * run (a goal, `work`, the demo); without it the cockpit opens on the project list.
 */
async function cockpit(config: Config, cwd: string, overrides: unknown, start?: (m: RunManager) => Run | Promise<Run>, fast = false) {
	const manager = new RunManager(new Learning(config.learning), { overrides });
	let focus: Run | undefined;
	try {
		focus = start ? await start(manager) : undefined;
	} catch (e) {
		die((e as Error).message, 1);
	}
	const [{ render }, { createElement }, { Cockpit }] = await (await import('./tui/load.js')).loadCockpit();
	const ink = render(createElement(Cockpit, { manager, config, depth, focus, cwd, fast }), {
		exitOnCtrlC: false,
		alternateScreen: config.ui.alternateScreen,
		incrementalRendering: true,
		maxFps: Math.max(1, config.ui.fps),
	});
	await ink.waitUntilExit();
	await manager.stopAll();
	let stuck = 0;
	for (const r of manager.list()) {
		const s = r.o.snapshot();
		const n = (st: string) => s.tasks.filter((t) => t.status === st).length;
		stuck += n('blocked') + n('review') + (s.error ? 1 : 0);
		say(`${tone('jarvis-code', 'accent')} #${r.id} ${r.name}: ${n('done')}/${s.tasks.length} done, ${n('blocked')} blocked, ${n('review')} to review · $${s.cost.toFixed(2)}`);
		for (const t of s.tasks.filter((t) => t.status === 'blocked' || t.status === 'review')) say(`  ${tone(t.status === 'blocked' ? '⊘' : '◇', 'warn')} ${t.id} ${t.title}: ${t.note ?? ''}`);
	}
	process.exitCode = stuck ? 1 : 0;
}

function source(config: Config, cwd: string, kind: string | undefined): TaskSource {
	const want = kind ?? 'store';
	if (want === 'memory') return new MemorySource(cwd, config.verify.timeoutSec);
	if (want !== 'store') die('--tasks must be store or memory');
	return new StoreSource(new Project(cwd), cwd, config.verify.timeoutSec);
}

/** `improve`: after the first run, more rounds of improveGoal, each building on what the last closed, until nextRound ends them. */
async function run(config: Config, cwd: string, goal: string | undefined, tasks: string | undefined, improve?: { focus?: string }) {
	if (!goal && tasks === 'memory') die('nothing to work: the memory queue starts empty, give a goal');
	const src = source(config, cwd, tasks);
	// Workers load this package's plugin per session unless it is installed for good.
	const pluginDir = installed.claude() ? undefined : PLUGIN_DIR;
	const project = src instanceof StoreSource ? src.project : undefined;
	try {
		project?.lock({ goal, log: process.env.JARVIS_CODE_LOG, by: 'cli' });
	} catch (e) {
		// A goal for a busy project waits for its run; `work` has nothing to wait with.
		const held = project?.running();
		if (goal && held) return say(`${tone('jarvis-code', 'accent')}: queued #${project!.enqueue(goal)} in ${project!.meta.name}: runs after the current run (pid ${held.pid})`);
		die((e as Error).message, 1);
	}
	try {
		// Then the improve rounds and the goals queued while it ran, each with a fresh orchestrator, until one stops or fails.
		let code = 0;
		for (let next = goal, round = 1; ; round++) {
			const o = new Orchestrator(config, src, new Learning(config.learning), cwd, { pluginDir });
			code = Math.max(code, await drive(o, config, next));
			const s = o.snapshot();
			if (improve) {
				const n = (st: string) => s.tasks.filter((t) => t.status === st);
				const built = n('done').map((t) => t.title);
				const { rounds, minLanded } = config.improve;
				say(`${tone('jarvis-code', 'accent')}: improve round ${round}/${rounds}: ${built.length} landed, ${n('blocked').length} blocked, ${n('review').length} to review · $${s.cost.toFixed(2)}`);
				const end = nextRound({ round, rounds, landed: built.length, minLanded, stopped: s.phase === 'stopped' || !!s.error });
				if (!end) {
					next = improveGoal(improve.focus, built);
					continue;
				}
				const why = { stopped: s.error ? `the run failed: ${s.error}` : 'the run was stopped', dry: `it landed fewer than ${minLanded} task${minLanded === 1 ? '' : 's'}`, rounds: `all ${rounds} round${rounds === 1 ? '' : 's'} ran` }[end];
				say(`${tone('jarvis-code', 'accent')}: improve ended after round ${round} (${end}): ${why}`);
				improve = undefined;
			}
			if (s.phase === 'stopped' || s.error || !(next = project?.nextGoal())) break;
		}
		process.exitCode = code;
	} finally {
		project?.unlock();
	}
}

/** The same command again, in the background: it outlives this terminal, its output in the store. */
async function detach(cwd: string, argv: string[], tasks?: string) {
	if (tasks === 'memory') die('--detach keeps the queue in the task store: drop --tasks memory');
	try {
		const { pid, log } = await runDetached(cwd, argv.filter((a) => a !== '--detach'));
		say(`${tone('jarvis-code', 'accent')}: running in the background (pid ${pid}). \`jarvis-code status\` here shows it, \`jarvis-code stop\` ends it.`);
		say(tone(`log: ${log}`, 'textDim'));
	} catch (e) {
		die((e as Error).message, 1);
	}
}

/** End this project's background or CLI run (a cockpit's run is stopped from its cockpit). */
function stopCmd(cwd: string) {
	const said = stopElsewhere(cwd);
	if (said.startsWith('that run belongs')) die(said, 1);
	say(said);
}

/** Run the orchestrator with plain line output; the exit code says how it ended. */
async function drive(o: Orchestrator, config: Config, goal: string | undefined): Promise<number> {
	const end = attachPlain(o, config.ui);
	const done = o.run(goal);
	const stop = () => o.stop();
	process.once('SIGINT', stop);
	process.once('SIGTERM', stop);
	const r = await done;
	// Drained goals each drive a new orchestrator: don't pile up listeners for finished ones.
	process.off('SIGINT', stop);
	process.off('SIGTERM', stop);
	end();
	return r.blocked || r.review || o.snapshot().error ? 1 : 0;
}

async function demo(base: Config, fast: boolean) {
	const config = demoConfig(base, fast);
	const cwd = mkdtempSync(join(tmpdir(), 'jarvis-code-demo-'));
	const learning = new Learning(config.learning, join(cwd, '.learning.json'));
	const o = new Orchestrator(config, new MemorySource(cwd, 30), learning, cwd);
	process.exitCode = await drive(o, config, 'Modernize the settings system');
}

/** A held run with no event past this long is likely a long check (no events emitted) or a stuck agent. */
const QUIET_MS = 10 * 60_000;

function ageStr(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h`;
}

/** One line per project jarvis-code has tasks for; `json` for scripts. */
function statusAll(json: boolean) {
	const rows = listStored().map((m) => {
		const p = Project.open(m.path)!;
		return { name: m.name, path: m.path, lastActive: m.lastActive, running: p.running(), died: !!p.died(), ...p.summary(), spent: p.spent(), lastEventAt: p.lastBeat() ? new Date(p.lastBeat()!.at).toISOString() : undefined };
	});
	if (json) return say(JSON.stringify(rows, null, 2));
	if (!rows.length) return say('no projects yet: give jarvis-code a goal somewhere');
	for (const r of rows) {
		const stuck = r.blocked + r.review;
		say(`  ${r.running ? tone('◠', 'accent') : stuck ? tone('⊘', 'warn') : r.planned + r.active ? tone('·', 'accent') : tone('✓', 'ok')} ${r.name.padEnd(24)} ${`${r.planned + r.active} open`.padEnd(8)} ${stuck ? tone(`${stuck} need you`, 'warn') : ''.padEnd(10)} ${tone(r.path, 'textDim')}`);
	}
}

/** "off for 40m more (until 14:10): <reason> · jarvis-code learn reset <id> turns it back on now" */
function offLine(st: { disabledUntil?: string; reason?: string }, id: string): string {
	const until = new Date(st.disabledUntil!);
	const mins = Math.ceil((until.getTime() - Date.now()) / 60_000);
	const clock = `${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}`;
	return `off for ${mins}m more (until ${clock})${st.reason ? `: ${st.reason}` : ''} · jarvis-code learn reset ${id} turns it back on now`;
}

async function status(config: Config, cwd: string) {
	say(tone('A G E N T S', 'textDim'));
	const learning = new Learning(config.learning);
	for (const r of [...new Map([...routesFor(config, 'planner'), ...routesFor(config, 'worker')].map((r) => [r.id, r])).values()]) {
		const st = learning.data.routes[r.id];
		const off = learning.routeOff(r.id);
		say(`  ${off ? tone('✕', 'danger') : tone('●', 'ok')} ${r.id}${st ? `  ${Math.round(score(st) * 100)}% · ${st.ok}/${st.runs} ok` : ''}${off ? `  ${offLine(st!, r.id)}` : ''}`);
	}
	for (const [name, a] of Object.entries(config.agents)) if (!agentEnabled(a)) say(`  ${tone('○', 'textFaint')} ${name} (${a.enabled === 'auto' ? `\`${a.bin}\` not found` : 'disabled'})`);
	const project = Project.open(cwd);
	if (!project) return say(`\n${tone('·', 'textDim')} no tasks here yet: give jarvis-code a goal to plan some`);
	const s = project.summary();
	say(`\n${tone('Q U E U E', 'textDim')}  ${s.planned + s.active} open · ${s.blocked} blocked · ${s.review} to review · ${s.done} done`);
	const held = project.running();
	if (held) {
		say(`  ${tone('◠', 'accent')} a run is going: pid ${held.pid} since ${held.started.slice(11, 16)} (${held.by === 'cockpit' ? 'in a cockpit' : held.log ? `in the background, log ${held.log}` : 'from the CLI'})`);
		const beat = project.lastBeat();
		if (beat) {
			const age = Date.now() - beat.at;
			if (age >= QUIET_MS) say(`    ${tone(`⚠ quiet for ${ageStr(age)} (a long check or a stuck agent)${beat.task ? ` on ${beat.task}` : ''}: ${beat.text}`, 'warn')}`);
			else say(`    ${tone(`last event ${ageStr(age)} ago${beat.task ? ` on ${beat.task}` : ''}: ${beat.text}`, 'textDim')}`);
		}
	} else {
		const dead = project.died();
		if (dead) say(`  ${tone('⊘', 'warn')} the last run (pid ${dead.pid}, started ${dead.started.slice(11, 16)}${dead.log ? `, log ${dead.log}` : ''}) died with its lock held before finishing: \`jarvis-code work\` (or \`work --detach\`) resumes it, and its active tasks go back to the queue`);
	}
	for (const t of project.queue()) say(`  ${t.status === 'active' ? tone('◠', 'accent') : tone('·', 'textFaint')} ${t.id} ${t.type} ${t.tier}  ${t.title}`);
	for (const t of project.tasks().filter((t) => t.status === 'blocked' || t.status === 'review')) {
		say(`  ${tone(t.status === 'blocked' ? '⊘' : '◇', 'warn')} ${t.id} ${t.title}: ${t.reason ?? ''}`);
		const next = nextStep(t);
		if (next) say(tone(`      next: ${next}`, 'textDim'));
	}
}

const MARK: Record<Status, [string, keyof typeof palette]> = {
	planned: ['·', 'textFaint'],
	active: ['◠', 'accent'],
	review: ['◇', 'warn'],
	blocked: ['⊘', 'warn'],
	deferred: ['‥', 'textDim'],
	done: ['✓', 'ok'],
	dropped: ['✕', 'textFaint'],
};

const taskLine = (t: StoredTask) => `  ${tone(...MARK[t.status])} ${t.id} ${t.type} ${t.tier}  ${t.title}${t.reason ? tone(`  ${t.reason}`, 'textDim') : ''}`;

function tasksCmd(cwd: string, all: boolean) {
	const project = Project.open(cwd);
	if (!project) return say('no tasks here yet: give jarvis-code a goal to plan some, or `jarvis-code task add`');
	const queue = project.queue();
	const rest = project.tasks().filter((t) => !queue.some((q) => q.id === t.id) && (all || !['done', 'dropped'].includes(t.status)));
	for (const t of [...queue.map((q) => project.get(q.id)!), ...rest]) say(taskLine(t));
	const s = project.summary();
	say(tone(`\n${s.planned + s.active} open · ${s.blocked} blocked · ${s.review} to review · ${s.deferred} deferred · ${s.done} done`, 'textDim'));
}

function taskCmd(cwd: string, args: string[], f: { type?: string; tier?: string; ac?: string[]; intent: boolean }) {
	const [verb, id, ...why] = args;
	if (verb === 'add') {
		const title = args.slice(1).join(' ').trim();
		if (!title) die('task add needs a title');
		if (f.type && !TYPES.includes(f.type.toUpperCase())) die(`--type must be one of ${TYPES.join(', ')}`);
		if (f.tier && !/^[sml]$/i.test(f.tier)) die('--tier must be S, M or L');
		const acs = (f.ac ?? []).map((a) => {
			const [text, verify] = a.split(' :: ');
			return { text: text.trim(), verify: verify?.trim() };
		});
		const [t] = new Project(cwd).add([{ title, type: f.type, tier: f.tier, acs }]);
		return say(`${tone('+', 'ok')} ${t.id} ${t.title}${acs.some((a) => a.verify) ? '' : tone('  (no verify command: a worker finishing it goes to review)', 'textDim')}`);
	}
	if (verb !== 'show' && !(verb in DECISIONS))
		die(verb ? `unknown task verb "${verb}" (add, show, retry, defer, drop, approve); to plan a goal, quote it: jarvis-code "task ${args.join(' ')}"` : 'task needs a verb: add, show, retry, defer, drop or approve');
	const project = Project.open(cwd);
	if (!project) die(`no task ${id ?? ''} here`);
	const bulk = verb !== 'show' && !!id && (BULK as readonly string[]).includes(id.toLowerCase());
	const t = id && !bulk ? project.get(id.toUpperCase()) : undefined;
	if (!bulk && !t) die(`no task ${id ?? ''} here`);
	switch (verb) {
		case 'show': {
			say(taskLine(t!));
			if (t!.goal) say(tone(`  goal: ${t!.goal}`, 'textDim'));
			if (t!.brief) say(`  ${t!.brief}`);
			for (const [i, a] of t!.acs.entries()) say(`  ${a.checked ? tone('✓', 'ok') : tone('○', 'textFaint')} AC${i + 1} ${a.text}${a.verify ? tone(`  $ ${a.verify}`, 'textDim') : ''}`);
			for (const [i, st] of t!.steps.entries()) say(`  ${i + 1}. ${st}`);
			if (t!.depends.length) say(tone(`  after ${t!.depends.join(', ')}`, 'textDim'));
			for (const a of t!.attempts) say(`  ${a.ok ? tone('●', 'ok') : tone('✕', 'danger')} ${a.at.slice(0, 16).replace('T', ' ')} ${a.route}${a.error ? `: ${a.error}` : a.summary ? `: ${a.summary}` : ''}`);
			for (const l of t!.lessons) say(`  ${tone('lesson', 'accent')} ${l}`);
			const next = nextStep(t!);
			if (next) say(`  ${tone('next', 'accent')}: ${next}`);
			return;
		}
		default:
			try {
				return say(decideTask(project, verb as Decision, id!, why.join(' '), { intent: f.intent }));
			} catch (e) {
				die((e as Error).message, 1);
			}
	}
}

function learn(config: Config, args: string[]) {
	const learning = new Learning(config.learning);
	if (args[0] === 'reset') {
		const key = args.slice(1).join(' ');
		const gone = key ? learning.forgive(key) : (learning.reset(), ['everything']);
		learning.save();
		return say(gone.length ? `forgot ${gone.join(', ')}` : `nothing learned about ${key}`);
	}
	const { routes, tools } = learning.data;
	// `label` is how the key reads; `key` is what `learn reset` takes (quoted when a shell would mangle it).
	const row = (label: string, key: string, st: (typeof routes)[string]) => {
		const off = learning.isOff(st);
		const arg = /^[\w:.@/-]+$/.test(key) ? key : `'${key}'`;
		say(`  ${off ? tone('✕', 'danger') : tone('●', 'ok')} ${label}  ${Math.round(score(st) * 100)}% · ${st.ok}/${st.runs} ok${off ? `  ${offLine(st, arg)}` : ''}`);
	};
	say(tone('R O U T E S', 'textDim'));
	if (!Object.keys(routes).length) say('  nothing yet');
	for (const [k, st] of Object.entries(routes)) row(k, k, st);
	const kinds = Object.entries(learning.data.kinds);
	if (kinds.length) {
		say(tone('\nB Y   T A S K   T Y P E', 'textDim'));
		for (const [k, st] of kinds) row(k.replace('@', ' @ '), k, st);
	}
	say(tone('\nT O O L S', 'textDim') + '  (per orchestrating agent)');
	if (!Object.keys(tools).length) say('  nothing yet');
	for (const [k, st] of Object.entries(tools)) row(k.replace('|', ' › '), k, st);
}

function intentCmd(config: Config, args: string[]) {
	if (args[0] === 'reset') {
		resetIntent();
		return say('forgot everything in intent memory');
	}
	if (args.length) die('usage: jarvis-code intent [reset]');
	say(intentSummary() || 'nothing recorded yet');
	say(tone(`\n${intentFile()}${config.intent ? '' : ' · off ("intent": false): nothing new is recorded'} · jarvis-code intent reset forgets it`, 'textDim'));
}

function configCmd(config: Config, sources: string[], cwd: string, args: string[], project: boolean) {
	const sub = args[0] ?? 'show';
	if (sub === 'path') return say(`global:  ${paths.globalConfig()}\nproject: ${paths.projectConfig(cwd)}\nstate:   ${paths.stateDir()}`);
	if (sub === 'show') {
		say(JSON.stringify(config, null, 2));
		return process.stderr.write(`\n(merged from defaults${sources.length ? ' + ' + sources.join(' + ') : ''})\n`);
	}
	if (sub === 'trust') {
		try {
			return say(`trusted ${trustProject(cwd)}: the commands it names may run here, until the file changes`);
		} catch (e) {
			die((e as Error).message, 1);
		}
	}
	if (sub === 'untrust') {
		untrustProject(cwd);
		return say(`${paths.projectConfig(cwd)} is no longer trusted`);
	}
	if (sub !== 'init') die(`config ${sub}: expected show, path, init, trust or untrust`);
	const file = project ? paths.projectConfig(cwd) : paths.globalConfig();
	if (existsSync(file)) die(`${file} already exists`, 1);
	const starter = {
		agents: {
			claude: { models: [], disablePlugins: ['foreman@foreman'] },
			codex: { enabled: 'auto', models: [] },
			opencode: { enabled: 'auto', models: [] },
		},
		workers: [],
		planner: [],
		ui: DEFAULTS.ui,
		learning: DEFAULTS.learning,
		downgrade: { default: DEFAULTS.downgrade.default, models: { 'claude-fable*': { action: 'reupgrade', to: 'claude-fable-5-1', max: 5 } } },
	};
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(file, JSON.stringify(starter, null, 2) + '\n');
	say(`wrote ${file}`);
}

function pluginCmd(args: string[]) {
	const [sub = 'status', which] = args;
	const targets = which ? [which as Target] : TARGETS;
	for (const t of targets) if (!TARGETS.includes(t)) die(`unknown agent "${t}" (claude, codex, opencode)`);
	if (sub === 'status') {
		for (const t of targets) say(`  ${installed[t]() ? tone('●', 'ok') + ` ${t}: installed` : tone('○', 'textFaint') + ` ${t}: not installed`}`);
		return say(`\nplugin: ${PLUGIN_DIR}\n(Claude Code workers get it per session with --plugin-dir when it is not installed.)`);
	}
	if (sub !== 'install' && sub !== 'uninstall') die(`plugin ${sub}: expected install, uninstall or status`);
	if (!which) die(`plugin ${sub} needs an agent: claude, codex or opencode`);
	for (const line of (sub === 'install' ? install : uninstall)(which as Target)) say(line);
}

function version(bin: string): string | undefined {
	try {
		return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0];
	} catch {
		return undefined;
	}
}

function doctor(config: Config, cwd: string, sources: string[]) {
	let bad = 0;
	const check = (ok: boolean, text: string, hint?: string) => {
		if (!ok) bad++;
		say(`${ok ? tone('✓', 'ok') : tone('✗', 'danger')} ${text}${!ok && hint ? `\n    ${tone(hint, 'textDim')}` : ''}`);
	};
	const warn = (text: string) => say(`${tone('!', 'warn')} ${text}`);
	check(Number(process.versions.node.split('.')[0]) >= 22, `node ${process.versions.node}`, 'jarvis-code needs Node 22 or newer');
	let any = false;
	for (const [name, a] of Object.entries(config.agents)) {
		const on = agentEnabled(a);
		any ||= on;
		if (!on) {
			say(`${tone('○', 'textFaint')} ${name}: ${a.enabled === false ? 'disabled in config' : `\`${a.bin}\` not on PATH`}`);
			continue;
		}
		const v = version(a.bin);
		check(!!v, `${name} (${a.kind}): ${v ?? `\`${a.bin} --version\` failed`}${a.models.length ? ` · models ${a.models.join(', ')}` : ''}`);
	}
	check(any, 'at least one agent available', 'install claude, codex or opencode, or add a generic agent in the config');
	check(routesFor(config, 'worker').length > 0, `worker routes: ${routesFor(config, 'worker').map((r) => r.id).join(', ') || 'none'}`, 'a `workers` entry names an agent that is not enabled');
	for (const t of TARGETS) {
		const agent = Object.values(config.agents).find((a) => a.kind === t && agentEnabled(a));
		if (!agent) continue;
		if (installed[t]()) say(`${tone('✓', 'ok')} ${t} plugin installed`);
		else if (t === 'claude') say(`${tone('✓', 'ok')} claude plugin: loaded per session from ${PLUGIN_DIR}`);
		else warn(`${t} plugin not installed: learned tool blocking is off for ${t} (\`jarvis-code plugin install ${t}\`)`);
	}
	const colors = colorDepth(process.env, !!process.stdout.isTTY);
	(colors === 'truecolor' ? say : warn)(`${colors === 'truecolor' ? tone('✓', 'ok') + ' ' : ''}terminal colour: ${colors}${colors === 'truecolor' ? '' : ' (set COLORTERM=truecolor for the full reactor)'}`);
	if (process.stdout.isTTY) {
		const { columns, rows } = process.stdout;
		(rows >= 28 && columns >= 90 ? say : warn)(`${rows >= 28 && columns >= 90 ? tone('✓', 'ok') + ' ' : ''}terminal ${columns}×${rows}${rows >= 28 && columns >= 90 ? '' : ': the large reactor needs 90×28; the small one is used'}`);
	}
	say(`${tone('·', 'textDim')} config: ${sources.length ? sources.join(', ') : 'defaults only'} · state: ${paths.stateDir()} · cwd ${cwd}`);
	process.exitCode = bad ? 1 : 0;
}

main(process.argv.slice(2)).catch((e) => die((e as Error).stack ?? String(e), 1));
