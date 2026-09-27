#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { agentEnabled, DEFAULTS, loadConfig, merge, normalize, onPath, paths, type Config } from './config.js';
import { Learning, routesFor, score } from './learn.js';
import { Orchestrator } from './orchestrator.js';
import { attachPlain } from './plain.js';
import { install, installed, PLUGIN_DIR, ROOT, TARGETS, uninstall, type Target } from './plugin.js';
import { ForemanSource, MemorySource, type TaskSource } from './tasks.js';
import { colorDepth, paint, palette } from './theme.js';

const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;

const HELP = `jarvis-code ${VERSION} — Foreman-driven orchestration for Claude Code, Codex, OpenCode and other agents

Usage
  jarvis-code "<goal>"            plan the goal into Foreman tasks, then work them (TUI)
  jarvis-code work                work the existing Foreman queue, no planning
  jarvis-code demo                simulated agents: see the TUI, learning and re-upgrades (no API calls)
  jarvis-code status              the queue, the agents and their learned health
  jarvis-code learn [reset [KEY]] what was learned about routes and tools; forget it
  jarvis-code config [show|path|init [--project]]
  jarvis-code plugin <install|uninstall|status> [claude|codex|opencode]
  jarvis-code doctor              check agents, Foreman, plugin and terminal

Options
  --plain                 line output instead of the TUI (automatic when not a terminal)
  --tasks foreman|memory  task backend (default: foreman when \`fm\` is installed)
  --worker ROUTE          worker route, repeatable, in preference order (agent or agent:model)
  --planner ROUTE         planner route, repeatable
  --parallel N            workers at once (default 1; >1 shares one working tree)
  --attempts N            attempts per task across routes (default 3)
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
				worker: { type: 'string', multiple: true },
				planner: { type: 'string', multiple: true },
				parallel: { type: 'string' },
				attempts: { type: 'string' },
				'show-diffs': { type: 'boolean' },
				'show-tools': { type: 'boolean' },
				'show-text': { type: 'boolean' },
				reactor: { type: 'string' },
				'reduced-motion': { type: 'boolean' },
				cwd: { type: 'string' },
				fast: { type: 'boolean' },
				project: { type: 'boolean' },
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
	if (f.reactor && !['large', 'small', 'off'].includes(f.reactor)) die('--reactor must be large, small or off');
	const overrides = {
		...(f.worker && { workers: f.worker }),
		...(f.planner && { planner: f.planner }),
		...(f.parallel && { maxParallel: int(f.parallel, 'parallel') }),
		...(f.attempts && { maxAttempts: int(f.attempts, 'attempts') }),
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
	try {
		({ config, sources } = loadConfig(cwd, overrides));
	} catch (e) {
		die((e as Error).message);
	}

	const [cmd, ...rest] = pos;
	switch (cmd) {
		case 'demo':
			return demo(config, !!f.plain, !!f.fast);
		case 'status':
			return status(config, cwd);
		case 'learn':
			return learn(config, rest);
		case 'config':
			return configCmd(config, sources, cwd, rest, !!f.project);
		case 'plugin':
			return pluginCmd(rest);
		case 'doctor':
			return doctor(config, cwd, sources);
		case 'help':
			return say(HELP);
		case 'work':
			return run(config, cwd, undefined, f.tasks, !!f.plain);
		case 'run':
			return run(config, cwd, rest.join(' ') || undefined, f.tasks, !!f.plain);
		case undefined:
			return say(HELP);
		default:
			return run(config, cwd, pos.join(' '), f.tasks, !!f.plain);
	}
}

function source(config: Config, cwd: string, kind: string | undefined, log: (s: string) => void): TaskSource {
	const want = kind ?? (onPath(config.foreman.bin) ? 'foreman' : 'memory');
	if (want === 'memory') return new MemorySource(cwd, config.verify.timeoutSec);
	if (want !== 'foreman') die('--tasks must be foreman or memory');
	if (!onPath(config.foreman.bin)) die(`Foreman (\`${config.foreman.bin}\`) is not on PATH: install it (https://github.com/ChaseSunstrom/foreman) or pass --tasks memory`);
	return new ForemanSource(config.foreman.bin, cwd, config.verify.timeoutSec, log);
}

async function run(config: Config, cwd: string, goal: string | undefined, tasks: string | undefined, plain: boolean) {
	if (!goal && tasks === 'memory') die('nothing to work: the memory queue starts empty, give a goal');
	let o!: Orchestrator;
	const src = source(config, cwd, tasks, (s) => o?.note('info', s));
	if (src instanceof ForemanSource) {
		try {
			await src.init();
		} catch (e) {
			die((e as Error).message, 1);
		}
	}
	// Workers load this package's plugin per session unless it is installed for good.
	const pluginDir = installed.claude() ? undefined : PLUGIN_DIR;
	o = new Orchestrator(config, src, new Learning(config.learning), cwd, { pluginDir });
	process.exitCode = await drive(o, config, goal, plain);
}

/** Run the orchestrator under the TUI (a terminal) or plain lines; the exit code says how it ended. */
async function drive(o: Orchestrator, config: Config, goal: string | undefined, plain: boolean): Promise<number> {
	const tty = !!process.stdout.isTTY && !!process.stdin.isTTY;
	if (plain || !tty) {
		const end = attachPlain(o, config.ui);
		const done = o.run(goal);
		const stop = () => o.stop();
		process.once('SIGINT', stop);
		process.once('SIGTERM', stop);
		const r = await done;
		end();
		return r.blocked || r.review || o.snapshot().error ? 1 : 0;
	}
	const done = o.run(goal);
	const [{ render }, { createElement }, { App }] = await Promise.all([import('ink'), import('react'), import('./tui/App.js')]);
	const ink = render(createElement(App, { o, config, depth, done }), {
		exitOnCtrlC: false,
		alternateScreen: config.ui.alternateScreen,
		incrementalRendering: true,
		maxFps: Math.max(1, config.ui.fps),
	});
	await ink.waitUntilExit();
	const r = await done;
	const s = o.snapshot();
	say(`${tone('jarvis-code', 'accent')}: ${r.done}/${s.tasks.length} done, ${r.blocked} blocked, ${r.review} to review · $${s.cost.toFixed(2)}`);
	for (const t of s.tasks.filter((t) => t.status === 'blocked' || t.status === 'review')) say(`  ${tone(t.status === 'blocked' ? '⊘' : '◇', 'warn')} ${t.id} ${t.title}: ${t.note ?? ''}`);
	return r.blocked || r.review || s.error ? 1 : 0;
}

async function demo(base: Config, plain: boolean, fast: boolean) {
	const agent = fileURLToPath(new URL('./demo-agent.js', import.meta.url));
	const env = { JC_DEMO_PACE: fast ? '25' : '450', JC_DEMO_DOWNGRADE: 'some' };
	const config = normalize(
		merge(base, {
			agents: {
				claude: { kind: 'claude', enabled: true, bin: agent, models: ['claude-fable-5-1'], env, args: [], disablePlugins: [] },
				codex: { enabled: false },
				opencode: { enabled: false },
				local: { kind: 'generic', enabled: true, bin: agent, args: ['--model', '{model}', '{prompt}'], models: ['qwen3-coder-flaky'], env },
			},
			planner: ['claude:claude-fable-5-1'],
			workers: ['local:qwen3-coder-flaky', 'claude:claude-fable-5-1'],
			maxParallel: 1,
			downgrade: { models: { 'claude-fable*': { action: 'reupgrade', to: 'claude-fable-5-1', max: 3 } } },
		}),
	);
	const cwd = mkdtempSync(join(tmpdir(), 'jarvis-code-demo-'));
	const learning = new Learning(config.learning, join(cwd, '.learning.json'));
	const o = new Orchestrator(config, new MemorySource(cwd, 30), learning, cwd);
	process.exitCode = await drive(o, config, 'Modernize the settings system', plain);
}

async function status(config: Config, cwd: string) {
	say(tone('A G E N T S', 'textDim'));
	const learning = new Learning(config.learning);
	for (const r of [...new Map([...routesFor(config, 'planner'), ...routesFor(config, 'worker')].map((r) => [r.id, r])).values()]) {
		const st = learning.data.routes[r.id];
		const off = learning.routeOff(r.id);
		say(`  ${off ? tone('✕', 'danger') : tone('●', 'ok')} ${r.id}${st ? `  ${Math.round(score(st) * 100)}% · ${st.ok}/${st.runs} ok` : ''}${off ? `  off until ${st!.disabledUntil}` : ''}`);
	}
	for (const [name, a] of Object.entries(config.agents)) if (!agentEnabled(a)) say(`  ${tone('○', 'textFaint')} ${name} (${a.enabled === 'auto' ? `\`${a.bin}\` not found` : 'disabled'})`);
	if (!onPath(config.foreman.bin)) return say(`\n${tone('!', 'warn')} Foreman not installed: no queue to show`);
	const src = new ForemanSource(config.foreman.bin, cwd, 60);
	const q = await src.fm(['queue', '--json']);
	if (q.code !== 0) return say(`\n${(q.stderr || q.stdout).trim()}`);
	const order: { id: string; title: string; status: string; tier: string; type: string }[] = JSON.parse(q.stdout).order;
	say(`\n${tone('Q U E U E', 'textDim')}  ${order.length} open`);
	for (const t of order) say(`  ${t.status === 'active' ? tone('◠', 'accent') : tone('·', 'textFaint')} ${t.id} ${t.type} ${t.tier}  ${t.title}`);
}

function learn(config: Config, args: string[]) {
	const learning = new Learning(config.learning);
	if (args[0] === 'reset') {
		learning.reset(args[1]);
		learning.save();
		return say(args[1] ? `forgot ${args[1]}` : 'forgot everything learned');
	}
	const { routes, tools } = learning.data;
	const row = (k: string, st: (typeof routes)[string]) => {
		const off = learning.isOff(st);
		say(`  ${off ? tone('✕', 'danger') : tone('●', 'ok')} ${k}  ${Math.round(score(st) * 100)}% · ${st.ok}/${st.runs} ok${off ? `  off until ${st.disabledUntil}: ${st.reason}` : ''}`);
	};
	say(tone('R O U T E S', 'textDim'));
	if (!Object.keys(routes).length) say('  nothing yet');
	for (const [k, st] of Object.entries(routes)) row(k, st);
	say(tone('\nT O O L S', 'textDim') + '  (per orchestrating agent)');
	if (!Object.keys(tools).length) say('  nothing yet');
	for (const [k, st] of Object.entries(tools)) row(k.replace('|', ' › '), st);
}

function configCmd(config: Config, sources: string[], cwd: string, args: string[], project: boolean) {
	const sub = args[0] ?? 'show';
	if (sub === 'path') return say(`global:  ${paths.globalConfig()}\nproject: ${paths.projectConfig(cwd)}\nstate:   ${paths.stateDir()}`);
	if (sub === 'show') {
		say(JSON.stringify(config, null, 2));
		return process.stderr.write(`\n(merged from defaults${sources.length ? ' + ' + sources.join(' + ') : ''})\n`);
	}
	if (sub !== 'init') die(`config ${sub}: expected show, path or init`);
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
	const fm = onPath(config.foreman.bin);
	check(fm, `Foreman: ${fm ? version(config.foreman.bin) ?? config.foreman.bin : 'not found'}`, 'install https://github.com/ChaseSunstrom/foreman, or run with --tasks memory');
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
