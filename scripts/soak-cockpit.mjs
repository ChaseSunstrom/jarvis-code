#!/usr/bin/env node
// Soak test for the cockpit's memory. Renders the real Cockpit with Ink, set up as cli.ts does it
// (incremental rendering at ui.fps), into a fake 300x80 terminal. One demo run stays live for the
// whole soak (paused, so it never finishes) while fast demo runs go back to back beside it, and
// both are flooded with ~1 MB diffs and messages, the way a chatty agent does. After
// a full GC every few seconds it samples heapUsed. Then a quiet phase, the session the crash came
// from: one demo run at normal pace, focused, so the reactor animates at ui.fps while few events
// arrive and only per-frame retention can grow the heap. Exits 1 when the heap still grows over
// the last third of either phase, or React left performance measures behind (its development
// build); an OOM under --max-old-space-size fails it too. A line fitted to the animating samples
// projects the heap to an hour of animating, and over 1 GB fails it.
//
//   npm run build && node --max-old-space-size=256 --expose-gc scripts/soak-cockpit.mjs [burst seconds] [animating seconds]
//
// The animating phase is at least 60 s (75 by default); a long one, such as 300, tightens the
// hour projection.
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
const ANIMATE_SECONDS = Math.max(60, Number(process.argv[3] ?? 75));
const SAMPLE_MS = 3000;
const MARGIN_MB = 20;
const MB = 1024 * 1024;

// State and config of our own, with every real agent off: only the demo fakes can run.
const root = mkdtempSync(join(tmpdir(), 'jc-soak-cockpit-'));
process.env.JARVIS_CODE_STATE = join(root, 'state');
process.env.XDG_CONFIG_HOME = join(root, 'config');
mkdirSync(join(root, 'config', 'jarvis-code'), { recursive: true });
writeFileSync(join(root, 'config', 'jarvis-code', 'config.json'), JSON.stringify({ agents: { claude: { enabled: false }, codex: { enabled: false }, opencode: { enabled: false } } }));

// Ink, React and the cockpit as cli.ts loads them: React's production build, picked on first import.
const { loadCockpit } = await import('../dist/src/tui/load.js');
const [{ render }, { createElement }, { Cockpit }] = await loadCockpit();
const [{ loadConfig, merge, normalize }, { Learning }, { RunManager }] = await Promise.all([
	import('../dist/src/config.js'),
	import('../dist/src/learn.js'),
	import('../dist/src/runs.js'),
]);
// Diffs, tool calls and messages shown, so the feed renders the details it is sent.
const config = normalize(merge(loadConfig(root, {}).config, { ui: { showDiffs: true, showTools: true, showText: true } }));
const manager = new RunManager(new Learning(config.learning, join(root, 'learning.json')));

// A wide terminal on both ends: Ink draws every frame into a sink and reads keys from `stdin.type`.
class Stdout extends EventEmitter {
	isTTY = true;
	columns = 300;
	rows = 80;
	frames = 0;
	write(_s, _enc, cb) {
		this.frames++;
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
const inkOptions = (stdout, stdin) => ({
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

/** Samples heapUsed after a full GC every SAMPLE_MS for `seconds`, logging each with `status()`. */
async function sample(seconds, status) {
	const samples = [];
	const start = Date.now();
	while (Date.now() - start < seconds * 1000) {
		await sleep(SAMPLE_MS);
		global.gc();
		const { heapUsed, rss } = process.memoryUsage();
		samples.push(heapUsed);
		console.log(`${String(Math.round((Date.now() - start) / 1000)).padStart(4)}s  heap ${(heapUsed / MB).toFixed(1).padStart(6)} MB  rss ${(rss / MB).toFixed(0).padStart(4)} MB  ${status()}`);
	}
	return samples;
}
const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
};
/** Median heap of the first, middle and last third of the samples. */
const thirds = (samples) => {
	const n = Math.floor(samples.length / 3);
	return [samples.slice(0, n), samples.slice(n, 2 * n), samples.slice(2 * n)].map(median);
};
const failures = [];
/** Records a failure when the heap grew by more than MARGIN_MB from `from` to `to`. */
function levels(what, from, to, labels) {
	const grew = (to - from) / MB;
	console.log(`median heap (${what}): ${labels[0]} ${(from / MB).toFixed(1)} MB, ${labels[1]} ${(to / MB).toFixed(1)} MB (${grew >= 0 ? '+' : ''}${grew.toFixed(1)} MB; limit +${MARGIN_MB} MB)`);
	if (grew > MARGIN_MB) failures.push(`the cockpit heap keeps growing (${what})`);
}

// The long run: a leak inside one run grows only while that run lives.
const long = manager.startDemo(true);
long.o.togglePause();
const ink = render(createElement(Cockpit, { manager, config, depth: 'truecolor', focus: long, cwd: root, fast: true }), inkOptions(stdout, stdin));

// About 1 MB of diff per event, a fresh string each time as an agent's output is.
const DIFF = Array.from({ length: 16_000 }, (_, i) => `${i % 3 ? '+' : '-'}  const value${i} = compute(${i}); // changed`).join('\n');
let events = 0;
const short = () => manager.active().find((r) => r !== long);
const flood = setInterval(() => {
	events++;
	// Every other event to the long run, the rest to the short run of the moment.
	const live = events % 4 < 2 ? long : (short() ?? long);
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
	if (short()) return;
	demos++;
	stdin.type('/demo');
	await sleep(20);
	stdin.type('\r');
	if (demos % 2) {
		await sleep(50);
		stdin.type('\x1b');
	}
}, 100);

const burst = await sample(SECONDS, () => `runs ${manager.list().length} (${finished.size} finished)  events ${events}  frames ${stdout.frames}`);

const longLived = !long.finished;
clearInterval(flood);
clearInterval(driver);
ink.unmount();
await manager.stopAll();

// A flat heap proves nothing if nothing ran.
if (finished.size < 5 || events < 1000 || stdout.frames < SECONDS || !longLived) {
	failures.push(`the burst drove too little: ${finished.size} runs finished, ${events} events, ${stdout.frames} frames, the long run ${longLived ? 'lived' : 'ended early'}`);
}
const [, middle, last] = thirds(burst);
levels('burst', middle, last, ['middle third', 'last third']);

// The quiet phase: a demo at normal pace, its dashboard open, so the reactor animates and the
// cockpit draws at ui.fps, stepping through the run's views with Tab. A demo that ends early is followed by the next, focused the same way.
const screen = new Stdout();
let run = manager.startDemo(false);
const focused = (run) => createElement(Cockpit, { key: run.id, manager, config, depth: 'truecolor', focus: run, cwd: root });
const calmIn = new Stdin();
const calm = render(focused(run), inkOptions(screen, calmIn));
// Every view of the run (graph, tree, timeline, stats, ideas) takes its turn while it animates.
const cycle = setInterval(() => calmIn.type('\t'), 5000);
const onFinished = (r) => {
	if (r !== run) return;
	run = manager.startDemo(false);
	calm.rerender(focused(run));
};
manager.on('finished', onFinished);
const quiet = await sample(ANIMATE_SECONDS, () => `demo ${run.id} ${run.o.snapshot().reactor}  frames ${screen.frames}`);
manager.off('finished', onFinished);
clearInterval(cycle);
calm.unmount();
await manager.stopAll();
const measures = performance.getEntriesByType('measure').length;
// Demo runs leave their scratch directories behind: take ours with us.
for (const dir of [...finished, ...manager.list().map((r) => r.dir), root]) rmSync(dir, { recursive: true, force: true });

console.log(`animating: ${screen.frames} frames`);
console.log(`measures: ${measures}`);
const [first, , end] = thirds(quiet);
levels('animating', first, end, ['first third', 'last third']);
// Least-squares line of heap MB against minutes since the quiet phase began, projected to an hour.
const xs = quiet.map((_, i) => ((i + 1) * SAMPLE_MS) / 60000);
const ys = quiet.map((h) => h / MB);
const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
const my = ys.reduce((a, b) => a + b, 0) / ys.length;
const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
const projected = my - slope * mx + Math.max(slope, 0) * 60;
console.log(`animating slope: ${slope >= 0 ? '+' : ''}${slope.toFixed(2)} MB/min; projected heap after 60 min: ${projected.toFixed(1)} MB (the pasted crash hit ~4050 MB)`);
if (projected > 1024) failures.push('the cockpit heap would pass 1 GB within an hour');
// At ui.fps the reactor draws a frame per tick; far fewer means it mostly stood still.
if (screen.frames < (ANIMATE_SECONDS * config.ui.fps) / 2) failures.push(`the reactor barely animated: ${screen.frames} frames in ${ANIMATE_SECONDS} s`);
if (measures > 0) failures.push(`${measures} performance measures left behind: React's development build is loaded`);

for (const f of failures) console.error(`✗ ${f}`);
if (failures.length) process.exit(1);
console.log('✓ the cockpit heap levels off');
process.exit(0);
