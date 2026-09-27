import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULTS, type AgentConfig } from '../src/config.js';
import { startAgent, type AgentEvent, type RunSpec } from '../src/agents/index.js';
import { ClaudeParser, claudeArgs } from '../src/agents/claude.js';
import { codexArgs } from '../src/agents/codex.js';

const fixtures = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));
const agent = (over: Partial<AgentConfig>): AgentConfig => ({ ...DEFAULTS.agents.claude, ...over });
const spec = (over: Partial<RunSpec> = {}): RunSpec => ({ prompt: 'do the thing', cwd: tmpdir(), role: 'worker', blockedTools: [], ...over });

test('claude: a real stream-json run parses to init, text and a successful result', () => {
	const events: AgentEvent[] = [];
	const p = new ClaudeParser((e) => events.push(e));
	for (const line of readFileSync(join(fixtures, 'claude-live.jsonl'), 'utf8').trim().split('\n')) p.line(JSON.parse(line));
	assert.deepEqual(events[0], { type: 'init', model: 'claude-haiku-4-5-20251001', session: 'fixture' });
	assert.ok(events.some((e) => e.type === 'text' && e.text === 'ok'));
	assert.equal(p.final.ok, true);
	assert.equal(p.final.summary, 'ok');
	assert.ok((p.final.costUsd ?? 0) > 0);
});

test('claude: a sticky downgrade is answered with set_model and the run ends on the original model', async () => {
	const log = join(mkdtempSync(join(tmpdir(), 'jc-fake-')), 'log.jsonl');
	const events: AgentEvent[] = [];
	const cfg = agent({ bin: join(fixtures, 'fake-claude.mjs'), env: { FAKE_LOG: log } });
	const run = startAgent(cfg, spec({ model: 'claude-fable-5-1', blockedTools: ['WebFetch', 'Agent(Explore)'] }), (e) => {
		events.push(e);
		if (e.type === 'model' && e.sticky && e.from) run.setModel!(e.from);
	});
	const out = await run.done;
	assert.equal(out.ok, true);
	// The switch applies from the next turn: the downgraded turn ends on the fallback model,
	// then a follow-up turn runs on the restored one and has the last word.
	assert.equal(out.summary, 'reviewed on claude-fable-5-1');
	assert.equal(out.model, 'claude-fable-5-1');
	assert.ok(events.some((e) => e.type === 'model' && e.to === 'claude-opus-4-8' && e.sticky && e.reason === 'refusal:cyber'));
	assert.ok(events.some((e) => e.type === 'reupgrade' && e.model === 'claude-fable-5-1' && e.ok));
	// Diffs are reported as change events; the subagent key carries its type.
	assert.ok(events.some((e) => e.type === 'change' && e.path === 'a.txt' && e.diff?.includes('+ y')));
	assert.ok(events.some((e) => e.type === 'tool_result' && e.name === 'Agent(Explore)' && !e.ok));

	const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
	const argv: string[] = lines[0].argv;
	assert.ok(argv.includes('--settings') && argv[argv.indexOf('--settings') + 1] === '{"enabledPlugins":{"foreman@foreman":false}}');
	assert.ok(argv.includes('--disallowedTools=WebFetch'), 'plain tools go to the CLI; subagent keys to the plugin hook');
	const control = lines.find((l) => l.stdin?.type === 'control_request');
	assert.deepEqual(control.stdin.request, { subtype: 'set_model', model: 'claude-fable-5-1' });
	const turns = lines.filter((l) => l.stdin?.type === 'user').map((l) => l.stdin.message.content);
	assert.equal(turns.length, 2);
	assert.match(turns[1], /back on claude-fable-5-1/);
});

test('claude: the planner cannot edit', async () => {
	const log = join(mkdtempSync(join(tmpdir(), 'jc-fake-')), 'log.jsonl');
	const cfg = agent({ bin: join(fixtures, 'fake-claude.mjs'), env: { FAKE_LOG: log, FAKE_MODE: 'plain' } });
	const out = await startAgent(cfg, spec({ role: 'planner' }), () => {}).done;
	assert.equal(out.ok, true);
	const argv: string[] = JSON.parse(readFileSync(log, 'utf8').split('\n')[0]).argv;
	assert.ok(argv.some((a) => a.startsWith('--disallowedTools=') && a.includes('Edit') && a.includes('Write')));
});

test('codex: commands, file changes, MCP failures and the final message', async () => {
	const events: AgentEvent[] = [];
	const cfg = agent({ kind: 'codex', bin: join(fixtures, 'replay.mjs'), env: { FAKE_FIXTURE: join(fixtures, 'codex.jsonl') } });
	const out = await startAgent(cfg, spec(), (e) => events.push(e)).done;
	assert.equal(out.ok, true);
	assert.equal(out.summary, 'Fixed the parser.');
	assert.ok(events.some((e) => e.type === 'tool' && e.name === 'Bash' && e.summary === 'Bash npm test'));
	assert.ok(events.some((e) => e.type === 'tool_result' && e.name === 'Bash' && !e.ok));
	assert.ok(events.some((e) => e.type === 'change' && e.path === 'src/a.ts'));
	assert.ok(events.some((e) => e.type === 'tool_result' && e.name === 'mcp__docs__search' && !e.ok && e.error === 'server down'));
});

test('opencode: edits, a failing subagent, cost and summary', async () => {
	const events: AgentEvent[] = [];
	const cfg = agent({ kind: 'opencode', bin: join(fixtures, 'replay.mjs'), env: { FAKE_FIXTURE: join(fixtures, 'opencode.jsonl') } });
	const out = await startAgent(cfg, spec({ model: 'ollama/qwen3-coder' }), (e) => events.push(e)).done;
	assert.equal(out.ok, true);
	assert.equal(out.summary, 'All done.');
	assert.equal(out.costUsd, 0.004);
	assert.ok(events.some((e) => e.type === 'init' && e.model === 'ollama/qwen3-coder'));
	assert.ok(events.some((e) => e.type === 'change' && e.path === 'src/b.ts'));
	assert.ok(events.some((e) => e.type === 'tool_result' && e.name === 'task(general)' && !e.ok));
});

test('a non-zero exit fails the run even when the agent claims success', async () => {
	const cfg = agent({ kind: 'codex', bin: join(fixtures, 'replay.mjs'), env: { FAKE_FIXTURE: join(fixtures, 'codex.jsonl'), FAKE_EXIT: '3' } });
	const out = await startAgent(cfg, spec(), () => {}).done;
	assert.equal(out.ok, false);
	assert.equal(out.exitCode, 3);
});

test('generic: {prompt} is substituted and stdout is the summary', async () => {
	const cfg = agent({ kind: 'generic', bin: process.execPath, args: ['-e', 'console.log("got: " + process.argv[1])', '{prompt}'] });
	const events: AgentEvent[] = [];
	const out = await startAgent(cfg, spec({ prompt: 'hello' }), (e) => events.push(e)).done;
	assert.equal(out.ok, true);
	assert.equal(out.summary, 'got: hello');
	const multi = await startAgent(agent({ kind: 'generic', bin: process.execPath, args: ['-e', 'console.log("```json\\n{\\"tasks\\":[]}\\n```")'] }), spec(), () => {}).done;
	assert.equal(multi.summary, '```', 'the summary is the last line');
	assert.equal(multi.results?.[0], '```json\n{"tasks":[]}\n```\n', 'the result is the whole answer, so a plan spanning lines parses');
	const missing = await startAgent(agent({ kind: 'generic', bin: '/nonexistent/agent' }), spec(), () => {}).done;
	assert.equal(missing.ok, false);
	assert.match(missing.error ?? '', /ENOENT/);
});

test('codex: workers get a writable sandbox unless the config picked one', () => {
	const cfg = agent({ kind: 'codex', bin: 'codex' });
	assert.deepEqual(codexArgs(cfg, spec({ model: 'gpt-6' })).slice(0, 6), ['exec', '--json', '--model', 'gpt-6', '--sandbox', 'workspace-write']);
	assert.ok(codexArgs(cfg, spec({ role: 'planner' })).includes('read-only'));
	const own = codexArgs({ ...cfg, args: ['--full-auto'] }, spec());
	assert.equal(own.filter((a) => a === '--sandbox').length, 0);
	assert.equal(own.at(-1), 'do the thing');
});

test('claude: a [1m]-style suffix is the same model, not a switch', () => {
	const events: AgentEvent[] = [];
	const p = new ClaudeParser((e) => events.push(e));
	p.line({ type: 'system', subtype: 'init', model: 'claude-opus-5-5[1m]', session_id: 's' });
	p.line({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hi' }] } });
	assert.equal(events.filter((e) => e.type === 'model').length, 0);
	p.line({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'hi' }] } });
	assert.equal(events.filter((e) => e.type === 'model').length, 1, 'a different model still counts');
});

test('claude: every turn result is kept', async () => {
	const cfg = agent({ bin: join(fixtures, 'fake-claude.mjs'), env: { FAKE_TEXT1: 'first turn' } });
	const run = startAgent(cfg, spec({ model: 'claude-fable-5-1' }), (e) => {
		if (e.type === 'model' && e.sticky && e.from) run.setModel!(e.from);
	});
	const out = await run.done;
	assert.deepEqual(out.results, ['first turn', 'reviewed on claude-fable-5-1']);
});

test('idle watchdog: a worker that goes silent is killed with a reason', async () => {
	const cfg = agent({ kind: 'generic', bin: process.execPath, args: ['-e', 'console.log("started"); setTimeout(() => {}, 60000)'], idleMin: 0.01 });
	const t0 = Date.now();
	const out = await startAgent(cfg, spec(), () => {}).done;
	assert.equal(out.ok, false);
	assert.match(out.error ?? '', /no output for/);
	assert.ok(Date.now() - t0 < 10_000, 'killed long before its whole-run timeout');
});

test('agent children are killed when jarvis-code crashes', async () => {
	const { spawnSync } = await import('node:child_process');
	const spawnJs = fileURLToPath(new URL('../src/agents/spawn.js', import.meta.url));
	const r = spawnSync(process.execPath, [join(fixtures, 'orphan-parent.mjs'), pathToFileURL(spawnJs).href], { encoding: 'utf8', timeout: 20_000 });
	const pid = Number(r.stdout.trim().split('\n')[0]);
	assert.ok(pid > 0, `no child pid: ${r.stdout} ${r.stderr}`);
	await new Promise((res) => setTimeout(res, 300));
	let alive = true;
	try {
		process.kill(pid, 0);
	} catch {
		alive = false;
	}
	if (alive) process.kill(pid, 'SIGKILL');
	assert.equal(alive, false, 'the agent outlived its parent');
});

test('agent output reaches the terminal without control characters', async () => {
	// A repository can steer what an agent prints: an escape sequence must not reach the screen.
	const cfg = agent({ kind: 'generic', bin: process.execPath, args: ['-e', 'console.log("FOLLOW-UP: \\x1b[2J\\x1b[Hfake\\x07\\ttab\\x9b31m")'] });
	const events: AgentEvent[] = [];
	const out = await startAgent(cfg, spec(), (e) => events.push(e)).done;
	const text = events.find((e) => e.type === 'text');
	assert.equal(text?.type === 'text' && text.text, 'FOLLOW-UP: [2J[Hfake  tab31m');
	assert.equal(out.summary, 'FOLLOW-UP: [2J[Hfake  tab31m');
	assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(out.results?.[0] ?? ''));
});

test('claude: a tool-less session starts with --tools "" and no deny list', () => {
	const args = claudeArgs(agent({}), spec({ role: 'planner', tools: 'none', blockedTools: ['WebFetch'] }));
	assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', '']);
	assert.ok(!args.some((a) => a.startsWith('--disallowedTools')));
});
