#!/usr/bin/env node
// Runs `jarvis-code demo` in a real pseudo-terminal (util-linux `script`), replays its output
// into a headless xterm, samples the screen every 100 ms and checks that the arc reactor
// animates while tasks run and holds still once the run is over.
//
//   node scripts/verify-reactor.mjs [--dump FILE]   (FILE: a mid-run screen, as ANSI)
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import xterm from '@xterm/headless';

const COLS = 120;
const ROWS = 40;
const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
const dumpAt = process.argv.indexOf('--dump');
const dumpFile = dumpAt > 0 ? process.argv[dumpAt + 1] : undefined;

const term = new xterm.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
const child = spawn('script', ['-qfec', `stty cols ${COLS} rows ${ROWS}; exec node ${JSON.stringify(cli)} demo`, '/dev/null'], {
	stdio: ['pipe', 'pipe', 'inherit'],
	env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', NO_COLOR: '' },
});
child.stdout.on('data', (d) => term.write(d));

const lines = () => Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '');
/** The braille block (the reactor) in the header: every braille cell, in reading order. */
const reactor = (ls) => ls.slice(0, 20).map((l) => l.replace(/[^⠀-⣿]/g, ' ').trimEnd()).join('\n');
const braille = (s) => (s.match(/[⠀-⣿]/g) ?? []).length;
const state = (ls) => ls.slice(0, 20).join(' ').match(/\b(PLANNING|WORKING|ALERT|FINISHED[^ ]*)\b/)?.[1] ?? '?';

/** Braille cells painted in 24-bit colour: the reactor's truecolor path was taken. */
function rgbReactorCells() {
	let n = 0;
	const cell = term.buffer.active.getNullCell();
	for (let y = 0; y < 20; y++) {
		const line = term.buffer.active.getLine(y);
		for (let x = 0; x < COLS; x++) {
			line.getCell(x, cell);
			if (/[\u2800-\u28ff]/.test(cell.getChars()) && cell.isFgRGB()) n++;
		}
	}
	return n;
}

/** The screen with its colours, for a human to look at. */
function ansiScreen() {
	const out = [];
	const cell = term.buffer.active.getNullCell();
	for (let y = 0; y < ROWS; y++) {
		const line = term.buffer.active.getLine(y);
		let s = '';
		for (let x = 0; x < COLS; x++) {
			line.getCell(x, cell);
			const ch = cell.getChars() || ' ';
			if (cell.isFgRGB()) {
				const c = cell.getFgColor();
				s += `\x1b[38;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}m${ch}`;
			} else s += `\x1b[0m${ch}`;
		}
		out.push(s + '\x1b[0m');
	}
	return out.join('\n');
}

const samples = [];
let rgbCells = 0;
let finishedAt = 0;
let dumped = false;
const started = Date.now();
const timer = setInterval(() => {
	const ls = lines();
	const s = { t: Date.now() - started, state: state(ls), reactor: reactor(ls) };
	samples.push(s);
	if (s.state === 'WORKING') rgbCells = Math.max(rgbCells, rgbReactorCells());
	if (dumpFile && !dumped && s.state === 'WORKING' && s.t > 6000) {
		writeFileSync(dumpFile, ansiScreen());
		dumped = true;
	}
	if (!finishedAt && s.state.startsWith('FINISHED')) finishedAt = Date.now();
	if (finishedAt && Date.now() - finishedAt > 2500) {
		clearInterval(timer);
		child.stdin.write('q');
	}
	if (Date.now() - started > 120_000) {
		clearInterval(timer);
		child.kill();
		fail('timed out waiting for the demo to finish');
	}
}, 100);

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exit(1);
}

child.on('exit', (code) => {
	clearInterval(timer);
	const working = samples.filter((s) => s.state === 'WORKING' || s.state === 'PLANNING' || s.state === 'ALERT');
	const done = samples.filter((s) => s.state.startsWith('FINISHED')).slice(-12);
	const distinct = new Set(working.map((s) => s.reactor)).size;
	let changes = 0;
	for (let i = 1; i < working.length; i++) if (working[i].reactor !== working[i - 1].reactor) changes++;
	const cells = Math.max(0, ...samples.map((s) => braille(s.reactor)));
	const report = {
		exit: code,
		samples: samples.length,
		runningSamples: working.length,
		distinctRunningFrames: distinct,
		changedBetweenSamples: `${changes}/${Math.max(0, working.length - 1)}`,
		reactorCells: cells,
		stillWhenFinished: new Set(done.map((s) => s.reactor)).size === 1,
		truecolorCells: rgbCells,
	};
	console.log(JSON.stringify(report, null, 2));
	if (code !== 0) fail(`demo exited ${code}`);
	if (working.length < 20) fail(`only ${working.length} samples while running`);
	if (cells < 150) fail(`the large reactor was not drawn (${cells} braille cells)`);
	if (changes < (working.length - 1) * 0.8) fail(`the reactor changed in only ${changes}/${working.length - 1} consecutive samples while running`);
	if (done.length < 10 || !report.stillWhenFinished) fail('the reactor kept moving after the run finished');
	if (rgbCells < 100) fail(`the reactor was not painted in truecolor (${rgbCells} cells)`);
	console.log('✓ the arc reactor animates while tasks run and holds still when they are done');
});
