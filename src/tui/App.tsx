import { Box, Text, useAnimation, useApp, useInput, useWindowSize } from 'ink';
import { useState, type ReactElement } from 'react';
import type { Config } from '../config.js';
import type { Activity, Orchestrator, Snapshot, TaskStatus, TaskView, WorkerView } from '../orchestrator.js';
import { large, ring, spinner, WORDS, type ReactorState } from '../reactor.js';
import { c, type ColorDepth } from '../theme.js';
import { cap, clock, elapsed, KIND, ORDER, STATUS, visible, type View } from './style.js';

/** States the reactor moves in; idle, stopped and offline are drawn still. */
const ANIMATED = new Set<ReactorState>(['thinking', 'tool', 'alert', 'attention', 'warming']);

const STATE_COLOR: Record<ReactorState, string> = {
	idle: c.accentDeep, thinking: c.accent, tool: c.accent, attention: c.warn,
	warming: c.warming, alert: c.danger, kill: c.kill, offline: c.tick,
};

function Label({ text, right }: { text: string; right?: string }) {
	return (
		<Box justifyContent="space-between">
			<Text color={c.textDim}>{cap(text)}</Text>
			{right ? <Text color={c.textFaint}>{right}</Text> : null}
		</Box>
	);
}

function ReactorView({ snap, t, rows, depth, tempo }: { snap: Snapshot; t: number; rows: number; depth: ColorDepth; tempo: number }) {
	const done = snap.tasks.filter((x) => x.status === 'done').length;
	const opts = {
		depth,
		tempo,
		since: (Date.now() - snap.stateSince) / 1000,
		segments: snap.tasks.length,
		done,
		running: snap.workers.length,
		goal: !!snap.goal && snap.phase !== 'finished',
	};
	const lines = rows > 2 ? large(snap.reactor, t, rows, opts) : ring(snap.reactor, t, opts);
	return (
		<Box flexDirection="column" marginRight={2}>
			{lines.map((l, i) => (
				<Text key={i}>{l}</Text>
			))}
		</Box>
	);
}

function Progress({ done, total, width }: { done: number; total: number; width: number }) {
	const n = total ? Math.round((done / total) * width) : 0;
	return (
		<Text>
			<Text color={c.accent}>{'▰'.repeat(n)}</Text>
			<Text color={c.line}>{'▱'.repeat(width - n)}</Text>
		</Text>
	);
}

function Header({ snap, t, v, depth, reactorRows, tempo, width }: { snap: Snapshot; t: number; v: View; depth: ColorDepth; reactorRows: number; tempo: number; width: number }) {
	const count = (s: TaskStatus) => snap.tasks.filter((x) => x.status === s).length;
	const done = count('done');
	const word = snap.paused ? 'Paused' : snap.phase === 'finished' ? (snap.reactor === 'attention' ? 'Finished · needs you' : 'Finished') : WORDS[snap.reactor];
	const stateColor = snap.paused ? c.warn : STATE_COLOR[snap.reactor];
	return (
		<Box>
			{v.reactor !== 'off' ? <ReactorView snap={snap} t={t} rows={reactorRows} depth={depth} tempo={tempo} /> : null}
			<Box flexDirection="column" flexGrow={1} justifyContent="center">
				<Text>
					<Text color={c.accentLift} bold>
						{cap('jarvis')}
					</Text>
					<Text color={c.textDim}>{'  ' + cap('code')}</Text>
				</Text>
				<Text> </Text>
				<Text wrap="truncate-end">
					<Text color={stateColor} bold>
						{v.reactor === 'off' || reactorRows <= 2 ? `${spinner(t)} ` : ''}
						{word.toUpperCase()}
					</Text>
					{snap.goal ? <Text color={c.text}>{'  ' + snap.goal}</Text> : <Text color={c.textDim}>{`  working the ${snap.source} queue`}</Text>}
				</Text>
				<Text> </Text>
				<Text>
					<Text color={c.textDim}>{cap('tasks') + ' '}</Text>
					<Text color={c.textBright}>{`${done}/${snap.tasks.length} `}</Text>
					<Progress done={done} total={snap.tasks.length} width={Math.max(8, Math.min(30, width - 70))} />
					<Text color={c.textDim}>{'   ' + cap('cost') + ' '}</Text>
					<Text color={c.textBright}>{`$${snap.cost.toFixed(2)}`}</Text>
					<Text color={c.textDim}>{'   ' + cap('time') + ' '}</Text>
					<Text color={c.textBright}>{elapsed(Date.now() - snap.started)}</Text>
				</Text>
				<Text wrap="truncate-end">
					{count('blocked') ? <Text color={c.warn}>{`⊘ ${count('blocked')} blocked  `}</Text> : null}
					{count('review') ? <Text color={c.warn}>{`◇ ${count('review')} to review  `}</Text> : null}
					{snap.routes.map((r) => (
						<Text key={r.id} color={r.off ? c.danger : r.runs ? c.text : c.textDim}>
							{`${r.off ? '✕' : '●'} ${r.id}${r.runs ? ` ${Math.round(r.score * 100)}%` : ''}   `}
						</Text>
					))}
				</Text>
				{snap.error ? (
					<Text color={c.danger} wrap="truncate-end">
						{`✗ ${snap.error}`}
					</Text>
				) : null}
			</Box>
		</Box>
	);
}

function Tasks({ tasks, height, t }: { tasks: TaskView[]; height: number; t: number }) {
	const sorted = [...tasks].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
	const shown = sorted.slice(0, Math.max(1, height));
	return (
		<Box flexDirection="column">
			<Label text="queue" right={`${tasks.length} task${tasks.length === 1 ? '' : 's'}`} />
			{shown.length ? null : <Text color={c.textFaint}>nothing queued</Text>}
			{shown.map((task) => {
				const [icon, key] = STATUS[task.status];
				const color = c[key];
				return (
					<Text key={task.id} wrap="truncate-end">
						<Text color={color}>{task.status === 'running' ? spinner(t) : icon}</Text>
						<Text color={c.textDim}>{` ${task.id} `}</Text>
						<Text color={task.status === 'done' ? c.textDim : c.text}>{task.title}</Text>
						{task.attempts > 1 && task.status !== 'done' ? <Text color={c.warn}>{` ×${task.attempts}`}</Text> : null}
					</Text>
				);
			})}
			{sorted.length > shown.length ? <Text color={c.textFaint}>{`  … ${sorted.length - shown.length} more`}</Text> : null}
		</Box>
	);
}

function Workers({ workers, t }: { workers: WorkerView[]; t: number }) {
	return (
		<Box flexDirection="column">
			<Label text="agents" right={workers.length ? `${workers.length} running` : undefined} />
			{workers.length ? null : <Text color={c.textFaint}>idle</Text>}
			{workers.map((w) => {
				const routeModel = w.route.includes(':') ? w.route.slice(w.route.indexOf(':') + 1) : undefined;
				const drifted = w.model && routeModel && w.model !== routeModel;
				return (
					<Box key={w.key} flexDirection="column">
						<Text wrap="truncate-end">
							<Text color={w.phase === 'verifying' ? c.accentLift : c.accent}>{w.phase === 'verifying' ? '◎' : spinner(t)}</Text>
							<Text color={c.textBright}>{` ${w.task === 'plan' ? 'plan' : w.task} `}</Text>
							<Text color={c.accentDeep}>{w.route}</Text>
							{drifted ? <Text color={c.warming}>{` ⇅ ${w.model}`}</Text> : null}
							<Text color={c.textDim}>{`  ${elapsed(Date.now() - w.started)} · ${w.tools} tools${w.cost ? ` · $${w.cost.toFixed(2)}` : ''}`}</Text>
						</Text>
						<Text color={c.textFaint} wrap="truncate-end">{`  └ ${w.phase === 'verifying' ? 'verifying' : w.last}`}</Text>
					</Box>
				);
			})}
		</Box>
	);
}

function Learning({ o }: { o: Orchestrator }) {
	const { routes, tools } = o.learning.data;
	const rows = [
		...Object.entries(routes).map(([k, st]) => ({ k, st, off: o.learning.isOff(st) })),
		...Object.entries(tools).map(([k, st]) => ({ k: k.replace('|', ' › '), st, off: o.learning.isOff(st) })),
	];
	return (
		<Box flexDirection="column">
			<Label text="learned" right="l to close" />
			{rows.length ? null : <Text color={c.textFaint}>nothing yet: routes and tools are scored as runs finish</Text>}
			{rows.map(({ k, st, off }) => (
				<Text key={k} wrap="truncate-end">
					<Text color={off ? c.danger : c.ok}>{off ? '✕ ' : '● '}</Text>
					<Text color={c.text}>{k}</Text>
					<Text color={c.textDim}>{`  ${st.ok}/${st.runs} ok${off ? `  off: ${st.reason}` : ''}`}</Text>
				</Text>
			))}
		</Box>
	);
}

function Feed({ activity, v, height }: { activity: Activity[]; v: View; height: number }) {
	const lines: { key: string; el: ReactElement }[] = [];
	for (let i = activity.length - 1; i >= 0 && lines.length < height; i--) {
		const a = activity[i];
		if (!visible(a, v)) continue;
		const [icon, key] = KIND[a.kind];
		const color = c[key];
		const detail =
			a.kind === 'change' && a.detail
				? a.detail.split('\n').slice(0, 6).map((l, j) => (
						<Text key={j} color={l.startsWith('+') ? c.ok : l.startsWith('-') ? c.danger : c.textFaint} wrap="truncate-end">
							{'           ' + l}
						</Text>
					))
				: [];
		for (let j = detail.length - 1; j >= 0 && lines.length < height; j--) lines.push({ key: `${i}.${j}`, el: detail[j] });
		if (lines.length >= height) break;
		lines.push({
			key: String(i),
			el: (
				<Text wrap="truncate-end">
					<Text color={c.textFaint}>{clock(a.at) + ' '}</Text>
					<Text color={color}>{icon + ' '}</Text>
					<Text color={a.kind === 'tool' || a.kind === 'text' ? c.textDim : c.text}>{a.text}</Text>
				</Text>
			),
		});
	}
	return (
		<Box flexDirection="column">
			<Label text="activity" right={[v.showDiffs && 'diffs', v.showTools && 'tools', v.showText && 'messages'].filter(Boolean).join(' · ') || 'completions'} />
			{lines.length ? null : <Text color={c.textFaint}>waiting for the first event</Text>}
			{lines.reverse().map((l) => (
				<Box key={l.key}>{l.el}</Box>
			))}
		</Box>
	);
}

function Keys({ v, snap }: { v: View; snap: Snapshot }) {
	const k = (key: string, label: string, on?: boolean) => (
		<Text key={key}>
			<Text color={c.accent}>{key}</Text>
			<Text color={on ? c.text : c.textFaint}>{` ${label}   `}</Text>
		</Text>
	);
	return (
		<Box>
			{k('q', snap.phase === 'finished' || snap.phase === 'stopped' ? 'exit' : 'stop', true)}
			{k('p', snap.paused ? 'resume' : 'pause', true)}
			{k('d', 'diffs', v.showDiffs)}
			{k('t', 'tools', v.showTools)}
			{k('m', 'messages', v.showText)}
			{k('r', `reactor ${v.reactor}`, v.reactor !== 'off')}
			{k('l', 'learned', v.learning)}
		</Box>
	);
}

export function App({ o, config, depth, done }: { o: Orchestrator; config: Config; depth: ColorDepth; done: Promise<unknown> }) {
	const [v, setV] = useState<View>({ ...config.ui, learning: false });
	const [finished, setFinished] = useState(false);
	const { exit } = useApp();
	const { columns, rows } = useWindowSize();
	const snap = o.snapshot();
	const animate = !config.ui.reducedMotion && ANIMATED.has(snap.reactor);
	// One shared timer: the reactor's frame rate while it moves, a slow tick otherwise so
	// clocks and counters stay current.
	useAnimation({ interval: Math.round(1000 / Math.max(1, config.ui.fps)), isActive: animate });
	useAnimation({ interval: 250 });
	useState(() => done.then(() => setFinished(true)));

	useInput((input, key) => {
		if (input === 'q' || (key.ctrl && input === 'c')) {
			if (finished || snap.phase === 'stopped') exit();
			else {
				o.stop();
				void done.then(() => exit());
			}
		} else if (input === 'p') o.togglePause();
		else if (input === 'd') setV({ ...v, showDiffs: !v.showDiffs });
		else if (input === 't') setV({ ...v, showTools: !v.showTools });
		else if (input === 'm') setV({ ...v, showText: !v.showText });
		else if (input === 'l') setV({ ...v, learning: !v.learning });
		else if (input === 'r') setV({ ...v, reactor: v.reactor === 'large' ? 'small' : v.reactor === 'small' ? 'off' : 'large' });
	});

	// The large reactor needs room: 2 cells wide per row beside a ≥50-column header.
	const roomy = rows >= 28 && columns >= 90;
	const reactorRows = v.reactor === 'large' && roomy ? Math.max(9, Math.min(15, Math.floor(rows * 0.34))) : 2;
	const headerRows = v.reactor === 'off' ? 6 : Math.max(reactorRows, 6);
	const middle = Math.max(4, Math.min(snap.tasks.length + 2, Math.floor((rows - headerRows - 6) * 0.45)));
	const feed = Math.max(3, rows - headerRows - middle - 7);
	// A still reactor is drawn at a fixed instant: the slow tick must not move it.
	const t = animate ? Date.now() / 1000 : 0;
	const tempo = 3; // the web's rotation periods read as stillness at braille resolution

	return (
		<Box flexDirection="column" width={columns} paddingX={1}>
			<Box borderStyle="round" borderColor={c.tick} paddingX={1}>
				<Header snap={snap} t={t} v={v} depth={depth} reactorRows={reactorRows} tempo={tempo} width={columns} />
			</Box>
			<Box height={middle + 2} borderStyle="round" borderColor={c.tick} paddingX={1}>
				<Box width="50%" paddingRight={2}>
					<Tasks tasks={snap.tasks} height={middle - 1} t={t} />
				</Box>
				<Box width="50%">{v.learning ? <Learning o={o} /> : <Workers workers={snap.workers} t={t} />}</Box>
			</Box>
			<Box height={feed + 2} borderStyle="round" borderColor={c.tick} paddingX={1} overflow="hidden">
				<Feed activity={snap.activity} v={v} height={feed - 1} />
			</Box>
			<Box paddingX={1}>
				<Keys v={v} snap={snap} />
			</Box>
		</Box>
	);
}
