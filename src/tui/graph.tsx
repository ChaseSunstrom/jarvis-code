import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { NodeRole, Snapshot, TaskView } from '../orchestrator.js';
import { c } from '../theme.js';
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
	return (
		<Pane
			title="graph"
			right={`${nodes.length} agent run${nodes.length === 1 ? '' : 's'} · Esc to close`}
			empty={`${snap.goal ?? 'this run'}: no agent has run yet`}
			height={height}
			rows={lines.map((l) => {
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
			})}
		/>
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
