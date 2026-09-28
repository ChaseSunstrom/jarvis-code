import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// React picks its build on first require, and this runner has loaded the dev build already
// (test/tui.test.ts), so each case renders in a fresh child with NODE_ENV removed.
function renderIn(load: string) {
	const code = `
		import { Writable } from 'node:stream';
		import { setTimeout as sleep } from 'node:timers/promises';
		const [{ render, Text }, { createElement }] = ${load};
		const stdout = Object.assign(new Writable({ write: (_c, _e, cb) => cb() }), { columns: 80, rows: 24, isTTY: true });
		const ink = render(createElement(Text, null, 'frame 0'), { stdout, patchConsole: false });
		for (let i = 1; i <= 50; i++) {
			ink.rerender(createElement(Text, null, 'frame ' + i));
			await sleep(2);
		}
		ink.unmount();
		console.log(JSON.stringify({ measures: performance.getEntriesByType('measure').length, env: process.env.NODE_ENV ?? null }));
	`;
	const env = { ...process.env };
	delete env.NODE_ENV;
	const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { measures: number; env: string | null };
}

test('loadCockpit loads the production build and restores NODE_ENV', () => {
	const url = (spec: string) => JSON.stringify(import.meta.resolve(spec));
	const control = renderIn(`await Promise.all([import(${url('ink')}), import(${url('react')})])`);
	assert.ok(control.measures > 0, `the dev build should record measures (the leak), got ${control.measures}`);
	const loaded = new URL('../src/tui/load.js', import.meta.url).href;
	const fixed = renderIn(`await (await import(${JSON.stringify(loaded)})).loadCockpit()`);
	assert.deepEqual(fixed, { measures: 0, env: null }, `control recorded ${control.measures} measures`);
});
