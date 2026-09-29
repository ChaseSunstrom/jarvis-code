/**
 * A stand-in coding agent for `jarvis-code demo` and the end-to-end tests. It speaks
 * Claude Code's stream-json protocol when run with `--input-format stream-json`, plain
 * text lines otherwise. As a planner it answers with a plan; as a worker it "works" for a
 * moment and satisfies the `test -f PATH` checks named in its prompt.
 *
 * As a prompt writer it calls goals with open-ended words "open"; as a brainstormer it gives
 * fewer new ideas each round (3, 2, 1, then none), like a real brainstorm running dry; as a
 * critic it scores later ideas higher, so ranking visibly reorders them.
 *
 * Env: JC_DEMO_PACE — ms per step (default 450) · JC_DEMO_PLAN — plan JSON to answer with ·
 * JC_DEMO_REVIEW=changes-first — as a reviewer, ask for changes until the diff shows a
 * `.reviewed` marker (which a worker writes when its prompt carries review findings) ·
 * JC_DEMO_REPLAN — plan JSON to answer a re-plan with (default: cannot split) ·
 * JC_DEMO_PLAN_FIXED — plan JSON to answer when asked to fix a plan's problems ·
 * JC_DEMO_KIND=open|concrete — force the prompt writer's call · JC_DEMO_BREAK=prompt,ideas,critique —
 * answer those stages with prose instead of JSON · JC_DEMO_NOTES=1 — the first
 * task reports a lesson and a follow-up · JC_DEMO_LOG — append every prompt to this file ·
 * JC_DEMO_DOWNGRADE=1|some — a model named *fable* is downgraded once per session (`some`:
 * every third task); like the real CLI, a switch back applies from the next turn. A model named *flaky* never satisfies its checks (a weak local model).
 * JC_DEMO_UNMET=n[,m] — as a coverage check, call those done items unmet (default: every item met).
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

const PLAN_MARKER = 'JARVIS-CODE PLAN';
const PROMPT_MARKER = 'JARVIS-CODE PROMPT';
const IDEAS_MARKER = 'JARVIS-CODE IDEAS';
const REVIEW_MARKER = 'JARVIS-CODE REVIEW';
const CRITIQUE_MARKER = 'JARVIS-CODE CRITIQUE';
const COVERAGE_MARKER = 'JARVIS-CODE COVERAGE';
const CATEGORIES_MARKER = 'JARVIS-CODE CATEGORIES';
const BRANCH_MARKER = 'JARVIS-CODE BRANCH';
const ASK_MARKER = 'JARVIS-CODE ASK';
/** Words for a tree's ideas, a list per level, so titles never share enough words to be merged as duplicates. */
const TREE_WORDS = [[], [], ['amber', 'cobalt', 'crimson', 'indigo', 'jade', 'ochre'], ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'], ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'neptune', 'uranus', 'pluto'], ['copper', 'nickel', 'chrome', 'zinc', 'tin', 'lead', 'iron', 'gold'], ['oak', 'elm', 'ash', 'fir', 'yew', 'pine', 'larch', 'birch']];
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
// `--tools ""`, as the real CLI takes it: no tools at all this session.
const noTools = argOf('--tools') === '';

async function tool(name: string, input: Record<string, unknown>, ok = true, result = 'ok') {
	if (noTools) return;
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
	if (process.env.JC_DEMO_LOG) appendFileSync(process.env.JC_DEMO_LOG, JSON.stringify(noTools ? `[no tools] ${prompt}` : prompt) + '\n');
	const broken = (stage: string) => (process.env.JC_DEMO_BREAK ?? '').split(',').includes(stage);
	if (prompt.includes(PROMPT_MARKER) && broken('prompt')) return { ok: true, text: 'I looked around; the goal seems fine.' };
	if ((prompt.includes(IDEAS_MARKER) || prompt.includes(CATEGORIES_MARKER) || prompt.includes(BRANCH_MARKER)) && broken('ideas')) return { ok: true, text: 'Some thoughts: make it faster.' };
	if (prompt.includes(ASK_MARKER)) {
		await tool('Read', { file_path: 'README.md' });
		const question = prompt.match(/<<<QUESTION\n([\s\S]*?)\nQUESTION>>>/)?.[1] ?? '';
		return { ok: true, text: `You asked: ${question}\n\nFrom the record, T-0001 closed on its first attempt and nothing is blocked. ${'The reports and the ledger agree on this; the loader lives in src/config.ts. '.repeat(3)}` };
	}
	if (prompt.includes(CATEGORIES_MARKER)) {
		await tool('Read', { file_path: 'README.md' });
		const ideas = ['Interface', 'Reliability', 'Speed'].map((title, k) => ({ title, why: `the ${title.toLowerCase()} of src/config.ts`, value: 5 - k }));
		return { ok: true, text: JSON.stringify({ ideas }) };
	}
	if (prompt.includes(BRANCH_MARKER)) {
		await tool('Read', { file_path: 'src/config.ts' });
		const [, cat = 'Area', level = '2'] = prompt.match(/Category: (.*?)\. Level (\d+) of/) ?? [];
		const parents = (prompt.split('numbered:\n')[1] ?? '').split('\n\n')[0].split('\n').filter((l) => /^\d+\. /.test(l)).length;
		// Level 2 grows 3 broad ideas from the category; deeper levels 2 per parent, best first.
		const per = Number(level) === 2 ? 3 : 2;
		const pool = TREE_WORDS[Number(level)] ?? TREE_WORDS[2];
		const ideas = Array.from({ length: Math.max(1, parents) * per }, (_, i) => ({ parent: Math.floor(i / per) + 1, title: `${cat} ${pool[i % pool.length]}`, why: 'it helps (src/config.ts)', effort: 'S', value: 5 - (i % per) }));
		return { ok: true, text: JSON.stringify({ ideas }) };
	}
	if (prompt.includes(CRITIQUE_MARKER)) {
		await tool('Read', { file_path: 'src/config.ts' });
		if (broken('critique')) return { ok: true, text: 'They all look reasonable to me.' };
		const scores = [...prompt.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1])).map((n) => ({ n, value: Math.min(5, n), effort: 2, risk: 1, note: 'checked against src/config.ts' }));
		return { ok: true, text: JSON.stringify({ scores }) };
	}
	if (prompt.includes(COVERAGE_MARKER)) {
		await tool('Read', { file_path: 'src/config.ts' });
		const unmet = (process.env.JC_DEMO_UNMET ?? '').split(',').map(Number);
		const landed = [...prompt.matchAll(/^- ([A-Z]+-\d+) /gm)].map((m) => m[1]);
		const items = [...prompt.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1])).map((n) =>
			unmet.includes(n) ? { n, met: false, tasks: [], missing: 'no task covers it yet' } : { n, met: true, tasks: landed, missing: '' },
		);
		return { ok: true, text: JSON.stringify({ items }) };
	}
	if (prompt.includes(REVIEW_MARKER)) {
		await tool('Read', { file_path: 'src/config.ts' });
		const addressed = /\.reviewed\b/.test(prompt);
		if (process.env.JC_DEMO_REVIEW === 'changes-first' && !addressed)
			return { ok: true, text: JSON.stringify({ verdict: 'changes', findings: ['src/config.ts:12: the loader ignores an empty settings file', 'src/config.ts:30: no test covers the reload path'] }) };
		return { ok: true, text: JSON.stringify({ verdict: 'approve', findings: [] }) };
	}
	if (prompt.includes(PROMPT_MARKER)) {
		await tool('Read', { file_path: 'README.md' });
		const goal = prompt.match(/Goal, in the user's words: (.*)/)?.[1] ?? '';
		const kind = process.env.JC_DEMO_KIND ?? (/\b(improve|better|modernize|polish|features|ideas)\b/i.test(goal) ? 'open' : 'concrete');
		const brief = `Goal: ${goal}. The project builds with npm and tests with \`npm test\`; the change touches src/config.ts. Done when the tests pass.`;
		const done = ['the settings load from src/config.ts', 'npm test passes', 'the README documents the settings'];
		return { ok: true, text: JSON.stringify({ brief, kind, lenses: ['developer experience'], done }) };
	}
	if (prompt.includes(IDEAS_MARKER)) {
		await tool('Read', { file_path: 'README.md' });
		const lens = prompt.match(/Your angle: (.*?)\. Round/)?.[1] ?? 'lens';
		const round = Number(prompt.match(/Round (\d+)\./)?.[1] ?? 1);
		const seen = [...prompt.matchAll(/^- (.+)$/gm)].map((m) => m[1]);
		// A repeat of an earlier idea, as real brainstormers give: it must be deduplicated.
		const ideas = [...seen.slice(0, 1), ...Array.from({ length: Math.max(0, 4 - round) }, (_, k) => `${lens}: idea ${round}.${k + 1}`)].map((title) => ({ title, why: 'it helps', effort: 'S' }));
		return { ok: true, text: JSON.stringify({ ideas }) };
	}
	if (prompt.includes(PLAN_MARKER) && /^RE-PLAN:/m.test(prompt)) {
		await tool('Read', { file_path: 'README.md' });
		return { ok: true, text: process.env.JC_DEMO_REPLAN ?? '{"tasks":[]}' };
	}
	if (prompt.includes(PLAN_MARKER) && /Your previous plan \(below\) has these problems/.test(prompt) && process.env.JC_DEMO_PLAN_FIXED)
		return { ok: true, text: process.env.JC_DEMO_PLAN_FIXED };
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
	// Review findings in hand: address them, and leave a marker the reviewer will see in the diff.
	if (/asked for these before it can close/.test(prompt)) files.push(`.jarvis-demo/${task}.reviewed`);
	await say(`Working on ${task}.`);
	await tool('Grep', { pattern: 'loadConfig' });
	await tool('Read', { file_path: 'src/config.ts' });
	await downgradeOnce();
	await tool('Edit', { file_path: 'src/config.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' });
	await tool('Bash', { command: 'npm test' });
	if (/flaky/.test(model)) return { ok: true, text: 'I think it is done.' };
	writeChecks();
	const notes = process.env.JC_DEMO_NOTES && /T-0*1\b/.test(task) ? '\nLESSON: the settings tests need JC_ENV=test\nFOLLOW-UP: Fix the stale cache in the legacy loader' : '';
	return { ok: true, text: `${task}: made the change on ${model}; ${files.length} check(s) should pass.${notes}` };
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
