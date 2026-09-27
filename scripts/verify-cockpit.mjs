#!/usr/bin/env node
// Opens the cockpit (bare `jarvis-code`) in a real pseudo-terminal with its own state and a
// project whose agents are the demo fakes, then drives it like a person: the slash menu,
// /help, a typed goal, the run to the end, the stored tasks on the home screen, and Ctrl+C
// out. Checks each screen and that the terminal is handed back cleanly.
//
//   node scripts/verify-cockpit.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import xterm from '@xterm/headless';

const COLS = 110;
const ROWS = 36;
const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
const agent = fileURLToPath(new URL('../dist/src/demo-agent.js', import.meta.url));

const root = mkdtempSync(join(tmpdir(), 'jc-verify-cockpit-'));
const proj = join(root, 'orbit');
mkdirSync(proj);
writeFileSync(
	join(proj, '.jarvis-code.json'),
	JSON.stringify({
		agents: { claude: { kind: 'claude', enabled: true, bin: agent, models: ['claude-fable-5-1'], env: { JC_DEMO_PACE: '40' } }, codex: { enabled: false }, opencode: { enabled: false } },
		planner: ['claude:claude-fable-5-1'],
		workers: ['claude:claude-fable-5-1'],
	}),
);

// Every real agent off globally: only the project's demo agent can run.
mkdirSync(join(root, 'config', 'jarvis-code'), { recursive: true });
writeFileSync(join(root, 'config', 'jarvis-code', 'config.json'), JSON.stringify({ agents: { claude: { enabled: false }, codex: { enabled: false }, opencode: { enabled: false } } }));

const term = new xterm.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
const child = spawn('script', ['-qfec', `stty cols ${COLS} rows ${ROWS}; exec node ${JSON.stringify(cli)}`, '/dev/null'], {
	cwd: proj,
	stdio: ['pipe', 'pipe', 'inherit'],
	// The project names the demo agent in its own config, which only a trusted config may do.
	env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', JARVIS_CODE_STATE: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config'), JARVIS_CODE_TRUST: 'all' },
});
let raw = '';
child.stdout.on('data', (d) => {
	raw += d;
	term.write(d);
});
const exited = new Promise((r) => child.on('exit', r));

const screen = () => Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n');
const failures = [];
async function expect(what, re, ms = 5000) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (re.test(screen())) return console.log(`✓ ${what}`);
		await sleep(100);
	}
	failures.push(what);
	console.error(`✗ ${what}: ${re} not on screen\n${screen()}`);
}
const type = async (s) => {
	child.stdin.write(s);
	await sleep(150);
};

await expect('the cockpit opens on the project list', /P R O J E C T S[\s\S]*orbit/);
await type('/he');
await expect('the slash menu offers /help', /\/help\s+what every command does/);
await type('\t');
await type('\r');
await expect('/help lists every command', /C O M M A N D S[\s\S]*\/quit/);
await type('\x1b');
await expect('Esc goes back home', /P R O J E C T S/);
await type('add a status page');
await type('\r');
await expect('a typed goal starts a run', /PLANNING|WORKING/, 8000);
await expect('the run finishes', /FINISHED/, 60000);
await type('\x03');
await expect('Ctrl+C goes home, where the project shows its stored tasks', /orbit\s+.*\d+ done/, 5000);
await type('\x03');
const code = await Promise.race([exited, sleep(5000).then(() => 'timeout')]);
if (code !== 0) failures.push(`quit with Ctrl+C (exit ${code})`);
else console.log('✓ a second Ctrl+C quits');
// Ink on a terminal hides the cursor while it draws: it must be shown again on the way out.
if (raw.lastIndexOf('\x1b[?25l') > raw.lastIndexOf('\x1b[?25h')) failures.push('the cursor was left hidden');
else console.log('✓ the terminal gets its cursor back');

if (code === 'timeout') child.kill();
if (failures.length) {
	console.error(`✗ ${failures.length} check(s) failed: ${failures.join('; ')}`);
	process.exit(1);
}
console.log('✓ the cockpit works in a real terminal');
