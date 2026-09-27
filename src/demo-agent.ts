/**
 * A stand-in coding agent for `jarvis-code demo` and the end-to-end tests. It speaks
 * Claude Code's stream-json protocol when run with `--input-format stream-json`, plain
 * text lines otherwise. As a planner it answers with a plan; as a worker it "works" for a
 * moment and satisfies the `test -f PATH` checks named in its prompt.
 *
 * Env: JC_DEMO_PACE — ms per step (default 450) · JC_DEMO_PLAN — plan JSON to answer with ·
 * JC_DEMO_DOWNGRADE=1|some — a model named *fable* is downgraded once per session (`some`:
 * every third task); like the real CLI, a switch back applies from the next turn. A model named *flaky* never satisfies its checks (a weak local model).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

const PLAN_MARKER = 'JARVIS-CODE PLAN';
const argv = process.argv.slice(2);
const stream = argv.includes('--input-format');
const argOf = (name: string) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};
let model = argOf('--model') ?? (stream ? 'claude-fable-5-1' : 'demo');
const pace = Number(process.env.JC_DEMO_PACE ?? 450);
const out = (o: object) => process.stdout.write(JSON.stringify(o) + '\n');

const DEFAULT_PLAN = {
	tasks: [
		['Map the config surface', 'CLEAN'],
		['Add the settings loader', 'FEATURE'],
		['Route requests through the new loader', 'FEATURE'],
		['Fix the stale cache on reload', 'FIX'],
		['Harden input validation at the API edge', 'SECURITY'],
		['Speed up the cold start path', 'PERF'],
		['Document the new settings', 'FEATURE'],
	].map(([title, type], i) => ({
		key: `t${i + 1}`,
		title,
		type,
		tier: 'S',
		acs: [{ text: `${title} is in place`, verify: `test -f .jarvis-demo/t${i + 1}.done` }],
		steps: ['read the code it touches', 'make the change', 'run the checks'],
		depends: i ? [`t${i}`] : [],
	})),
};

/** A switch accepted by set_model: like the real CLI, it applies from the next turn. */
let next: string | undefined;
let files: string[] = [];
let task = 'task';

async function say(text: string) {
	if (stream) out({ type: 'assistant', parent_tool_use_id: null, message: { model, content: [{ type: 'text', text }] } });
	else console.log(text);
}

let ids = 0;
async function tool(name: string, input: Record<string, unknown>, ok = true, result = 'ok') {
	const id = `toolu_${++ids}`;
	if (stream) {
		out({ type: 'assistant', parent_tool_use_id: null, message: { model, content: [{ type: 'tool_use', id, name, input }] } });
		await sleep(pace);
		out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: !ok, content: result }] } });
	} else {
		console.log(`${name} ${Object.values(input)[0] ?? ''}`);
		await sleep(pace);
	}
}

async function downgradeOnce() {
	const mode = process.env.JC_DEMO_DOWNGRADE;
	if (!stream || !mode || !/fable/.test(model)) return;
	// `some`: every third task, so a demo shows it without every session doing it.
	if (mode === 'some' && Number(task.match(/\d+/)?.[0] ?? 0) % 3 !== 2) return;
	const original = model;
	model = 'claude-opus-4-8';
	out({ type: 'system', subtype: 'model_refusal_fallback', trigger: 'refusal', direction: 'sticky', scope: 'session', original_model: original, fallback_model: model, request_id: null, api_refusal_category: 'cyber', content: `automatically switched from ${original}` });
}

function writeChecks() {
	for (const f of files) {
		const path = resolve(process.cwd(), f);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${task} by ${model}\n`);
	}
}

async function work(prompt: string): Promise<{ ok: boolean; text: string }> {
	if (prompt.includes(PLAN_MARKER)) {
		await tool('Glob', { pattern: '**/*' });
		await tool('Read', { file_path: 'README.md' });
		const plan = process.env.JC_DEMO_PLAN ? JSON.parse(process.env.JC_DEMO_PLAN) : DEFAULT_PLAN;
		return { ok: true, text: '```json\n' + JSON.stringify(plan) + '\n```' };
	}
	if (/you are back on/.test(prompt)) {
		// The follow-up turn after a switch back: review, and redo the work on this model.
		await tool('Read', { file_path: 'src/config.ts' });
		writeChecks();
		return { ok: true, text: `${task}: reviewed and finished on ${model}.` };
	}
	task = prompt.match(/^Task (\S+)/)?.[1] ?? 'task';
	files = [...prompt.matchAll(/test -f ([^\s`&;|]+)/g)].map((m) => m[1]);
	await say(`Working on ${task}.`);
	await tool('Grep', { pattern: 'loadConfig' });
	await tool('Read', { file_path: 'src/config.ts' });
	await downgradeOnce();
	await tool('Edit', { file_path: 'src/config.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' });
	await tool('Bash', { command: 'npm test' });
	if (/flaky/.test(model)) return { ok: true, text: 'I think it is done.' };
	writeChecks();
	return { ok: true, text: `${task}: made the change on ${model}; ${files.length} check(s) should pass.` };
}

async function main() {
	if (!stream) {
		const r = await work(argv[argv.length - 1] ?? '');
		console.log(r.text);
		process.exit(r.ok ? 0 : 1);
	}
	const rl = createInterface({ input: process.stdin });
	let turn = Promise.resolve();
	rl.on('line', (raw) => {
		const m = JSON.parse(raw);
		if (m.type === 'control_request' && m.request?.subtype === 'set_model') {
			next = m.request.model;
			out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id } });
			return;
		}
		if (m.type !== 'user') return;
		turn = turn.then(async () => {
			if (next) [model, next] = [next, undefined];
			out({ type: 'system', subtype: 'init', model, session_id: `demo-${process.pid}` });
			const r = await work(String(m.message?.content ?? ''));
			await say(r.text);
			out({ type: 'result', subtype: r.ok ? 'success' : 'error_during_execution', is_error: !r.ok, result: r.text, total_cost_usd: 0.02 + Math.random() * 0.05 });
		});
	});
	rl.on('close', () => void turn.then(() => process.exit(0)));
}

main();
