import { Box, Text, Transform } from 'ink';
import { basename } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { ReactElement } from 'react';
import type { Config } from '../config.js';
import type { Learning as LearningStore } from '../learn.js';
import { roleOf, type Activity, type Snapshot, type TaskStatus, type TaskView, type WorkerView } from '../orchestrator.js';
import { large, ring, spinner, WORDS, type ReactorState } from '../reactor.js';
import { sameModel } from '../agents/types.js';
import type { Project, StoredTask } from '../store.js';
import { c, type ColorDepth } from '../theme.js';
import { cap, clock, elapsed, kindMark, ORDER, statusMark, visible, type View } from './style.js';

/** States the reactor moves in; idle, stopped and offline are drawn still. */
export const ANIMATED = new Set<ReactorState>(['thinking', 'tool', 'alert', 'attention', 'warming']);

const STATE_COLOR: Record<ReactorState, string> = {
	idle: c.accentDeep, thinking: c.accent, tool: c.accent, attention: c.warn,
	warming: c.warming, alert: c.danger, kill: c.kill, offline: c.tick,
};

export function Label({ text, right }: { text: string; right?: string }) {
	return (
		// A panel's title never gives way: when rows run out, the bottom is clipped instead.
		<Box justifyContent="space-between" width="100%" flexShrink={0}>
			<Text color={c.textDim}>{cap(text)}</Text>
			{right ? <Text color={c.textFaint}>{right}</Text> : null}
		</Box>
	);
}

export function ReactorView({ snap, t, rows, depth, tempo, style }: { snap: Snapshot; t: number; rows: number; depth: ColorDepth; tempo: number; style: Config['ui']['reactorStyle'] }) {
	const done = snap.tasks.filter((x) => x.status === 'done').length;
	const opts = {
		depth,
		tempo,
		// A still reactor is one fixed instant: its state clock stops with its motion clock.
		since: t ? (Date.now() - snap.stateSince) / 1000 : 0,
		prev: snap.prevReactor,
		style,
		segments: snap.tasks.length,
		done,
		running: snap.workers.length,
		goal: !!snap.goal && snap.phase !== 'finished',
	};
	const lines = rows > 2 ? large(snap.reactor, t, rows, opts) : ring(snap.reactor, t, opts);
	// Ink keeps the size of every distinct string it measures, forever (a Map in ink 7.1.1's
	// measure-text.js), and each animated frame is new strings: ~0.3 MB/s for as long as a run
	// goes (scripts/soak-cockpit.mjs). A Transform is measured by its blank child, one string per
	// width, and swaps the frame in only as it draws. Every glyph is one column wide.
	return (
		<Box flexDirection="column" marginRight={2}>
			{lines.map((l, i) => (
				<Transform key={i} transform={() => l}>
					{' '.repeat(stripVTControlCharacters(l).length)}
				</Transform>
			))}
		</Box>
	);
}

export function Progress({ done, total, width }: { done: number; total: number; width: number }) {
	const n = total ? Math.round((done / total) * width) : 0;
	return (
		<Text>
			<Text color={c.accent}>{'▰'.repeat(n)}</Text>
			<Text color={c.line}>{'▱'.repeat(width - n)}</Text>
		</Text>
	);
}

export function Header({ snap, t, v, depth, reactorRows, tempo, width, style, line }: { snap: Snapshot; t: number; v: View; depth: ColorDepth; reactorRows: number; tempo: number; width: number; style: Config['ui']['reactorStyle']; line?: string }) {
	const count = (s: TaskStatus) => snap.tasks.filter((x) => x.status === s).length;
	const done = count('done');
	const word = snap.paused ? 'Paused' : snap.phase === 'finished' ? (snap.reactor === 'attention' ? 'Finished · needs you' : 'Finished') : WORDS[snap.reactor];
	const stateColor = snap.paused ? c.warn : STATE_COLOR[snap.reactor];
	return (
		<Box>
			{v.reactor !== 'off' ? <ReactorView snap={snap} t={t} rows={reactorRows} depth={depth} tempo={tempo} style={style} /> : null}
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
					{snap.stage ? <Text color={stateColor}>{` · ${snap.stage}`}</Text> : null}
					{line !== undefined ? <Text color={c.text}>{'  ' + line}</Text> : snap.goal ? <Text color={c.text}>{'  ' + snap.goal}</Text> : <Text color={c.textDim}>{'  working the queue'}</Text>}
				</Text>
				<Text> </Text>
				<Text>
					<Text color={c.textDim}>{cap('tasks') + ' '}</Text>
					<Text color={c.textBright}>{`${done}/${snap.tasks.length} `}</Text>
					<Progress done={done} total={snap.tasks.length} width={Math.max(8, Math.min(30, width - 70) - (snap.planning ? 6 : 0))} />
					<Text color={c.textDim}>{'   ' + cap('cost') + ' '}</Text>
					<Text color={c.textBright}>{`$${snap.cost.toFixed(2)}`}</Text>
					{snap.planning ? <Text color={c.textDim}>{` planning $${snap.planning.toFixed(2)}`}</Text> : null}
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

/** Queue order on screen: what is moving, then what needs a human, then what waits, then history. */
export function queueOrder(tasks: TaskView[]): TaskView[] {
	return [...tasks].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
}

/** `planning`: what planning is doing, shown while there are no tasks yet. `selected`: a task id to mark and keep in view. */
export function Tasks({ tasks, height, t, planning, top = 0, selected, icons = 'text' }: { tasks: TaskView[]; height: number; t: number; planning?: string; top?: number; selected?: string; icons?: View['icons'] }) {
	const sorted = queueOrder(tasks);
	const selIndex = selected ? sorted.findIndex((x) => x.id === selected) : -1;
	// Scrolled: a row each for what is above and below, so the list never pretends to be whole.
	// A selection overrides the scroll position: the list scrolls only once the cursor leaves the
	// window, and then keeps it on the last row (one row goes to the "above" marker).
	const want = selIndex < 0 ? top : selIndex < height ? 0 : selIndex - (height - 2);
	const first = Math.max(0, Math.min(want, sorted.length - Math.max(1, height - 1)));
	const room = Math.max(1, height - (first > 0 ? 1 : 0));
	const shown = sorted.slice(first, first + room);
	return (
		<Box flexDirection="column" flexGrow={1}>
			<Label text="queue" right={`${tasks.length} task${tasks.length === 1 ? '' : 's'}`} />
			{shown.length ? null : <Text color={c.textFaint}>{planning ? `${planning}…` : 'nothing queued'}</Text>}
			{first > 0 ? <Text color={c.textFaint}>{`  … ${first} above`}</Text> : null}
			{shown.map((task) => {
				const [icon, key] = statusMark(task.status, icons);
				const color = c[key];
				const isSel = task.id === selected;
				return (
					<Text key={task.id} wrap="truncate-end">
						<Text color={isSel ? c.accent : c.line}>{isSel ? '▌' : ' '}</Text>
						<Text color={color}>{task.status === 'running' && icons === 'glyph' ? spinner(t) : icon}</Text>
						<Text color={c.textDim}>{` ${task.id} `}</Text>
						<Text color={task.status === 'done' ? c.textDim : c.text} bold={isSel}>{task.title}</Text>
						{task.attempts > 1 && task.status !== 'done' ? <Text color={c.warn}>{` ×${task.attempts}`}</Text> : null}
					</Text>
				);
			})}
			{sorted.length > first + shown.length ? <Text color={c.textFaint}>{`  … ${sorted.length - first - shown.length} more`}</Text> : null}
		</Box>
	);
}

/**
 * Running agents in `height` rows: two rows each (route, then what it is doing) when they
 * fit, one row each when not, and a count for the rest.
 */
export function Workers({ workers, t, height }: { workers: WorkerView[]; t: number; height: number }) {
	const room = Math.max(1, height - 1);
	const roomy = workers.length * 2 <= room;
	const fit = roomy ? workers.length : workers.length <= room ? workers.length : Math.max(0, room - 1);
	return (
		<Box flexDirection="column" flexGrow={1}>
			<Label text="agents" right={workers.length ? `${workers.length} running` : undefined} />
			{workers.length ? null : <Text color={c.textFaint}>idle</Text>}
			{workers.slice(0, fit).map((w) => {
				const routeModel = w.route.includes(':') ? w.route.slice(w.route.indexOf(':') + 1) : undefined;
				const drifted = w.model && routeModel && !sameModel(w.model, routeModel);
				const doing = w.phase === 'verifying' ? 'verifying' : w.last;
				const reviewing = w.phase === 'reviewing';
				// Planning stages have no task id: a brainstormer shows its angle and round.
				const label = w.task.startsWith('ideas:') ? w.title : reviewing ? `review ${w.task}` : w.task;
				// An agent that has said nothing for a while says so; past two minutes it may be stuck.
				const quiet = Date.now() - (w.lastAt ?? w.started);
				return (
					<Box key={w.key} flexDirection="column">
						<Text wrap="truncate-end">
							<Text color={w.phase === 'verifying' ? c.accentLift : c.accent}>{w.phase === 'verifying' ? '◎' : spinner(t)}</Text>
							<Text color={c.textDim}>{` ${roleOf(w.key)}`}</Text>
							<Text color={c.textBright}>{` ${label} `}</Text>
							<Text color={c.accentDeep}>{w.route}</Text>
							{drifted ? <Text color={c.warming}>{` ⇅ ${w.model}`}</Text> : null}
							{quiet > 30_000 ? <Text color={quiet > 120_000 ? c.warn : c.textFaint}>{`  quiet ${elapsed(quiet)}`}</Text> : null}
							{roomy ? <Text color={c.textDim}>{`  ${elapsed(Date.now() - w.started)} · ${w.tools} tools${w.cost ? ` · $${w.cost.toFixed(2)}` : ''}`}</Text> : <Text color={c.textFaint}>{`  ${doing}`}</Text>}
						</Text>
						{roomy ? <Text color={c.textFaint} wrap="truncate-end">{`  └ ${doing}`}</Text> : null}
					</Box>
				);
			})}
			{fit < workers.length ? <Text color={c.textFaint}>{`  … ${workers.length - fit} more`}</Text> : null}
		</Box>
	);
}

/** One stored task, as `jarvis-code task show` prints it: reason, ACs, dependencies, attempts, lessons. */
export function TaskDetail({ task, height }: { task: StoredTask; height: number }) {
	const total = task.attempts.reduce((s, a) => s + (a.costUsd ?? 0), 0);
	const lines: { key: string; el: ReactElement }[] = [];
	const push = (el: ReactElement) => lines.push({ key: String(lines.length), el });
	push(
		<Text wrap="truncate-end">
			<Text color={c.text}>{task.title}</Text>
			<Text color={c.textDim}>{` (${task.type} ${task.tier})`}</Text>
		</Text>,
	);
	if (task.reason) push(<Text color={c.warn} wrap="truncate-end">{task.reason}</Text>);
	task.acs.forEach((a, i) =>
		push(
			<Text wrap="truncate-end">
				<Text color={a.checked ? c.ok : c.textFaint}>{a.checked ? '✓ ' : '○ '}</Text>
				<Text color={c.text}>{`AC${i + 1} ${a.text}`}</Text>
				{a.verify ? <Text color={c.textDim}>{`  $ ${a.verify}`}</Text> : null}
			</Text>,
		),
	);
	if (task.depends.length) push(<Text color={c.textDim} wrap="truncate-end">{`after ${task.depends.join(', ')}`}</Text>);
	const shown = task.attempts.slice(-3);
	if (task.attempts.length > shown.length) push(<Text color={c.textFaint} wrap="truncate-end">{`${task.attempts.length - shown.length} earlier attempts`}</Text>);
	for (const a of shown) {
		push(
			<Text wrap="truncate-end">
				<Text color={a.ok ? c.ok : c.danger}>{a.ok ? '● ' : '✕ '}</Text>
				<Text color={c.text}>{`${a.at.slice(0, 16).replace('T', ' ')} ${a.route}`}</Text>
				{a.costUsd ? <Text color={c.textDim}>{` $${a.costUsd.toFixed(2)}`}</Text> : null}
				{a.cause ? <Text color={c.warn}>{` [${a.cause}]`}</Text> : null}
				{a.error ? <Text color={c.danger}>{`: ${a.error}`}</Text> : a.summary ? <Text color={c.textDim}>{`: ${a.summary}`}</Text> : null}
			</Text>,
		);
		if (a.preflight)
			push(
				<Text wrap="truncate-end">
					<Text color={c.textDim}>{`  preflight ${a.preflight.pass} pass · ${a.preflight.fail} fail`}</Text>
					{a.preflight.pass > 0 ? (
						<Text color={c.warn}>{` · ${a.preflight.pass} check(s) passed before any change: may not prove the work`}</Text>
					) : null}
				</Text>,
			);
	}
	if (task.hint) push(<Text wrap="truncate-end"><Text color={c.textDim}>hint: </Text><Text color={c.text}>{task.hint}</Text></Text>);
	for (const l of task.lessons) push(<Text color={c.accent} wrap="truncate-end">{l}</Text>);
	const room = Math.max(1, height - 1);
	const fit = lines.length <= room ? lines.length : room - 1;
	return (
		<Box flexDirection="column" flexGrow={1}>
			<Label text={`task ${task.id}`} right={`${task.status} · $${total.toFixed(2)}`} />
			{lines.slice(0, fit).map((l) => (
				<Box key={l.key}>{l.el}</Box>
			))}
			{fit < lines.length ? <Text color={c.textFaint}>{`  … ${lines.length - fit} more`}</Text> : null}
		</Box>
	);
}

export function Learning({ learning, height }: { learning: LearningStore; height: number }) {
	const { routes, tools } = learning.data;
	const rows = [
		...Object.entries(routes).map(([k, st]) => ({ k, st, off: learning.isOff(st) })),
		...Object.entries(tools).map(([k, st]) => ({ k: k.replace('|', ' › '), st, off: learning.isOff(st) })),
	].sort((a, b) => Number(b.off) - Number(a.off) || b.st.runs - a.st.runs);
	const room = Math.max(1, height - 1);
	const fit = rows.length <= room ? rows.length : room - 1;
	return (
		<Box flexDirection="column" flexGrow={1}>
			<Label text="learned" right="/learned to close" />
			{rows.length ? null : <Text color={c.textFaint}>nothing yet: routes and tools are scored as runs finish</Text>}
			{rows.slice(0, fit).map(({ k, st, off }) => (
				<Text key={k} wrap="truncate-end">
					<Text color={off ? c.danger : c.ok}>{off ? '✕ ' : '● '}</Text>
					<Text color={c.text}>{k}</Text>
					<Text color={c.textDim}>{`  ${st.ok}/${st.runs} ok${off ? `  off: ${st.reason}` : ''}`}</Text>
				</Text>
			))}
			{fit < rows.length ? <Text color={c.textFaint}>{`  … ${rows.length - fit} more: jarvis-code learn`}</Text> : null}
		</Box>
	);
}

export function Reports({ reports, height }: { reports: ReturnType<Project['reports']>; height: number }) {
	const room = Math.max(1, height - 1);
	const fit = reports.length <= room ? reports.length : room - 1;
	return (
		<Box flexDirection="column" flexGrow={1}>
			<Label text="reports" right="/reports to close" />
			{reports.length ? null : <Text color={c.textDim}>no reports yet: a run writes one as it goes, /report writes one now</Text>}
			{reports.slice(0, fit).map((r) => (
				<Text key={r.file} wrap="truncate-end">
					<Text color={c.textFaint}>{r.at.slice(0, 16).replace('T', ' ')}</Text>
					<Text color={c.text}>{`  ${r.summary.replace(/^\S+ · /, '')}`}</Text>
					<Text color={c.textFaint}>{`  ${basename(r.file)}`}</Text>
				</Text>
			))}
			{fit < reports.length ? <Text color={c.textFaint}>{`  … ${reports.length - fit} more`}</Text> : null}
		</Box>
	);
}

/** The newest `height` lines, or, `back` lines up, older ones (0 follows the run live). */
export function Feed({ activity, v, height, back = 0 }: { activity: Activity[]; v: View; height: number; back?: number }) {
	const want = height + back;
	const lines: { key: string; el: ReactElement }[] = [];
	for (let i = activity.length - 1; i >= 0 && lines.length < want; i--) {
		const a = activity[i];
		if (!visible(a, v)) continue;
		const [icon, key] = kindMark(a.kind, v.icons);
		const color = c[key];
		const detail =
			a.kind === 'change' && a.detail
				? a.detail.split('\n').slice(0, 6).map((l, j) => (
						<Text key={j} color={l.startsWith('+') ? c.ok : l.startsWith('-') ? c.danger : c.textFaint} wrap="truncate-end">
							{'           ' + l}
						</Text>
					))
				: [];
		for (let j = detail.length - 1; j >= 0 && lines.length < want; j--) lines.push({ key: `${i}.${j}`, el: detail[j] });
		if (lines.length >= want) break;
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
	// Past the oldest line, show the oldest page rather than an empty one.
	const skip = Math.min(back, Math.max(0, lines.length - height));
	const page = lines.slice(skip, skip + height);
	const shows = [v.showDiffs && 'diffs', v.showTools && 'tools', v.showText && 'messages'].filter(Boolean).join(' · ') || 'completions';
	return (
		<Box flexDirection="column" flexGrow={1}>
			<Label text="activity" right={skip ? `${skip} lines back · End for live` : shows} />
			{page.length ? null : <Text color={c.textFaint}>waiting for the first event</Text>}
			{page.reverse().map((l) => (
				<Box key={l.key}>{l.el}</Box>
			))}
		</Box>
	);
}
