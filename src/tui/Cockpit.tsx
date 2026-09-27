import { existsSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Box, Text, useAnimation, useApp, useInput, useWindowSize } from 'ink';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { agentEnabled, type Config } from '../config.js';
import type { Activity, Snapshot } from '../orchestrator.js';
import { addRecent, listProjects, StateCache, type Project, type ProjectState } from '../projects.js';
import { improveGoal } from '../pipeline.js';
import { BULK, decideTask, DECISIONS, Project as Store, type Decision } from '../store.js';
import { spinner } from '../reactor.js';
import { fleet, runDetached, stopElsewhere, type Run, type RunManager } from '../runs.js';
import { c, type ColorDepth } from '../theme.js';
import { ANIMATED, Feed, Header, Label, Learning, queueOrder, Reports, TaskDetail, Tasks, Workers } from './parts.js';
import { elapsed, type View } from './style.js';

type Tone = 'info' | 'ok' | 'warn' | 'danger';

export interface Command {
	name: string;
	args?: string;
	desc: string;
}

/** The slash commands, in the order the menu shows them. */
export const COMMANDS: Command[] = [
	{ name: 'run', args: '<goal>', desc: 'plan a goal into tasks and work them here (plain text does the same)' },
	{ name: 'brainstorm', args: '<goal>', desc: 'explore ideas from several angles and agents first, then plan and work them' },
	{ name: 'improve', args: '[focus]', desc: 'find and make the most valuable improvements to this project (brainstormed first)' },
	{ name: 'work', desc: "work this project's open tasks, no planning" },
	{ name: 'open', args: '[project]', desc: "open a project's run dashboard" },
	{ name: 'home', desc: 'back to all projects' },
	{ name: 'cd', args: '<project|dir>', desc: 'select a project by name or path' },
	{ name: 'add', args: '<dir>', desc: 'add a directory as a project' },
	{ name: 'task', args: '<add|show|retry|defer|drop|approve|bump> …', desc: "change this project's queue: add a task, show one's detail, decide on one by id, or bump one to the front" },
	{ name: 'trust', args: '<route|tool>', desc: 'forget what was learned about a route or tool, so it is used again' },
	{ name: 'report', desc: "write the selected run's report (every task's outcome) and show where" },
	{ name: 'reports', desc: "list this project's past run reports, newest first" },
	{ name: 'runs', desc: 'list runs in this session' },
	{ name: 'stop', args: '[all]', desc: "stop this project's run (or every run)" },
	{ name: 'detach', desc: "hand this project's run to the background: it keeps going after you quit" },
	{ name: 'pause', desc: 'pause or resume the run: running tasks finish, no new ones start' },
	{ name: 'demo', desc: 'a simulated run: see the reactor, learning and re-upgrades' },
	{ name: 'diffs', desc: 'show or hide file changes in the feed' },
	{ name: 'tools', desc: 'show or hide tool calls in the feed' },
	{ name: 'messages', desc: 'show or hide agent messages in the feed' },
	{ name: 'learned', desc: 'show what was learned about routes and tools' },
	{ name: 'reactor', desc: 'reactor size: large → small → off' },
	{ name: 'help', desc: 'what every command does' },
	{ name: 'quit', desc: 'stop every run and exit' },
];

/** Verbs `/task` accepts, for Tab completion. */
export const TASK_VERBS = ['add', 'show', 'bump', ...Object.keys(DECISIONS)];

export function matchCommands(input: string): Command[] {
	if (!input.startsWith('/')) return [];
	const word = input.slice(1).split(/\s/)[0].toLowerCase();
	return COMMANDS.filter((cmd) => cmd.name.startsWith(word));
}

/** A snapshot for the header when nothing is running. */
function restSnapshot(config: Config): Snapshot {
	return {
		phase: 'idle',
		paused: false,
		source: 'store',
		tasks: [],
		workers: [],
		activity: [],
		cost: 0,
		started: Date.now(),
		reactor: 'idle',
		stateSince: 0,
		prevReactor: 'idle',
		routes: [],
	};
}

/** The project list the cockpit shows: known projects, plus any run's directory that is not one. */
/** The list the cockpit shows: known projects, plus any run's directory and the launch directory (a goal typed there runs there). */
function withRuns(projects: Project[], runs: Run[], launch: string): Project[] {
	const known = new Set(projects.map((p) => p.path));
	const extra = runs.filter((r) => !known.has(r.dir)).map((r) => ({ name: r.name, path: r.dir, known: !r.demo }));
	for (const p of extra) known.add(p.path);
	const here = known.has(launch) ? [] : [{ name: basename(launch) || launch, path: launch, known: false }];
	return [...here, ...extra, ...projects];
}

function ProjectLine({ p, run, state, selected, t }: { p: Project; run?: Run; state?: ProjectState; selected: boolean; t: number }) {
	let glyph = '·';
	let tone = c.textFaint;
	let note = p.known ? '' : 'no tasks yet';
	if (run && !run.finished) {
		const s = run.o.snapshot();
		glyph = spinner(t);
		tone = c.accent;
		note = s.phase === 'planning' ? 'planning' : `working ${s.tasks.filter((x) => x.status === 'done').length}/${s.tasks.length}`;
	} else if (run) {
		const s = run.o.snapshot();
		const stuck = s.tasks.filter((x) => x.status === 'blocked' || x.status === 'review').length;
		[glyph, tone, note] = stuck ? ['⊘', c.warn, `${stuck} need you`] : ['✓', c.ok, `${s.tasks.filter((x) => x.status === 'done').length} done`];
	} else if (state?.running) {
		// Progress from the store, which the other process keeps up to date.
		[glyph, tone, note] = [spinner(t), c.accentDeep, `${state.running.by === 'cockpit' ? 'elsewhere' : 'background'} ${state.done}/${state.done + state.queue.length}`];
	} else if (state) {
		const stuck = state.blocked.length + state.review.length;
		if (stuck) [glyph, tone, note] = ['⊘', c.warn, `${stuck} need you · ${state.queue.length} open`];
		else if (state.queue.length) [glyph, tone, note] = ['○', c.accentDeep, `${state.queue.length} open`];
		else note = state.done ? `${state.done} done` : 'queue empty';
	}
	return (
		<Box width="100%" justifyContent="space-between">
			<Text wrap="truncate-end">
				<Text color={selected ? c.accent : c.line}>{selected ? '▌' : ' '}</Text>
				<Text color={tone}>{glyph} </Text>
				<Text color={selected ? c.textBright : c.text} bold={selected}>
					{p.name}
				</Text>
			</Text>
			<Text color={c.textFaint} wrap="truncate-end">
				{note}
			</Text>
		</Box>
	);
}

function Detail({ p, run, state, height }: { p?: Project; run?: Run; state?: ProjectState; height: number }) {
	if (!p) return <Text color={c.textFaint}>no projects yet: /add a directory, or type a goal to start here</Text>;
	const lines: { key: string; el: ReactElement }[] = [];
	const push = (el: ReactElement) => lines.push({ key: String(lines.length), el });
	push(<Text color={c.textDim} wrap="truncate-start">{p.path}</Text>);
	if (run) {
		const s = run.o.snapshot();
		const done = s.tasks.filter((x) => x.status === 'done').length;
		push(
			<Text wrap="truncate-end">
				<Text color={run.finished ? c.ok : c.accent}>{run.finished ? 'last run ' : 'running '}</Text>
				<Text color={c.text}>{`#${run.id} · ${done}/${s.tasks.length} tasks · $${s.cost.toFixed(2)} · ${elapsed(Date.now() - s.started)}`}</Text>
				<Text color={c.textFaint}>{'  Enter to open'}</Text>
			</Text>,
		);
		if (run.goal) push(<Text color={c.textDim} wrap="truncate-end">{`goal: ${run.goal}`}</Text>);
	}
	if (!state) push(<Text color={c.textFaint}>no tasks yet: type a goal and jarvis-code plans it into tasks here</Text>);
	else {
		// Only what is there: a row of zeros says nothing and pushes the spend off the edge.
		const counts = [
			[state.queue.length, 'open'],
			[state.blocked.length, 'blocked'],
			[state.review.length, 'to review'],
			[state.deferred.length, 'kept'],
			[state.done, 'done'],
		].filter(([n]) => n) as [number, string][];
		const summary = [...counts.map(([n, what]) => `${n} ${what}`), ...(state.spent > 0 ? [`$${state.spent.toFixed(2)} spent`] : [])];
		push(<Text color={c.textDim} wrap="truncate-end">{summary.join(' · ') || 'queue empty'}</Text>);
		if (state.running && !(run && !run.finished))
			push(<Text wrap="truncate-end"><Text color={c.accent}>{'◠ '}</Text><Text color={c.text}>{`${state.running.by === 'cockpit' ? 'running in another cockpit' : 'running in the background'} (pid ${state.running.pid}, since ${state.running.started.slice(11, 16)})`}</Text><Text color={c.textFaint}>{state.running.by === 'cockpit' ? '' : '  /stop ends it'}</Text></Text>);
		if (state.running && !(run && !run.finished)) for (const l of state.logTail ?? []) push(<Text color={c.textFaint} wrap="truncate-end">{`  ${l}`}</Text>);
		if (state.active) push(<Text wrap="truncate-end"><Text color={c.accent}>◠ </Text><Text color={c.text}>{`${state.active.id} ${state.active.title}`}</Text></Text>);
		for (const b of [...state.blocked, ...state.review])
			push(<Text wrap="truncate-end"><Text color={c.warn}>{b.status === 'blocked' ? '⊘ ' : '◇ '}</Text><Text color={c.text}>{`${b.id} ${b.title}`}</Text><Text color={c.textFaint}>{b.reason ? `  ${b.reason}` : ''}</Text></Text>);
		for (const d of state.deferred) push(<Text wrap="truncate-end"><Text color={c.textDim}>{'‥ '}</Text><Text color={c.textDim}>{`${d.id} ${d.title}`}</Text><Text color={c.textFaint}>{d.reason ? `  ${d.reason}` : ''}</Text></Text>);
		for (const q of state.queue.filter((q) => q.id !== state.active?.id))
			push(<Text wrap="truncate-end"><Text color={c.textFaint}>· </Text><Text color={c.textDim}>{`${q.id} ${q.type} ${q.tier} `}</Text><Text color={c.text}>{q.title}</Text></Text>);
	}
	return (
		<Box flexDirection="column" width="100%">
			<Label text={p.name} right={p.known ? 'tasks' : ''} />
			{lines.slice(0, Math.max(1, height)).map((l) => (
				<Box key={l.key}>{l.el}</Box>
			))}
		</Box>
	);
}

/** The first time: what jarvis-code is, which agents it found, and what to try. */
function Welcome({ config, here, height }: { config: Config; here: string; height: number }) {
	const agents = Object.entries(config.agents).map(([name, a]) => ({ name, on: agentEnabled(a), why: a.enabled === false ? 'off' : 'not found' }));
	const any = agents.some((a) => a.on);
	return (
		<Box flexDirection="column" width="100%">
			<Label text="welcome" />
			{/* Rows never shrink (a squeezed row paints over the next); what does not fit is clipped. */}
			{height >= 5 ? (
				<Box flexShrink={0}>
					<Text color={c.text} wrap="truncate-end">Plans a goal into checked tasks and works them with your coding agents.</Text>
				</Box>
			) : null}
			<Box flexShrink={0}>
				<Text wrap="truncate-end">
					{agents.map((a) => (
						<Text key={a.name}>
							<Text color={a.on ? c.ok : c.textFaint}>{a.on ? '● ' : '○ '}</Text>
							<Text color={a.on ? c.text : c.textDim}>{a.name}</Text>
							<Text color={c.textFaint}>{a.on ? '   ' : ` (${a.why})   `}</Text>
						</Text>
					))}
				</Text>
			</Box>
			<Box flexShrink={0}>
				{any ? (
					<Text color={c.textDim}>{`Type a goal to plan and run it in ${basename(here)}, /demo to watch a simulated run, /help for the rest.`}</Text>
				) : (
					<Text color={c.warn}>No coding agent found: install claude, codex or opencode (then `jarvis-code doctor`). /demo needs none.</Text>
				)}
			</Box>
		</Box>
	);
}

/** Every command; in a short terminal they flow into columns instead of overlapping. */
function Help({ height }: { height: number }) {
	const rows = Math.max(1, height - 1);
	const fits = COMMANDS.length + 1 <= rows;
	const cols = Math.ceil(COMMANDS.length / rows);
	const per = Math.ceil(COMMANDS.length / cols);
	const line = (cmd: Command) => (
		<Text key={cmd.name} wrap="truncate-end">
			<Text color={c.accent}>{`/${cmd.name}`}</Text>
			<Text color={c.textDim}>{cmd.args ? ` ${cmd.args}` : ''}</Text>
			<Text color={c.text}>{`  ${cmd.desc}`}</Text>
		</Text>
	);
	return (
		<Box flexDirection="column" width="100%">
			<Label text="commands" right="Esc to close" />
			<Box>
				{Array.from({ length: cols }, (_, i) => (
					<Box key={i} flexDirection="column" width={`${100 / cols}%`} paddingRight={cols > 1 ? 1 : 0}>
						{COMMANDS.slice(i * per, (i + 1) * per).map(line)}
					</Box>
				))}
			</Box>
			{fits && <Text color={c.textFaint}>↑↓ select a project (in a run: pick a task, Enter opens its detail) · Enter open · PgUp/PgDn/End activity · Tab complete · Esc back · Ctrl+C quit</Text>}
		</Box>
	);
}

function Prompt({ input, placeholder, menu }: { input: string; placeholder: string; menu: Command[] }) {
	return (
		<Box flexDirection="column">
			<Box borderStyle="round" borderColor={c.accentDeep} paddingX={1}>
				<Text color={c.accent}>{'❯ '}</Text>
				{input ? <Text color={c.textBright}>{input}</Text> : <Text color={c.textFaint}>{placeholder}</Text>}
				<Text color={c.accent}>▏</Text>
			</Box>
			{menu.slice(0, 6).map((cmd, i) => (
				<Text key={cmd.name} wrap="truncate-end">
					<Text color={i === 0 ? c.accent : c.accentDeep}>{`  /${cmd.name}`}</Text>
					<Text color={c.textDim}>{cmd.args ? ` ${cmd.args}` : ''}</Text>
					<Text color={c.textFaint}>{`  ${cmd.desc}`}</Text>
				</Text>
			))}
		</Box>
	);
}

export interface CockpitProps {
	manager: RunManager;
	config: Config;
	depth: ColorDepth;
	/** Open this run's dashboard first. */
	focus?: Run;
	/** The directory jarvis-code was started in: selected first. */
	cwd: string;
	fast?: boolean;
}

/**
 * The cockpit: every project and run in one place. Plain text in the prompt is a goal for
 * the selected project; `/` opens the command menu. Nothing but the prompt takes letters, so
 * typing a goal never triggers a shortcut.
 */
export function Cockpit({ manager, config, depth, focus, cwd, fast }: CockpitProps) {
	const { exit } = useApp();
	const { columns, rows } = useWindowSize();
	const [view, setView] = useState<'home' | 'help' | number>(focus ? focus.id : 'home');
	// The task a /task show opened in the right-hand pane; cleared whenever the view changes.
	const [inspect, setInspect] = useState<string | undefined>();
	useEffect(() => setInspect(undefined), [view]);
	// The task the cursor is on in a run's queue; cleared whenever the view changes.
	const [selTask, setSelTask] = useState<string | undefined>();
	useEffect(() => setSelTask(undefined), [view]);
	// /reports opens the reports pane for the selected project's run store; Esc closes it.
	// Read once when it opens: the cockpit renders at its fps while animating.
	const [reports, setReports] = useState<ReturnType<Store['reports']>>();
	const [v, setV] = useState<View>({ ...config.ui, learning: false });
	// Keys can arrive faster than React re-renders (fast typing, a paste split into chunks):
	// handlers read the ref, so each key builds on the last instead of a stale render.
	const [input, setInputState] = useState('');
	const typed = useRef('');
	const setInput = (s: string) => {
		typed.current = s;
		setInputState(s);
	};
	// Ctrl+P/Ctrl+N walk submitted goals and commands, oldest to newest; histPos sits at
	// history.length (the blank line past the newest entry) until a submit or Ctrl+P moves it.
	const history = useRef<string[]>([]);
	const histPos = useRef(0);
	const [msg, setMsg] = useState<{ text: string; tone: Tone } | undefined>();
	const [projects, setProjects] = useState<Project[]>(() => listProjects());
	const [selPath, setSelPath] = useState<string>(() => resolve(focus?.dir ?? cwd));
	const [quitArmed, setQuitArmed] = useState(0);
	// Scroll: feed lines back from live (0 follows the run).
	const [back, setBack] = useState(0);
	const feed = useRef<Activity[]>([]);
	const [, bump] = useState(0);

	const shown = withRuns(projects, manager.list(), resolve(cwd));
	const selIndex = Math.max(0, shown.findIndex((p) => p.path === selPath));
	const selected = shown[selIndex];
	const run: Run | undefined = typeof view === 'number' ? manager.runs.get(view) : undefined;
	const here = run?.dir ?? selected?.path ?? cwd;
	useEffect(() => setReports(undefined), [here]);
	const inspectTask = inspect ? Store.open(run?.dir ?? here)?.get(inspect) : undefined;
	useEffect(() => {
		if (inspect && !inspectTask) setInspect(undefined);
	}, [inspect, !!inspectTask]);

	const states = useMemo(() => new StateCache(), []);
	useEffect(() => {
		const refresh = setInterval(() => setProjects(listProjects()), 5000);
		refresh.unref(); // a refresh must never be what keeps the process alive
		const onActivity = (r: Run, a: Activity) => {
			feed.current.push({ ...a, text: `${r.name}  ${a.text}` });
			if (feed.current.length > 600) feed.current.splice(0, feed.current.length - 600);
		};
		const onFinished = (r: Run) => {
			setProjects(listProjects());
			states.invalidate(r.dir);
			bump((n) => n + 1);
		};
		manager.on('activity', onActivity);
		manager.on('finished', onFinished);
		return () => {
			clearInterval(refresh);
			manager.off('activity', onActivity);
			manager.off('finished', onFinished);
		};
	}, [manager, states]);

	const snap: Snapshot = run ? run.o.snapshot() : fleet(manager.list()) ?? restSnapshot(config);
	const animate = !config.ui.reducedMotion && ANIMATED.has(snap.reactor);
	useAnimation({ interval: Math.round(1000 / Math.max(1, config.ui.fps)), isActive: animate });
	useAnimation({ interval: 250 });
	const t = animate ? Date.now() / 1000 : 0;

	const say = (text: string, tone: Tone = 'info') => setMsg({ text, tone });
	const select = (p: Project) => setSelPath(p.path);

	const startRun = async (dir: string, goal?: string, overrides?: unknown) => {
		try {
			const r = await manager.start(dir, { goal, overrides });
			addRecent(dir);
			setProjects(listProjects());
			setSelPath(r.dir);
			setView(r.id);
			if (r.warnings?.length) say(`run #${r.id} started, but ${r.warnings.join('; ')}`, 'warn');
			else say(goal ? `run #${r.id} started in ${r.name}` : `working the ${r.name} queue (run #${r.id})`, 'ok');
		} catch (e) {
			say((e as Error).message, 'danger');
		}
	};

	const findProject = (q: string) => {
		const want = q.toLowerCase();
		return shown.find((p) => p.name.toLowerCase() === want) ?? shown.find((p) => p.name.toLowerCase().startsWith(want)) ?? shown.find((p) => p.path === resolve(cwd, q));
	};

	const command = (line: string) => {
		const [word, ...rest] = line.slice(1).split(/\s+/);
		const arg = rest.join(' ').trim();
		const cmd = COMMANDS.find((x) => x.name === word) ?? matchCommands(line)[0];
		if (!cmd) return say(`unknown command /${word}: /help lists them`, 'warn');
		const current = run ?? manager.inDir(here);
		switch (cmd.name) {
			case 'run':
				if (!arg) return say('/run needs a goal', 'warn');
				return void startRun(here, arg);
			case 'brainstorm':
				if (!arg) return say('/brainstorm needs a goal', 'warn');
				return void startRun(here, arg, { planning: { mode: 'deep' } });
			case 'improve':
				return void startRun(here, improveGoal(arg || undefined), { planning: { mode: 'deep' } });
			case 'work':
				return void startRun(here);
			case 'demo': {
				const r = manager.startDemo(fast);
				setView(r.id);
				setSelPath(r.dir);
				return say(`demo run #${r.id}: simulated agents, nothing is spent`, 'ok');
			}
			case 'open': {
				const p = arg ? findProject(arg) : selected;
				const r = p && manager.inDir(p.path);
				if (!r) return say(`${p?.name ?? arg}: no run in this session; type a goal to start one`, 'warn');
				return setView(r.id);
			}
			case 'home':
				return setView('home');
			case 'help':
				return setView('help');
			case 'cd': {
				const p = arg && findProject(arg);
				if (p) {
					select(p);
					return setView('home');
				}
				if (arg && existsSync(resolve(cwd, arg)) && statSync(resolve(cwd, arg)).isDirectory()) {
					addRecent(resolve(cwd, arg));
					setProjects(listProjects());
					setSelPath(resolve(cwd, arg));
					return setView('home');
				}
				return say(`no project or directory "${arg}"`, 'warn');
			}
			case 'add': {
				const dir = resolve(cwd, arg || '.');
				if (!existsSync(dir) || !statSync(dir).isDirectory()) return say(`not a directory: ${dir}`, 'warn');
				addRecent(dir);
				setProjects(listProjects());
				setSelPath(dir);
				setView('home');
				return say(`added ${dir}`, 'ok');
			}
			case 'task': {
				const [verb = '', ...words] = arg.split(/\s+/);
				try {
					if (verb === 'add') {
						// `FIX: title` sets the type, as in a plan.
						const m = words.join(' ').match(/^(?:(RESEARCH|CLEAN|PERF|SECURITY|FIX|FEATURE):\s*)?(.+)$/i);
						if (!m) return say('/task add needs a title', 'warn');
						const [t] = new Store(here).add([{ title: m[2], type: m[1] }]);
						return say(`added ${t.id} ${t.title} to ${basename(here)}: /work runs it`, 'ok');
					}
					if (verb === 'show') {
						const id = words[0] ?? '';
						const t = Store.open(here)?.get(id.toUpperCase());
						return t ? setInspect(t.id) : say(`no task ${id} in ${basename(here)}`, 'warn');
					}
					if (verb === 'bump') {
						const target = /^T-\d+$/i.test(words[0] ?? '') ? words[0] : inspect;
						if (!target) return say('/task bump [id]: no task open to act on', 'warn');
						const id = target.toUpperCase();
						Store.open(here)?.bump(id);
						return say(`${id} goes next in ${basename(here)}`, 'ok');
					}
					if (!(verb in DECISIONS)) return say('/task add <title> · /task show <id> · /task retry|defer|drop|approve|bump [id] [why]', 'warn');
					const hasTarget = /^T-\d+$/i.test(words[0] ?? '') || (BULK as readonly string[]).includes((words[0] ?? '').toLowerCase());
					const target = hasTarget ? words[0] : inspect;
					if (!target) return say('/task retry|defer|drop|approve [id] [why]: no task open to act on', 'warn');
					const project = Store.open(here);
					if (!project) return say(`${basename(here)} has no tasks yet`, 'warn');
					return say(decideTask(project, verb as Decision, target, hasTarget ? words.slice(1).join(' ') : words.join(' ')), 'ok');
				} catch (e) {
					return say((e as Error).message, 'danger');
				} finally {
					states.invalidate(here);
				}
			}
			case 'trust': {
				if (!arg) return say('/trust <route or tool>: see /learned for what is switched off', 'warn');
				const gone = manager.learning.forgive(arg);
				manager.learning.save();
				return say(gone.length ? `forgot ${gone.join(', ')}: used again from the next task` : `nothing learned about ${arg}`, gone.length ? 'ok' : 'warn');
			}
			case 'report': {
				const r = run ?? (selected && manager.inDir(selected.path));
				if (!r) return say('no run here yet', 'warn');
				// Finished runs kept theirs; a live one gets a snapshot. A demo has no store: its scratch dir.
				const path = r.o.reportPath ?? (r.demo ? (writeFileSync(join(r.dir, 'report.md'), r.o.report()), join(r.dir, 'report.md')) : new Store(r.dir).research(`report-${Date.now()}`, r.o.report()));
				return say(`report: ${path}`, 'ok');
			}
			case 'reports':
				return setReports((r) => (r ? undefined : (Store.open(here)?.reports() ?? [])));
			case 'runs': {
				const list = manager.list();
				if (!list.length) return say('no runs yet in this session');
				return say(list.map((r) => `#${r.id} ${r.name} ${r.finished ? 'finished' : 'running'}`).join(' · '));
			}
			case 'stop':
				if (arg === 'all') {
					void manager.stopAll();
					return say('stopping every run', 'warn');
				}
				if (!current || current.finished) {
					// A run of this project in another process: stop the ones jarvis-code started from a CLI.
					states.invalidate(here);
					return say(stopElsewhere(here), 'warn');
				}
				manager.stop(current);
				return say(`stopping run #${current.id}`, 'warn');
			case 'detach': {
				if (!current || current.finished) return say('nothing running here to detach', 'warn');
				if (current.demo || current.o.snapshot().source !== 'store') return say('only runs on the task store can go to the background', 'warn');
				if (current.o.snapshot().phase === 'planning') return say('still planning: detach once it is working, so the plan is kept', 'warn');
				const r = current;
				manager.stop(r);
				say(`handing ${r.name} to the background…`);
				// Running tasks are killed and stay queued; the background run picks the queue up.
				void r.done
					.then(() => runDetached(r.dir, ['work']))
					.then(({ pid, log }) => {
						states.invalidate(r.dir);
						say(`${r.name} runs in the background (pid ${pid}); log ${log}`, 'ok');
					})
					.catch((e: Error) => say(e.message, 'danger'));
				return;
			}
			case 'pause':
				if (!current || current.finished) return say('nothing running here', 'warn');
				current.o.togglePause();
				return say(current.o.paused ? 'paused: running tasks finish, no new ones start' : 'resumed');
			case 'diffs':
				return setV({ ...v, showDiffs: !v.showDiffs });
			case 'tools':
				return setV({ ...v, showTools: !v.showTools });
			case 'messages':
				return setV({ ...v, showText: !v.showText });
			case 'learned':
				return setV({ ...v, learning: !v.learning });
			case 'reactor':
				return setV({ ...v, reactor: v.reactor === 'large' ? 'small' : v.reactor === 'small' ? 'off' : 'large' });
			case 'quit':
				void manager.stopAll().then(() => exit());
				return say('stopping every run…', 'warn');
		}
	};

	const submit = () => {
		const line = typed.current.trim();
		setInput('');
		setMsg(undefined);
		if (!line) {
			if (run && selTask) {
				if (run.demo) return say('a /demo run keeps its queue in memory: there is no stored task detail');
				return setInspect(selTask);
			}
			if (view === 'home' && selected) {
				const r = manager.inDir(selected.path);
				if (r) setView(r.id);
				else say(`type a goal to start a run in ${selected.name}`);
			}
			return;
		}
		if (history.current[history.current.length - 1] !== line) history.current.push(line);
		histPos.current = history.current.length;
		if (line.startsWith('/')) return command(line);
		void startRun(here, line);
	};

	useInput((ch, key) => {
		const input = typed.current;
		if (key.ctrl && ch === 'c') {
			if (input) return setInput('');
			if (view !== 'home') return setView('home');
			if (!manager.active().length || Date.now() - quitArmed < 2500) {
				void manager.stopAll().then(() => exit());
				return;
			}
			setQuitArmed(Date.now());
			return say(`${manager.active().length} run(s) going: Ctrl+C again to stop them and quit`, 'warn');
		}
		if (key.return) return submit();
		if (key.escape) return input ? setInput('') : inspect ? setInspect(undefined) : reports ? setReports(undefined) : setView('home');
		if (key.backspace || key.delete) return setInput(input.slice(0, -1));
		if (key.ctrl && ch === 'u') return setInput('');
		if (key.ctrl && ch === 'p') {
			if (!history.current.length) return;
			histPos.current = Math.max(0, histPos.current - 1);
			return setInput(history.current[histPos.current]);
		}
		if (key.ctrl && ch === 'n') {
			if (histPos.current >= history.current.length) return;
			histPos.current += 1;
			return setInput(histPos.current < history.current.length ? history.current[histPos.current] : '');
		}
		if (key.tab) {
			const tm = input.match(/^\/task (\w*)$/);
			const verb = tm && TASK_VERBS.find((v) => v.startsWith(tm[1]));
			if (verb) return setInput(`/task ${verb} `);
			const m = matchCommands(input)[0];
			if (m) setInput(`/${m.name}${m.args ? ' ' : ''}`);
			return;
		}
		if (key.pageUp || key.pageDown) return setBack((b) => Math.max(0, Math.min(2000, b + (key.pageUp ? 1 : -1) * Math.max(1, feedRows - 2))));
		if (key.end) return setBack(0);
		if ((key.upArrow || key.downArrow) && !input && run) {
			const q = queueOrder(snap.tasks);
			if (!q.length) return;
			const i = selTask ? q.findIndex((x) => x.id === selTask) : -1;
			return setSelTask(q[Math.max(0, Math.min(q.length - 1, i + (key.upArrow ? -1 : 1)))].id);
		}
		if ((key.upArrow || key.downArrow) && !input && shown.length) {
			const i = (selIndex + (key.upArrow ? -1 : 1) + shown.length) % shown.length;
			return select(shown[i]);
		}
		if (ch && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) setInput(input + ch.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, ''));
	});

	// Layout: header, body, feed, prompt (+ menu), status line.
	const menu = matchCommands(input);
	const roomy = rows >= 28 && columns >= 90;
	const reactorRows = v.reactor === 'large' && roomy ? Math.max(11, Math.min(17, Math.floor(rows * 0.36))) : 2;
	const headerRows = v.reactor === 'off' ? 6 : Math.max(reactorRows, 6);
	const promptRows = 3 + Math.min(6, menu.length) + 1;
	const free = Math.max(8, rows - headerRows - 2 - promptRows - 4);
	const body = Math.max(4, Math.floor(free * 0.5));
	const feedRows = Math.max(3, free - body);
	const live = manager.active().length;
	const needsYou = shown.reduce((n, p) => {
		const state = states.get(p.path);
		return n + (state ? state.blocked.length + state.review.length : 0);
	}, 0);
	const needsYouNote = needsYou ? ` · ${needsYou} need you` : '';
	const line =
		run !== undefined
			? undefined
			: live
				? `${live} run${live === 1 ? '' : 's'} going · ${shown.length} projects${needsYouNote}`
				: `${shown.length} project${shown.length === 1 ? '' : 's'}${needsYouNote} · type a goal, or / for commands`;
	const placeholder = run ? `a goal for ${run.name}, or /home` : selected ? `a goal for ${selected.name}, or / for commands` : 'a goal, or / for commands';
	const tone = msg ? { info: c.textDim, ok: c.ok, warn: c.warn, danger: c.danger }[msg.tone] : c.textFaint;
	const feedItems = run ? run.o.snapshot().activity : feed.current;

	// The project list scrolls to keep the selection in the middle.
	// Nothing planned anywhere and nothing run yet: show how to start instead of an empty project.
	const firstRun = !manager.list().length && shown.every((p) => !p.known);
	const listTop = Math.max(0, Math.min(selIndex - Math.floor((body - 1) / 2), shown.length - (body - 1)));
	return (
		<Box flexDirection="column" width={columns} paddingX={1}>
			<Box borderStyle="round" borderColor={c.tick} paddingX={1}>
				<Header snap={snap} t={t} v={v} depth={depth} reactorRows={reactorRows} tempo={3} width={columns} style={config.ui.reactorStyle} line={line} />
			</Box>
			<Box height={body + 2} borderStyle="round" borderColor={c.tick} paddingX={1} overflow="hidden">
				{view === 'help' ? (
					<Help height={body} />
				) : run ? (
					<>
						<Box width={inspectTask ? '30%' : '50%'} paddingRight={2}>
							<Tasks tasks={snap.tasks} height={body - 1} t={t} selected={selTask} planning={snap.phase === 'planning' ? (snap.stage ?? 'planning the goal') : undefined} />
						</Box>
						<Box width={inspectTask ? '70%' : '50%'}>
							{inspectTask ? (
								<TaskDetail task={inspectTask} height={body} />
							) : reports ? (
								<Reports reports={reports} height={body} />
							) : v.learning ? (
								<Learning learning={run.o.learning} height={body} />
							) : (
								<Workers workers={snap.workers} t={t} height={body} />
							)}
						</Box>
					</>
				) : (
					<>
						<Box width={inspectTask ? '30%' : '42%'} paddingRight={2} flexDirection="column">
							<Label text="projects" right={`${shown.length}`} />
							{shown.slice(listTop, listTop + body - 1).map((p) => (
								<ProjectLine key={p.path} p={p} run={manager.inDir(p.path)} state={states.get(p.path)} selected={p.path === selected?.path} t={t} />
							))}
						</Box>
						<Box width={inspectTask ? '70%' : '58%'}>
							{inspectTask ? (
								<TaskDetail task={inspectTask} height={body} />
							) : reports ? (
								<Reports reports={reports} height={body} />
							) : v.learning ? (
								<Learning learning={manager.learning} height={body} />
							) : firstRun ? (
								<Welcome config={config} here={selected?.path ?? cwd} height={body} />
							) : (
								<Detail p={selected} run={selected && manager.inDir(selected.path)} state={selected ? states.get(selected.path) : undefined} height={body - 1} />
							)}
						</Box>
					</>
				)}
			</Box>
			<Box height={feedRows + 2} borderStyle="round" borderColor={c.tick} paddingX={1} overflow="hidden">
				<Feed activity={feedItems} v={v} height={feedRows - 1} back={back} />
			</Box>
			<Prompt input={input} placeholder={placeholder} menu={menu} />
			<Box paddingX={1} justifyContent="space-between">
				<Text color={tone} wrap="truncate-end">
					{msg?.text ?? (run ? `run #${run.id} · ${run.dir}` : `${here}`)}
				</Text>
				<Text color={c.textFaint}>{inspectTask ? '/task retry [why] · approve · drop · bump · Esc close' : run ? 'Esc home · /stop · /pause · /help' : '↑↓ select · Enter open · /help'}</Text>
			</Box>
		</Box>
	);
}
