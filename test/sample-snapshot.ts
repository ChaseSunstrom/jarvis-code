import type { AgentNode, NodeRole, Snapshot, TaskView } from '../src/orchestrator.js';

/** A run mid-flight: a node of every role, 5 tasks with depends (T-0004 has two), and a done item in each state. */
export function sampleSnapshot(): Snapshot {
	const now = Date.now();
	const node = (id: string, role: NodeRole, label: string, state: AgentNode['state'], extra: Partial<AgentNode> = {}): AgentNode => ({
		id,
		role,
		label,
		route: 'claude:claude-fable-5-1',
		state,
		started: now - 90_000,
		...(state === 'running' ? {} : { ended: now - 30_000 }),
		cost: 0.12,
		last: 'done',
		lastAt: now - 30_000,
		...extra,
	});
	const tasks: TaskView[] = [
		{ id: 'T-0001', title: 'Add the settings schema', type: 'FEATURE', tier: 'S', status: 'done', attempts: 1, route: 'claude:claude-fable-5-1' },
		{ id: 'T-0002', title: 'Load settings from disk', type: 'FEATURE', tier: 'S', status: 'running', attempts: 1, route: 'codex:gpt-5', depends: ['T-0001'] },
		{ id: 'T-0003', title: 'Validate settings on save', type: 'FEATURE', tier: 'M', status: 'failed', attempts: 2, depends: ['T-0001'] },
		{ id: 'T-0004', title: 'Migrate old settings files', type: 'FEATURE', tier: 'M', status: 'queued', attempts: 0, depends: ['T-0002', 'T-0003'] },
		{ id: 'T-0005', title: 'Document the settings', type: 'CLEAN', tier: 'S', status: 'queued', attempts: 0, depends: ['T-0004'] },
	];
	return {
		phase: 'working',
		paused: false,
		goal: 'Modernize the settings system',
		source: 'store',
		tasks,
		workers: [],
		nodes: [
			node('prompt#1', 'promptWriter', 'planning prompt', 'done'),
			node('idea:risk#2', 'brainstorm', 'risk · round 1', 'done'),
			node('idea:users#3', 'brainstorm', 'users · round 1', 'failed'),
			node('critic#4', 'critic', 'critique · 2 ideas', 'done'),
			node('planner#5', 'planner', 'Modernize the settings system', 'done'),
			node('T-0001#6', 'worker', 'Add the settings schema', 'done', { task: 'T-0001' }),
			node('review:T-0001#7', 'reviewer', 'Add the settings schema', 'done', { task: 'T-0001', route: 'codex:gpt-5' }),
			node('T-0002#8', 'worker', 'Load settings from disk', 'running', { task: 'T-0002', route: 'codex:gpt-5' }),
			node('T-0003#9', 'worker', 'Validate settings on save', 'failed', { task: 'T-0003' }),
			node('coverage#10', 'coverage', 'coverage', 'running'),
		],
		activity: [],
		cost: 1.2,
		planning: 0.6,
		started: now - 300_000,
		reactor: 'thinking',
		stateSince: now - 5_000,
		prevReactor: 'idle',
		routes: [],
		clauses: [
			{ text: 'settings load from disk', state: 'met', tasks: ['T-0001', 'T-0002'] },
			{ text: 'old settings files still load', state: 'unmet', tasks: ['T-0003'] },
			{ text: 'the settings are documented', state: 'open', tasks: [] },
		],
	};
}
