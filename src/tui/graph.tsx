import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { AgentNode, NodeRole, Snapshot, TaskView } from '../orchestrator.js';
import { byTreeId, type Idea } from '../pipeline.js';
import { c } from '../theme.js';
import { bar } from './charts.js';
import { Label } from './parts.js';
import { clauseMark, elapsed, statusMark, type View } from './style.js';
import { treeLines, type TreeItem } from './tree.js';

/** The stage each role's runs sit under, in pipeline order. */
const STAGE: Record<NodeRole, string> = {
	promptWriter: 'prompt writer', brainstorm: 'brainstorm', critic: 'critique', planner: 'planner',
	worker: 'tasks', reviewer: 'tasks', coverage: 'coverage',
};
const STAGES = [...new Set(Object.values(STAGE))];

interface Row { tag?: ReturnType<typeof statusMark>; text: string; route?: string; meta?: string }

/** A titled pane of rows in `height` rows, with a count for what does not fit. */
function Pane({ title, right, empty, rows, height }: { title: string; right: string; empty: string; rows: ReactElement[]; height: number }) {
	const room = Math.max(1, height - 1);
	const fit = rows.length <= room ? rows.length : room - 1;
	return (
		<Box flexDirection="column" flexGrow={1}>
			<Label text={title} right={right} />
			{rows.length ? null : <Text color={c.textFaint}>{empty}</Text>}
			{rows.slice(0, fit)}
			{fit < rows.length ? <Text color={c.textFaint}>{`  … ${rows.length - fit} more`}</Text> : null}
		</Box>
	);
}

/**
 * Each pipeline stage in order with its state: `wait` (no run yet), `run` (one is running), `done`
 * (none running, one or more finished well) or `fail` (every run failed), and its run count.
 */
export function flow(nodes: AgentNode[]): { stage: string; state: 'wait' | 'run' | 'done' | 'fail'; runs: number }[] {
	return STAGES.map((stage) => {
		const here = nodes.filter((n) => STAGE[n.role] === stage);
		const state = !here.length ? 'wait' : here.some((n) => n.state === 'running') ? 'run' : here.some((n) => n.state === 'done') ? 'done' : 'fail';
		return { stage, state, runs: here.length };
	});
}

const FLOW_MARK = { wait: ['○', 'textFaint'], run: ['◉', 'accent'], done: ['●', 'ok'], fail: ['✕', 'danger'] } as const;

/** The run's pipeline: goal → its done items, then the stages that ran → their agent runs; a task's worker and reviewer runs sit under it. */
export function Graph({ snap, height, icons = 'text' }: { snap: Snapshot; height: number; icons?: View['icons'] }) {
	const nodes = snap.nodes;
	const items: TreeItem[] = [];
	const rows = new Map<string, Row>();
	const add = (id: string, parent: string | undefined, row: Row) => {
		items.push({ id, parents: parent ? [parent] : [], text: row.text });
		rows.set(id, row);
	};
	add('goal', undefined, { text: snap.goal ?? 'working the queue' });
	// The checklist the run is held to, with the tasks that cover each item.
	snap.clauses?.forEach((cl, i) => add(`clause:${i}`, 'goal', { tag: clauseMark(cl.state), text: cl.text, meta: cl.tasks.join(', ') || undefined }));
	for (const stage of STAGES) {
		const here = nodes.filter((n) => STAGE[n.role] === stage);
		if (!here.length) continue;
		const cost = here.reduce((s, n) => s + n.cost, 0);
		add(`stage:${stage}`, 'goal', { text: stage, meta: `${here.length} run${here.length === 1 ? '' : 's'} · $${cost.toFixed(2)}` });
		here.forEach((n, i) => {
			let parent = `stage:${stage}`;
			if (stage === 'tasks' && n.task) {
				parent = `task:${n.task}`;
				const t = snap.tasks.find((x) => x.id === n.task);
				if (!rows.has(parent)) add(parent, `stage:${stage}`, { tag: t && statusMark(t.status, icons), text: `${n.task} ${t?.title ?? ''}`.trim(), route: t?.route });
			}
			// Under a task the label is its title again: the role says which run it is.
			add(`node:${stage}:${i}`, parent, {
				tag: statusMark(n.state, icons),
				text: parent.startsWith('task:') ? n.role : n.label,
				route: n.route,
				meta: `${elapsed((n.ended ?? Date.now()) - n.started)} · $${n.cost.toFixed(2)}`,
			});
		});
	}
	const lines = nodes.length ? treeLines(items) : [];
	// The pipeline at a glance, before its tree: each stage's state and how many agents ran in it.
	const strip = (
		<Text key="flow" wrap="truncate-end">
			{flow(nodes).map((f, i) => (
				<Text key={f.stage}>
					{i ? <Text color={c.tick}>{' ▸ '}</Text> : null}
					<Text color={c[FLOW_MARK[f.state][1]]}>{`${FLOW_MARK[f.state][0]} `}</Text>
					<Text color={f.state === 'wait' ? c.textFaint : c.text}>{f.stage}</Text>
					{f.runs ? <Text color={c.textDim}>{` ${f.runs}`}</Text> : null}
				</Text>
			))}
		</Text>
	);
	return (
		<Pane
			title="graph"
			right={`${nodes.length} agent run${nodes.length === 1 ? '' : 's'} · Esc to close`}
			empty={`${snap.goal ?? 'this run'}: no agent has run yet`}
			height={height}
			rows={lines.length === 0 ? [] : [strip, ...lines.map((l) => {
				const row = rows.get(l.id)!;
				return (
					<Text key={l.id} wrap="truncate-end">
						<Text color={c.tick}>{l.prefix}</Text>
						{row.tag ? <Text color={c[row.tag[1]]}>{`${row.tag[0]} `}</Text> : null}
						<Text color={l.id === 'goal' ? c.textBright : row.tag ? c.text : c.accentLift}>{l.text}</Text>
						{row.route ? <Text color={c.accentDeep}>{`  ${row.route}`}</Text> : null}
						{row.meta ? <Text color={c.textDim}>{`  ${row.meta}`}</Text> : null}
					</Text>
				);
			})]}
		/>
	);
}

/** Each role's colour on the timeline, in pipeline order (the legend's order too). */
const ROLE_TONE: Record<NodeRole, keyof typeof c> = {
	promptWriter: 'accentLift', brainstorm: 'accent', critic: 'warming', planner: 'accentDeep', worker: 'ok', reviewer: 'warn', coverage: 'textBright',
};
const ROLE_NAME: Record<NodeRole, string> = {
	promptWriter: 'prompt writer', brainstorm: 'brainstorm', critic: 'critic', planner: 'planner', worker: 'worker', reviewer: 'reviewer', coverage: 'coverage',
};

export interface Lane { id: string; label: string; role: NodeRole; state: AgentNode['state']; from: number; to: number; node: AgentNode }

/**
 * One row per agent run on an axis `width` cells wide from `start` to `now`: cells [from, to), at
 * least one. A task's runs (attempts, review, re-plan) sit together where the task first ran; the
 * rest keep their start order. Pure, O(n log n).
 */
export function lanes(nodes: AgentNode[], start: number, now: number, width: number): Lane[] {
	const span = Math.max(1, now - start);
	const cell = (t: number) => ((t - start) / span) * width;
	const first = new Map<string, number>();
	nodes.forEach((n, i) => {
		const key = n.task ?? n.id;
		if (!first.has(key)) first.set(key, i);
	});
	const order = nodes.map((n, i) => ({ n, i, group: first.get(n.task ?? n.id)! })).sort((a, b) => a.group - b.group || a.i - b.i);
	// A task's second worker run is its retry: numbered, so the rows tell apart.
	const seen = new Map<string, number>();
	return order.map(({ n }) => {
		const again = n.task ? (seen.get(`${n.task}:${n.role}`) ?? 0) + 1 : 1;
		if (n.task) seen.set(`${n.task}:${n.role}`, again);
		const from = Math.max(0, Math.min(width - 1, Math.floor(cell(n.started))));
		const to = Math.max(from + 1, Math.min(width, Math.ceil(cell(n.ended ?? now))));
		// A brainstormer's and the critic's labels say which angle or batch; the other stages are their role.
		// The round goes first so a long angle's truncation never hides it.
		const label = n.task ? `${n.task} ${ROLE_NAME[n.role]}${again > 1 ? ` ${again}` : ''}` : n.role === 'brainstorm' ? n.label.replace(/^(.*) · (round|level) (\d+)$/, (_, what: string, kind: string, k: string) => `${kind === 'round' ? 'r' : 'L'}${k} ${what}`) : n.role === 'critic' ? n.label : ROLE_NAME[n.role];
		return { id: n.id, label, role: n.role, state: n.state, from, to, node: n };
	});
}

const LABEL = 22;
const META = 14;

/** `0s`, the midpoint and the total, spread over `width` cells. */
function axis(span: number, width: number): string {
	const left = '0s';
	const mid = elapsed(span / 2);
	const right = elapsed(span);
	const at = Math.max(left.length + 1, Math.floor(width / 2 - mid.length / 2));
	const head = `${left.padEnd(at)}${mid}`;
	return width - head.length > right.length ? `${head}${right.padStart(width - head.length)}` : `${left}${right.padStart(Math.max(1, width - left.length))}`;
}

/** Every agent run as a bar on the run's time axis, newest rows kept in view, with a legend and an axis row. */
export function Timeline({ snap, height, width, now = Date.now() }: { snap: Snapshot; height: number; width: number; now?: number }) {
	const start = Math.min(snap.started, ...snap.nodes.map((n) => n.started));
	const chart = Math.max(10, width - LABEL - META - 2);
	const rows = lanes(snap.nodes, start, now, chart);
	const room = Math.max(1, height - 3);
	const clipped = rows.length > room;
	const shown = clipped ? rows.slice(rows.length - (room - 1)) : rows;
	const roles = (Object.keys(ROLE_NAME) as NodeRole[]).filter((r) => snap.nodes.some((n) => n.role === r));
	return (
		<Box flexDirection="column" flexGrow={1}>
			<Label text="timeline" right={`${snap.nodes.length} agent run${snap.nodes.length === 1 ? '' : 's'} · Esc to close`} />
			{rows.length ? (
				<Text wrap="truncate-end">
					{roles.map((r) => (
						<Text key={r}>
							<Text color={c[ROLE_TONE[r]]}>█ </Text>
							<Text color={c.textDim}>{`${ROLE_NAME[r]}  `}</Text>
						</Text>
					))}
					<Text color={c.danger}>█ </Text>
					<Text color={c.textDim}>failed</Text>
				</Text>
			) : (
				<Text color={c.textFaint}>{`${snap.goal ?? 'this run'}: no agent has run yet`}</Text>
			)}
			{clipped ? <Text color={c.textFaint}>{`  … ${rows.length - shown.length} earlier`}</Text> : null}
			{shown.map((l) => {
				const n = l.node;
				const name = l.label.length > LABEL - 1 ? `${l.label.slice(0, LABEL - 2)}…` : l.label;
				return (
					<Text key={l.id} wrap="truncate-end">
						<Text color={l.state === 'running' ? c.textBright : c.text}>{name.padEnd(LABEL)}</Text>
						<Text color={c.line}>{'─'.repeat(l.from)}</Text>
						<Text color={l.state === 'failed' ? c.danger : c[ROLE_TONE[l.role]]}>{'█'.repeat(l.to - l.from)}</Text>
						<Text color={c.line}>{'─'.repeat(chart - l.to)}</Text>
						<Text color={c.textDim}>{`  ${elapsed((n.ended ?? now) - n.started)} · $${n.cost.toFixed(2)}`}</Text>
					</Text>
				);
			})}
			{rows.length ? <Text color={c.textFaint}>{`${' '.repeat(LABEL)}${axis(now - start, chart)}`}</Text> : null}
		</Box>
	);
}

/** A flat brainstorm's ideas under their lens, as a two-level tree; a tree brainstorm as it is, in tree order. */
function ideaItems(ideas: Idea[]): { items: TreeItem[]; by: Map<string, Idea> } {
	const by = new Map<string, Idea>();
	const items: TreeItem[] = [];
	if (ideas.every((i) => i.id)) {
		for (const i of [...ideas].sort(byTreeId)) {
			by.set(i.id!, i);
			items.push({ id: i.id!, parents: i.parent ? [i.parent] : [], text: i.title });
		}
		return { items, by };
	}
	for (const lens of new Set(ideas.map((i) => i.lens ?? 'ideas'))) {
		by.set(`lens:${lens}`, { title: lens, depth: 1 });
		items.push({ id: `lens:${lens}`, parents: [], text: lens });
	}
	ideas.forEach((i, n) => {
		by.set(`idea:${n}`, i);
		items.push({ id: `idea:${n}`, parents: [`lens:${i.lens ?? 'ideas'}`], text: i.title });
	});
	return { items, by };
}

/**
 * The run's brainstorm as a tree: categories (or lenses) and the ideas grown under them, each with
 * its effort, a bar for its value (the critic's once it scored, else its proposer's) and the
 * critic's value/effort/risk. `top` is the first row shown (PgUp/PgDn move it).
 */
export function Ideas({ ideas = [], height, top = 0 }: { ideas?: Idea[]; height: number; top?: number }) {
	const { items, by } = ideaItems(ideas);
	const lines = treeLines(items);
	const room = Math.max(1, height - 1);
	const from = Math.max(0, Math.min(top, lines.length - room));
	const shown = lines.slice(from, from + room);
	const groups = items.filter((i) => !i.parents.length).length;
	const count = ideas.filter((i) => i.depth !== 1).length;
	return (
		<Box flexDirection="column" flexGrow={1}>
			<Label
				text="ideas"
				right={`${count} idea${count === 1 ? '' : 's'} · ${groups} ${ideas.some((i) => i.id) ? 'categor' + (groups === 1 ? 'y' : 'ies') : 'angle' + (groups === 1 ? '' : 's')}${lines.length > room ? ` · ${from + 1}–${from + shown.length} of ${lines.length} · PgUp/PgDn` : ''} · Esc to close`}
			/>
			{lines.length ? null : <Text color={c.textFaint}>no brainstorm in this run yet: open goals are brainstormed before planning</Text>}
			{shown.map((l) => {
				const i = by.get(l.id)!;
				const heading = i.depth === 1;
				const v = i.critique?.value ?? i.value;
				return (
					<Text key={l.id} wrap="truncate-end">
						{/* Value bars first, in one column like a chart; a category is a heading and has none. */}
						<Text color={i.score !== undefined && i.score >= 5 ? c.ok : c.accent}>{`${heading ? '' : bar(v ?? 0, 5, 5)}`.padEnd(5) + ' '}</Text>
						<Text color={c.tick}>{l.prefix}</Text>
						<Text color={heading ? c.accentLift : c.text} bold={heading}>{l.text}</Text>
						{i.effort ? <Text color={c.textDim}>{`  ${i.effort}`}</Text> : null}
						{i.critique ? <Text color={c.textDim}>{`  v${i.critique.value} e${i.critique.effort} r${i.critique.risk}`}</Text> : null}
						{i.merged ? <Text color={c.textFaint}>{`  +${i.merged}`}</Text> : null}
					</Text>
				);
			})}
		</Box>
	);
}

/** The run's tasks laid out by their depends: a task with several sits under the first, with a → row under the rest. */
export function DepTree({ tasks, height, icons = 'text' }: { tasks: TaskView[]; height: number; icons?: View['icons'] }) {
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const lines = treeLines(tasks.map((t) => ({ id: t.id, parents: t.depends ?? [], text: t.title })));
	return (
		<Pane
			title="tree"
			right={`${tasks.length} task${tasks.length === 1 ? '' : 's'} · Esc to close`}
			empty="no tasks yet"
			height={height}
			rows={lines.map((l, i) => {
				const t = byId.get(l.id)!;
				const [tag, tone] = statusMark(t.status, icons);
				return (
					<Text key={i} wrap="truncate-end">
						<Text color={c.tick}>{`${l.prefix}${l.ref ? '→ ' : ''}`}</Text>
						<Text color={c[tone]}>{`${tag} `}</Text>
						<Text color={c.textDim}>{`${t.id} `}</Text>
						<Text color={l.ref ? c.textDim : c.text}>{t.title}</Text>
						{t.route ? <Text color={c.accentDeep}>{`  ${t.route}`}</Text> : null}
						{l.cycle ? <Text color={c.warn}>{'  (cycle)'}</Text> : null}
					</Text>
				);
			})}
		/>
	);
}
