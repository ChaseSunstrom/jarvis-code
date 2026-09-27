import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Cause } from '../src/diagnose.js';
import { replanPrompt } from '../src/orchestrator.js';
import type { Task } from '../src/tasks.js';

const task: Task = {
	id: 'T-0001',
	title: 'Do the thing',
	type: 'FIX',
	tier: 'S',
	acs: [{ text: 't1 exists', verify: 'test -f out/t1.done' }],
	steps: ['do it'],
};

test('replan prompt: guidance follows the diagnosed cause', () => {
	for (const cause of ['bad-check', 'env', 'flaky'] as Cause[]) {
		const p = replanPrompt(task, '/repo', 'it failed', undefined, [], cause);
		assert.match(p, /fix|replace.*verify command/is, `${cause}: mentions fixing/replacing the verify command`);
		assert.match(p, /\{"tasks":\[\]\}/, `${cause}: offers no tasks for a person to fix the environment`);
		assert.doesNotMatch(p, /split it into 2-4/, `${cause}: does not ask for a split for size`);
	}

	const tooBig = replanPrompt(task, '/repo', 'it failed', undefined, [], 'too-big');
	assert.match(tooBig, /split it into 2-4 smaller tasks/);

	const missing = replanPrompt(task, '/repo', 'it failed', undefined, [], 'missing-context');
	assert.match(missing, /missing facts.*notes/is);

	const none = replanPrompt(task, '/repo', 'it failed');
	assert.match(none, /split it into 2-4 smaller tasks/, 'no diagnosed cause falls back to the general instruction');
	assert.match(none, /\{"tasks":\[\]\}/);
});

test('replan prompt: every attempt is listed', () => {
	const history = ['Attempt 1 on claude:fable (agent): the agent did not satisfy the checks', 'Attempt 2 on codex:default (too-big): some checks passed and some failed'];
	const p = replanPrompt(task, '/repo', 'it failed', undefined, history);
	for (const h of history) assert.ok(p.includes(h), `history line kept: ${h}`);
});
