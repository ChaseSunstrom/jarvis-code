import { Box, Text } from 'ink';
import type { NodeRole, Snapshot, TaskStatus } from '../orchestrator.js';
import type { RunRecord } from '../store.js';
import { c } from '../theme.js';
import { bar, bins, sparkline } from './charts.js';
import { Label, Progress } from './parts.js';
import { elapsed } from './style.js';

const ROLES: [NodeRole, string][] = [
	['promptWriter', 'prompt writer'], ['brainstorm', 'brainstorm'], ['critic', 'critic'], ['planner', 'planner'],
	['worker', 'worker'], ['reviewer', 'reviewer'], ['coverage', 'coverage'],
];
const COUNTED: [TaskStatus[], string, string][] = [
	[['done'], 'done', c.ok], [['running', 'verifying'], 'running', c.accent], [['blocked', 'review'], 'need you', c.warn],
	[['failed'], 'failed', c.danger], [['queued'], 'queued', c.textDim],
];

interface Bar { key: string; label: string; value: number; text: string; tone: string }

/** Labelled bars against the largest value, `width` columns in all. */
function Bars({ rows, width }: { rows: Bar[]; width: number }) {
	const max = Math.max(0, ...rows.map((r) => r.value));
	const labelW = Math.min(16, Math.max(6, ...rows.map((r) => r.label.length + 1)));
	const textW = Math.max(0, ...rows.map((r) => r.text.length));
	// Bars take what the labels and numbers leave; past too narrow a pane the row truncates at its end.
	const barW = Math.max(8, width - labelW - textW - 2);
	return (
		<>
			{rows.map((r) => (
				<Text key={r.key} wrap="truncate-end">
					<Text color={c.text}>{(r.label.length >= labelW ? `${r.label.slice(0, labelW - 2)}…` : r.label).padEnd(labelW)}</Text>
					<Text color={r.tone}>{bar(r.value, max, barW).padEnd(barW)}</Text>
					<Text color={c.textDim}>{`  ${r.text}`}</Text>
				</Text>
			))}
		</>
	);
}

/**
 * A project's finished runs, newest first: sparklines of cost and of the share of tasks done
 * across runs (oldest to newest), then a row per run with its tasks as a bar. Read by the
 * command that opens it, never in render.
 */
export function History({ runs, height, width }: { runs: RunRecord[]; height: number; width: number }) {
	const old = [...runs].reverse();
	const spark = Math.max(8, Math.min(60, width - 30));
	const cost = runs.reduce((s, r) => s + r.cost, 0);
	const tasks = runs.reduce((s, r) => s + r.total, 0);
	const done = runs.reduce((s, r) => s + r.done, 0);
	const room = Math.max(0, height - 3);
	return (
		<Box flexDirection="column" flexGrow={1}>
			<Label text="history" right={`${runs.length} run${runs.length === 1 ? '' : 's'} · /history to close`} />
			{runs.length ? (
				<>
					<Text wrap="truncate-end">
						<Text color={c.textDim}>{'cost    '}</Text>
						<Text color={c.warming}>{sparkline(old.map((r) => r.cost), spark)}</Text>
						<Text color={c.textDim}>{`  $${cost.toFixed(2)} in all`}</Text>
					</Text>
					<Text wrap="truncate-end">
						<Text color={c.textDim}>{'success '}</Text>
						<Text color={c.ok}>{sparkline(old.map((r) => (r.total ? r.done / r.total : 0)), spark, 1)}</Text>
						<Text color={c.textDim}>{`  ${tasks ? Math.round((done / tasks) * 100) : 0}% of ${tasks} tasks done`}</Text>
					</Text>
				</>
			) : (
				<Text color={c.textFaint}>no finished runs here yet: each run leaves a line when it ends</Text>
			)}
			{runs.slice(0, room).map((r) => (
				<Text key={r.at} wrap="truncate-end">
					<Text color={c.textFaint}>{`${r.at.slice(5, 16).replace('T', ' ')}  `}</Text>
					<Text color={r.blocked + r.review ? c.warn : c.textBright}>{`${r.done}/${r.total}`.padStart(5)}</Text>
					<Text color={c.ok}>{` ${bar(r.done, Math.max(1, r.total), 6).padEnd(6)}`}</Text>
					<Text color={c.textDim}>{`  $${r.cost.toFixed(2).padStart(6)}  ${`${r.minutes}m`.padStart(6)}  `}</Text>
					{r.stopped ? <Text color={c.danger}>stopped </Text> : null}
					<Text color={c.text}>{r.goal ?? 'the open queue'}</Text>
				</Text>
			))}
		</Box>
	);
}

/**
 * The run as charts: tasks by status, agent runs and their cost by role and by route, learned route
 * scores, and sparklines of runs finished and money spent over the run. Everything is from the
 * snapshot, so it costs a pass over at most a few hundred nodes per frame.
 */
export function Stats({ snap, height, width, now = Date.now() }: { snap: Snapshot; height: number; width: number; now?: number }) {
	// The left column carries the longer rows (roles with their runs and failures).
	const col = Math.max(24, Math.floor(width * 0.58));
	const rightCol = Math.max(24, width - col);
	const nodes = snap.nodes;
	const counts = COUNTED.map(([statuses, name, tone]) => ({ name, tone, n: snap.tasks.filter((t) => statuses.includes(t.status)).length })).filter((x) => x.n);
	const byRole: Bar[] = ROLES.map(([role, name]) => {
		const here = nodes.filter((n) => n.role === role);
		const failed = here.filter((n) => n.state === 'failed').length;
		const cost = here.reduce((s, n) => s + n.cost, 0);
		return { key: role, label: name, value: cost, text: `$${cost.toFixed(2)} · ${here.length} run${here.length === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`, tone: failed ? c.warn : c.accent, n: here.length };
	}).filter((r) => r.n);
	const routes = [...new Set(nodes.map((n) => n.route))];
	const byRoute: Bar[] = routes
		.map((route) => {
			const here = nodes.filter((n) => n.route === route);
			const cost = here.reduce((s, n) => s + n.cost, 0);
			return { key: route, label: route, value: cost, text: `$${cost.toFixed(2)} · ${here.length}`, tone: c.accentDeep };
		})
		.sort((a, b) => b.value - a.value);
	const scores: Bar[] = snap.routes
		.filter((r) => r.runs)
		.map((r) => ({ key: r.id, label: r.id, value: r.score, text: r.off ? `off · ${r.runs} runs` : `${Math.round(r.score * 100)}% · ${r.runs} runs`, tone: r.off ? c.danger : r.score >= 0.5 ? c.ok : c.warn }));
	// Sparklines over the whole run, one cell per slot.
	const start = Math.min(snap.started, ...nodes.map((n) => n.started));
	const spark = Math.max(8, col - 28);
	const ended = nodes.filter((n) => n.ended);
	const finished = bins(ended.map((n) => n.ended!), start, now, spark);
	const spent = bins(ended.map((n) => n.ended!), start, now, spark, ended.map((n) => n.cost));
	const retried = snap.tasks.filter((t) => t.attempts > 1).length;
	const left = (
		<Box flexDirection="column" width={col} paddingRight={2}>
			<Label text="tasks" right={`${snap.tasks.length}${retried ? ` · ${retried} retried` : ''}`} />
			<Progress tasks={snap.tasks} width={Math.max(8, col - 4)} />
			<Text wrap="truncate-end">
				{counts.length ? counts.map((x) => <Text key={x.name} color={x.tone}>{`${x.n} ${x.name}  `}</Text>) : <Text color={c.textFaint}>no tasks yet</Text>}
			</Text>
			<Label text="cost by role" right={`$${snap.cost.toFixed(2)}`} />
			{byRole.length ? <Bars rows={byRole} width={col - 2} /> : <Text color={c.textFaint}>no agent has run yet</Text>}
			<Label text="over the run" right={elapsed(now - start)} />
			<Text wrap="truncate-end">
				<Text color={c.textDim}>{'runs done'.padEnd(14)}</Text>
				<Text color={c.accent}>{sparkline(finished, spark)}</Text>
				<Text color={c.textDim}>{`  ${ended.length}`}</Text>
			</Text>
			<Text wrap="truncate-end">
				<Text color={c.textDim}>{'spend'.padEnd(14)}</Text>
				<Text color={c.warming}>{sparkline(spent, spark)}</Text>
				<Text color={c.textDim}>{`  $${spent.reduce((a, b) => a + b, 0).toFixed(2)}`}</Text>
			</Text>
		</Box>
	);
	const right = (
		<Box flexDirection="column" width={rightCol}>
			<Label text="cost by route" right={`${routes.length}`} />
			{byRoute.length ? <Bars rows={byRoute} width={rightCol} /> : <Text color={c.textFaint}>no agent has run yet</Text>}
			<Label text="route scores" right="learned" />
			{scores.length ? <Bars rows={scores} width={rightCol} /> : <Text color={c.textFaint} wrap="truncate-end">nothing learned yet: routes are scored as tasks finish</Text>}
		</Box>
	);
	return (
		<Box flexDirection="column" flexGrow={1} height={height} overflow="hidden">
			<Label text="stats" right="Esc to close" />
			<Box>
				{left}
				{right}
			</Box>
		</Box>
	);
}
