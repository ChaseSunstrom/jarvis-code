#!/usr/bin/env node
// Soak test for the cockpit's memory. Renders the real Cockpit with Ink, set up as cli.ts does it
// (incremental rendering at ui.fps), into a fake 300x80 terminal. It runs fast demo runs back to
// back and floods each live run with ~1 MB diffs and messages, the way a chatty agent does. After
// a full GC every few seconds it samples heapUsed. Exits 1 when the heap still grows over the last
// third of the samples; an OOM under --max-old-space-size fails it too.
//
//   npm run build && node --max-old-space-size=256 --expose-gc scripts/soak-cockpit.mjs [seconds]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

if (!global.gc) {
	console.error('run with --expose-gc');
	process.exit(2);
}
const SECONDS = Number(process.argv[2] ?? 90);
const SAMPLE_MS = 3000;
const MARGIN_MB = 20;
const MB = 1024 * 1024;

// State and config of our own, with every real agent off: only the demo fakes can run.
const root = mkdtempSync(join(tmpdir(), 'jc-soak-cockpit-'));
process.env.JARVIS_CODE_STATE = join(root, 'state');
process.env.XDG_CONFIG_HOME = join(root, 'config');
mkdirSync(join(root, 'config', 'jarvis-code'), { recursive: true });
writeFileSync(join(root, 'config', 'jarvis-code', 'config.json'), JSON.stringify({ agents: { claude: { enabled: false }, codex: { enabled: false }, opencode: { enabled: false } } }));

const [{ render }, { createElement }, { loadConfig, merge, normalize }, { Learning }, { RunManager }, { Cockpit }] = await Promise.all([
	import('ink'),
	import('react'),
	import('../dist/src/config.js'),
	import('../dist/src/learn.js'),
	import('../dist/src/runs.js'),
	import('../dist/src/tui/Cockpit.js'),
]);
// Diffs, tool calls and messages shown, so the feed renders the details it is sent.
const config = normalize(merge(loadConfig(root, {}).config, { ui: { showDiffs: true, showTools: true, showText: true } }));
const manager = new RunManager(new Learning(config.learning, join(root, 'learning.json')));

// A wide terminal on both ends: Ink draws every frame into a sink and reads keys from `stdin.type`.
class Stdout extends EventEmitter {
	isTTY = true;
	columns = 300;
	rows = 80;
	write(_s, _enc, cb) {
		(typeof _enc === 'function' ? _enc : cb)?.();
		return true;
	}
}
class Stdin extends EventEmitter {
	isTTY = true;
	data = null;
	type(s) {
		this.data = s;
		this.emit('readable');
		this.emit('data', s);
	}
	read() {
		const d = this.data;
		this.data = null;
		return d;
	}
	setEncoding() {}
	setRawMode() {}
	resume() {}
	pause() {}
	ref() {}
	unref() {}
}
const stdout = new Stdout();
const stdin = new Stdin();

const first = manager.startDemo(true);
const ink = render(createElement(Cockpit, { manager, config, depth: 'truecolor', focus: first, cwd: root, fast: true }), {
	stdout,
	stderr: stdout,
	stdin,
	exitOnCtrlC: false,
	patchConsole: false,
	// In CI Ink would draw only the last frame; the cockpit draws every one.
	interactive: true,
	incrementalRendering: true,
	maxFps: Math.max(1, config.ui.fps),
});

// About 1 MB of diff per event, a fresh string each time as an agent's output is.
const DIFF = Array.from({ length: 16_000 }, (_, i) => `${i % 3 ? '+' : '-'}  const value${i} = compute(${i}); // changed`).join('\n');
let events = 0;
const flood = setInterval(() => {
	const live = manager.active()[0];
	if (!live) return;
	events++;
	const detail = `@@ -${events},6 +${events},6 @@\n${DIFF}`;
	if (events % 2) live.o.note('change', `src/file${events % 50}.ts`, { task: 'T1', detail });
	else live.o.note('text', `message ${events}`, { task: 'T1', detail });
}, 4);

// Demo runs back to back through the prompt, like a person typing /demo; every other one is
// watched from home, so both views and the cross-run feed are drawn.
let demos = 1;
const finished = new Set();
manager.on('finished', (r) => finished.add(r.dir));
const driver = setInterval(async () => {
	if (manager.active().length) return;
	demos++;
	stdin.type('/demo');
	await sleep(20);
	stdin.type('\r');
	if (demos % 2) {
		await sleep(50);
		stdin.type('\x1b');
	}
}, 100);

const samples = [];
const start = Date.now();
while (Date.now() - start < SECONDS * 1000) {
	await sleep(SAMPLE_MS);
	global.gc();
	const { heapUsed, rss } = process.memoryUsage();
	samples.push(heapUsed);
	console.log(`${String(Math.round((Date.now() - start) / 1000)).padStart(4)}s  heap ${(heapUsed / MB).toFixed(1).padStart(6)} MB  rss ${(rss / MB).toFixed(0).padStart(4)} MB  runs ${manager.list().length} (${finished.size} finished)  events ${events}`);
}

clearInterval(flood);
clearInterval(driver);
ink.unmount();
await manager.stopAll();
// Demo runs leave their scratch directories behind: take ours with us.
for (const dir of [...finished, ...manager.list().map((r) => r.dir), root]) rmSync(dir, { recursive: true, force: true });

// A flat heap proves nothing if nothing ran.
if (finished.size < 5 || events < 1000) {
	console.error(`✗ the soak drove too little: ${finished.size} runs finished, ${events} events`);
	process.exit(1);
}

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
};
const third = Math.floor(samples.length / 3);
const middle = median(samples.slice(third, 2 * third));
const last = median(samples.slice(2 * third));
const grew = (last - middle) / MB;
console.log(`median heap: middle third ${(middle / MB).toFixed(1)} MB, last third ${(last / MB).toFixed(1)} MB (${grew >= 0 ? '+' : ''}${grew.toFixed(1)} MB; limit +${MARGIN_MB} MB)`);
if (grew > MARGIN_MB) {
	console.error('✗ the cockpit heap keeps growing');
	process.exit(1);
}
console.log('✓ the cockpit heap levels off');
process.exit(0);
