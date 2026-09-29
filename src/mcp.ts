import { realpathSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { runDetached } from './runs.js';
import { nextStep, Project, TYPES, type StoredTask } from './store.js';

/**
 * `jarvis-code mcp`: a Model Context Protocol server over stdio (newline-delimited JSON-RPC), so an
 * interactive Claude Code, Codex or OpenCode session can see jarvis-code's queue and hand it work.
 * The subset hosts use for tools: initialize, ping, tools/list and tools/call. Inside a jarvis-code
 * worker it offers nothing: jarvis-code owns the queue there.
 */

const dir = { dir: { type: 'string', description: "The project's directory (default: where the session runs)" } };
const tool = (name: string, description: string, readOnly: boolean, properties: Record<string, unknown> = {}, required: string[] = []) => ({
	name,
	description,
	inputSchema: { type: 'object', properties: { ...properties, ...dir }, ...(required.length && { required }) },
	annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
});

export const TOOLS = [
	tool('status', "jarvis-code's queue for this project: the run going, open tasks, and what is blocked or waiting for review with the step that unsticks it", true),
	tool('tasks', "This project's tasks, open ones first", true, { all: { type: 'boolean', description: 'include done and dropped tasks' } }),
	tool('task_show', "One task's detail: why it is where it is, its criteria and checks, attempts, hint and lessons", true, { id: { type: 'string', description: 'e.g. T-0012' } }, ['id']),
	tool('history', "This project's finished jarvis-code runs, newest first: tasks done, cost, length", true),
	tool('queue_goal', 'Hand jarvis-code a goal: it plans it into checked tasks and works them with the configured agents in the background, or queues it behind the run already going', false, { goal: { type: 'string', description: 'the goal, in plain words' } }, ['goal']),
	tool('add_task', "Add one task to this project's jarvis-code queue (the next run or `jarvis-code work` takes it)", false, { title: { type: 'string' }, type: { type: 'string', enum: TYPES } }, ['title']),
	tool('tell', "Give a task a note: its next attempt reads it (a live run's included)", false, { id: { type: 'string' }, note: { type: 'string' } }, ['id', 'note']),
];

type Args = Record<string, unknown>;
/** A string argument, trimmed and capped: what a session sends is stored and read back into prompts. */
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * The project a call acts on: the session's directory or one inside it, never above or beside it,
 * so a session cannot start runs or write tasks in projects it was not opened in.
 */
function within(cwd: string, dir: string): string {
	const real = (p: string) => {
		try {
			return realpathSync(p);
		} catch {
			return fail(`no directory ${dir}`);
		}
	};
	const root = real(cwd);
	const where = real(resolve(cwd, dir || '.'));
	if (where !== root && !where.startsWith(root + sep)) fail(`dir must be this project or a directory inside it (${basename(root)})`);
	return where;
}

const line = (t: StoredTask) => `${t.id} ${t.type} ${t.tier}  ${t.title}${t.reason ? `  (${t.reason})` : ''}`;

function status(p: Project): string {
	const tasks = p.tasks();
	const by = (s: string) => tasks.filter((t) => t.status === s);
	const run = p.running();
	const out = [`${p.meta.name}: ${[['planned', 'open'], ['active', 'running'], ['blocked', 'blocked'], ['review', 'to review'], ['deferred', 'deferred'], ['done', 'done']].map(([s, w]) => `${by(s).length} ${w}`).join(', ')}`];
	if (run) out.push(`a run is going (pid ${run.pid}, since ${run.started.slice(0, 16).replace('T', ' ')}${run.goal ? `): ${run.goal}` : ')'}`);
	for (const t of [...by('blocked'), ...by('review')]) out.push(`- ${line(t)}${nextStep(t) ? `\n  next: ${nextStep(t)}` : ''}`);
	for (const t of p.queue().slice(0, 20)) out.push(`- ${line(t)}`);
	const goals = p.goals();
	if (goals.length) out.push(`queued goals: ${goals.map((g, i) => `${i + 1}. ${g.goal}`).join(' · ')}`);
	return out.join('\n');
}

function show(t: StoredTask): string {
	const out = [`${t.id} ${t.title} (${t.type} ${t.tier}, ${t.status})`];
	if (t.reason) out.push(`why: ${t.reason}`);
	if (nextStep(t)) out.push(`next: ${nextStep(t)}`);
	t.acs.forEach((a, i) => out.push(`${a.checked ? '[x]' : '[ ]'} AC${i + 1} ${a.text}${a.verify ? `  $ ${a.verify}` : ''}`));
	if (t.depends.length) out.push(`after ${t.depends.join(', ')}`);
	for (const a of t.attempts.slice(-3)) out.push(`${a.ok ? 'ok  ' : 'fail'} ${a.at.slice(0, 16).replace('T', ' ')} ${a.route}${a.costUsd ? ` $${a.costUsd.toFixed(2)}` : ''}${a.error ? `: ${a.error}` : a.summary ? `: ${a.summary}` : ''}`);
	if (t.hint) out.push(`hint: ${t.hint}`);
	for (const l of t.lessons) out.push(`lesson: ${l}`);
	return out.join('\n');
}

/** One tool call; throws with a message the caller sees as the tool's error. */
async function call(name: string, args: Args, cwd: string): Promise<string> {
	const where = within(cwd, str(args.dir, 4096));
	const open = () => Project.open(where) ?? fail(`${basename(where)} has no jarvis-code tasks yet: queue_goal plans some`);
	switch (name) {
		case 'status':
			return status(open());
		case 'tasks': {
			const p = open();
			const queue = p.queue();
			const rest = p.tasks().filter((t) => !queue.some((q) => q.id === t.id) && (args.all === true || !['done', 'dropped'].includes(t.status)));
			return [...queue, ...rest].map(line).join('\n') || 'no open tasks';
		}
		case 'task_show': {
			const id = str(args.id).toUpperCase();
			const t = open().get(id);
			return t ? show(t) : fail(`no task ${id} in ${basename(where)}`);
		}
		case 'history': {
			const runs = open().history().slice(0, 20);
			return runs.map((r) => `${r.at.slice(0, 16).replace('T', ' ')}  ${r.done}/${r.total} done  $${r.cost.toFixed(2)}  ${r.minutes}m${r.stopped ? '  stopped' : ''}  ${r.goal ?? 'the open queue'}`).join('\n') || 'no finished runs yet';
		}
		case 'queue_goal': {
			const goal = str(args.goal, 2000);
			if (!goal) fail('queue_goal needs a goal');
			// It becomes one argument of a jarvis-code command line, where a leading dash would read as an option.
			if (goal.startsWith('-')) fail('a goal cannot start with "-"');
			const p = new Project(where);
			const held = p.running();
			if (held) return `queued #${p.enqueue(goal)} in ${p.meta.name}: runs after the current run (pid ${held.pid})`;
			const { pid, log } = await runDetached(where, [goal]);
			return `jarvis-code is planning and working it in the background in ${p.meta.name} (pid ${pid}); status shows progress, log ${log}`;
		}
		case 'add_task': {
			const title = str(args.title);
			if (!title) fail('add_task needs a title');
			const type = str(args.type).toUpperCase();
			const [t] = new Project(where).add([{ title, ...(TYPES.includes(type) && { type }) }]);
			return `added ${t.id} ${t.title} (${t.type}) to ${basename(where)}: the next run takes it`;
		}
		case 'tell': {
			const id = str(args.id).toUpperCase();
			const note = str(args.note, 1000);
			if (!id || !note) fail('tell needs an id and a note');
			const p = open();
			if (!p.get(id)) fail(`no task ${id} in ${basename(where)}`);
			// Appended, as the cockpit's /tell does, so earlier notes stay; a live run reads it at the next attempt.
			p.update(id, (t) => (t.hint = t.hint ? `${t.hint}\n${note}` : note));
			p.log({ event: 'note', id, by: 'mcp' });
			return `${id}: note kept for its next attempt`;
		}
	}
	return fail(`no tool ${name}`);
}

function fail(message: string): never {
	throw new Error(message);
}

/** Serve MCP on `input`/`output` until input ends. `cwd` is the default project; `env` decides whether this is a worker. */
export function serve(input: Readable, output: Writable, cwd: string, env: NodeJS.ProcessEnv = process.env, version = '0'): Promise<void> {
	const worker = env.JARVIS_CODE_RUN === '1' && env.JARVIS_CODE_ROLE !== 'orchestrator';
	const send = (m: unknown) => output.write(JSON.stringify(m) + '\n');
	const rl = createInterface({ input });
	rl.on('line', async (raw) => {
		let msg: { id?: number | string; method?: string; params?: any };
		try {
			msg = JSON.parse(raw);
		} catch {
			return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
		}
		// MCP over stdio sends one message per line; a batch gets an answer rather than silence.
		if (Array.isArray(msg)) return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batch requests are not supported' } });
		// Notifications (no id) want no answer.
		if (msg.id === undefined || msg.id === null) return;
		const ok = (result: unknown) => send({ jsonrpc: '2.0', id: msg.id, result });
		switch (msg.method) {
			case 'initialize':
				return ok({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'jarvis-code', version } });
			case 'ping':
				return ok({});
			case 'tools/list':
				return ok({ tools: worker ? [] : TOOLS });
			case 'tools/call': {
				const text = (t: string, isError = false) => ok({ content: [{ type: 'text', text: t }], ...(isError && { isError }) });
				if (worker) return text('jarvis-code owns the queue for this run: do your task and report; it runs the checks and records the evidence.', true);
				try {
					return text(await call(String(msg.params?.name ?? ''), msg.params?.arguments ?? {}, cwd));
				} catch (e) {
					return text((e as Error).message, true);
				}
			}
		}
		send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
	});
	return new Promise((done) => rl.on('close', done));
}
