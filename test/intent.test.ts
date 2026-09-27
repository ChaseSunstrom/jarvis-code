import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { intentFile, intentSummary, readIntent, recordIntent, resetIntent } from '../src/intent.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `jc-${p}-`));
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('intent store: redacts secrets and home, caps text, skips bad lines, trims past 600, summarises and resets', () => {
	process.env.JARVIS_CODE_STATE = join(tmp('state'), 'jc');
	assert.equal(intentSummary(), '');

	const token = 'ghp_' + 'a1B2'.repeat(9);
	const hex = '0123456789abcdef'.repeat(3);
	recordIntent({ kind: 'asked', text: `deploy with ${token} and sk-ant-${'x9'.repeat(12)} key AKIAABCDEFGHIJKLMNOP xoxb-1234567890-abc sha ${hex} from ${join(homedir(), 'projects', 'app')}`, project: 'app' });
	const [e] = readIntent();
	assert.equal(e.kind, 'asked');
	assert.equal(e.project, 'app');
	assert.ok(!Number.isNaN(Date.parse(e.at)));
	for (const secret of [token, 'sk-ant-', 'AKIAABCDEFGHIJKLMNOP', 'xoxb-', hex, homedir() + '/']) assert.ok(!e.text.includes(secret), `${secret} leaked: ${e.text}`);
	assert.match(e.text, /from ~\/projects\/app$/);
	assert.match(e.text, /deploy with \[redacted\]/);
	assert.match(e.text, /sha \[redacted\]/);

	recordIntent({ kind: 'dropped', text: 'y'.repeat(1000), project: 'app' });
	assert.equal(readIntent()[1].text.length, 300);

	// Bad lines are skipped, not fatal.
	appendFileSync(intentFile(), 'not json\n{"kind":"asked"}\n');
	assert.equal(readIntent().length, 2);

	// Distinct, newest first, at most 3 per project, accepted left out, within max chars.
	resetIntent();
	assert.equal(readFileSync(intentFile(), 'utf8'), '');
	for (const t of ['add dark mode', 'add dark mode', 'fix login', 'port to rust', 'add tests']) recordIntent({ kind: 'asked', text: t, project: 'web' });
	recordIntent({ kind: 'dropped', text: 'rewrite the router', project: 'api' });
	recordIntent({ kind: 'accepted', text: 'bump deps', project: 'api' });
	const summary = intentSummary();
	assert.equal(summary, ['- api: turned down rewrite the router', '- web: asked for add tests', '- web: asked for port to rust', '- web: asked for fix login'].join('\n'));
	assert.ok(intentSummary(80).length <= 80);
	assert.equal(intentSummary(80).split('\n').length, 2);

	// Past 600 lines the file is rewritten to the newest 500.
	resetIntent();
	for (let i = 0; i < 650; i++) recordIntent({ kind: 'asked', text: `goal ${i}`, project: 'p' });
	const all = readIntent();
	assert.equal(all.length, 549);
	assert.equal(all[0].text, 'goal 101');
	assert.equal(all.at(-1)!.text, 'goal 649');

	resetIntent();
	assert.equal(readIntent().length, 0);
	assert.equal(intentSummary(), '');
});

test('intent cli: shows the summary or says nothing is recorded, reset empties it, help lists both', () => {
	const root = tmp('state');
	process.env.JARVIS_CODE_STATE = join(root, 'jc');
	process.env.XDG_CONFIG_HOME = join(root, 'config');
	mkdirSync(join(root, 'config', 'jarvis-code'), { recursive: true });
	writeFileSync(join(root, 'config', 'jarvis-code', 'config.json'), JSON.stringify({ agents: { claude: { enabled: false }, codex: { enabled: false }, opencode: { enabled: false } } }));
	const dir = tmp('proj');
	const env = { ...process.env, NO_COLOR: '1' };
	const jc = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], { cwd: dir, env, encoding: 'utf8' });

	assert.match(jc('intent'), /nothing recorded yet/);
	recordIntent({ kind: 'asked', text: 'add a dark theme', project: 'web' });
	recordIntent({ kind: 'dropped', text: 'rewrite in rust', project: 'web' });
	const shown = jc('intent');
	assert.match(shown, /web: asked for add a dark theme/);
	assert.match(shown, /web: turned down rewrite in rust/);

	assert.match(jc('intent', 'reset'), /forgot/);
	assert.match(jc('intent'), /nothing recorded yet/);
	assert.equal(intentSummary(), '');

	const help = jc('help');
	assert.match(help, /jarvis-code intent \[reset\]/);
});
