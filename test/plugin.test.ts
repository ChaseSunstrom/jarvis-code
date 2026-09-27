import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { install, installed, PLUGIN_DIR, uninstall } from '../src/plugin.js';

const hook = join(PLUGIN_DIR, 'hooks', 'jc-hook.mjs');
const runHook = (payload: object, env: Record<string, string>) =>
	execFileSync(process.execPath, [hook, 'PreToolUse'], { input: JSON.stringify(payload), env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });

test('hook: silent outside a jarvis-code run, whatever the tool', () => {
	assert.equal(runHook({ tool_name: 'Agent', tool_input: { subagent_type: 'Explore' } }, { JARVIS_CODE_BLOCKED: 'Agent(Explore)' }), '');
});

test('hook: refuses a learned-bad subagent and Foreman state commands, allows the rest', () => {
	const env = { JARVIS_CODE_RUN: '1', JARVIS_CODE_ROLE: 'worker', JARVIS_CODE_BLOCKED: 'Agent(Explore),WebFetch' };
	const deny = (out: string) => JSON.parse(out).hookSpecificOutput;
	assert.equal(deny(runHook({ tool_name: 'Agent', tool_input: { subagent_type: 'Explore' } }, env)).permissionDecision, 'deny');
	assert.equal(deny(runHook({ tool_name: 'WebFetch', tool_input: { url: 'x' } }, env)).permissionDecision, 'deny');
	assert.match(deny(runHook({ tool_name: 'Bash', tool_input: { command: 'npm test && fm task done T-0003' } }, env)).permissionDecisionReason, /owns Foreman task state/);
	assert.equal(runHook({ tool_name: 'Agent', tool_input: { subagent_type: 'Plan' } }, env), '');
	assert.equal(runHook({ tool_name: 'Bash', tool_input: { command: 'fm outline src/x.ts' } }, env), '', 'read-only fm is fine');
	assert.equal(runHook({ tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } }, env), '');
});

test('guard: Foreman state commands are refused however the shell line is dressed up', async () => {
	const { refusal } = await import(pathToFileURL(join(PLUGIN_DIR, 'hooks', 'guard.mjs')).href);
	const env = { JARVIS_CODE_RUN: '1', JARVIS_CODE_ROLE: 'worker' };
	const refused = (command: string) => !!refusal('Bash', { command }, env);
	for (const cmd of [
		'fm task done T-1',
		' fm task done T-1',
		'echo ok\nfm task done T-1',
		'env fm task done T-1',
		'command fm focus T-2',
		'/usr/local/bin/fm task finish T-1 --run true',
		'FOREMAN_STATE=/tmp/x fm task block T-1 why',
		'if true; then fm task done T-1; fi',
		'echo $(fm task done T-1)',
		'bash -c "fm task done T-1"',
		'npm test && fm capture "later"',
	])
		assert.ok(refused(cmd), `not refused: ${JSON.stringify(cmd)}`);
	for (const cmd of ['fm outline src/x.ts', 'fm queue --json', 'npm test', 'git commit -m "fix fmt task"', 'grep -r confirm src'])
		assert.ok(!refused(cmd), `refused: ${JSON.stringify(cmd)}`);
	assert.equal(refusal('Bash', { command: 'fm task done T-1' }, {}), undefined, 'outside a run nothing is refused');
});

test('opencode plugin: no hooks outside a run; throws on a blocked tool inside one', async () => {
	const mod = await import(pathToFileURL(join(PLUGIN_DIR, 'opencode', 'jarvis-code.js')).href);
	const prev = { ...process.env };
	try {
		delete process.env.JARVIS_CODE_RUN;
		assert.deepEqual(await mod.JarvisCode({}), {});
		Object.assign(process.env, { JARVIS_CODE_RUN: '1', JARVIS_CODE_ROLE: 'worker', JARVIS_CODE_BLOCKED: 'task(general)' });
		const hooks = await mod.JarvisCode({});
		await assert.rejects(hooks['tool.execute.before']({ tool: 'task' }, { args: { subagent_type: 'general' } }), /switched off task\(general\)/);
		await hooks['tool.execute.before']({ tool: 'read' }, { args: { filePath: 'a' } });
	} finally {
		for (const k of ['JARVIS_CODE_RUN', 'JARVIS_CODE_ROLE', 'JARVIS_CODE_BLOCKED']) if (prev[k] === undefined) delete process.env[k];
	}
});

test('codex install merges one hook into hooks.json and uninstall removes only it', () => {
	const home = mkdtempSync(join(tmpdir(), 'jc-codex-'));
	process.env.CODEX_HOME = home;
	const file = join(home, 'hooks.json');
	const theirs = { matcher: '^Bash$', hooks: [{ type: 'command', command: 'my-policy.sh' }] };
	writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [theirs], SessionStart: [] } }));
	install('codex');
	install('codex'); // idempotent
	const data = JSON.parse(readFileSync(file, 'utf8'));
	assert.equal(data.hooks.PreToolUse.length, 2);
	assert.deepEqual(data.hooks.PreToolUse[0], theirs);
	assert.ok(installed.codex());
	uninstall('codex');
	assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse, [theirs]);
	assert.equal(installed.codex(), false);
	delete process.env.CODEX_HOME;
});

test('opencode install links the plugin into the global plugins directory', () => {
	const xdg = mkdtempSync(join(tmpdir(), 'jc-oc-'));
	const prev = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = xdg;
	try {
		mkdirSync(join(xdg, 'opencode', 'plugins'), { recursive: true });
		install('opencode');
		assert.ok(lstatSync(join(xdg, 'opencode', 'plugins', 'jarvis-code.js')).isSymbolicLink());
		assert.ok(installed.opencode());
		uninstall('opencode');
		assert.equal(installed.opencode(), false);
	} finally {
		if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = prev;
	}
});
