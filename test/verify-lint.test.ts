import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePlan, verifyProblems } from '../src/context.js';
import type { PlannedTask } from '../src/tasks.js';

const t = (acs: { text: string; verify?: string }[]): PlannedTask => ({ key: 'a', title: 'Task', tier: 'S', acs, steps: [] });

test('verify lint: checks that cannot fail are rejected', () => {
	for (const cmd of ['true', ':', 'exit 0', 'echo done', 'echo "all good"'])
		assert.match(verifyProblems(cmd).join(), /always exits 0/, cmd);
	for (const cmd of ['cmd || true', 'cmd || :', 'cmd || echo fallback'])
		assert.match(verifyProblems(cmd).join(), /always succeeds and hides a real failure/, cmd);
	for (const cmd of ['cmd; true', 'cmd; exit 0', 'cmd; echo done'])
		assert.match(verifyProblems(cmd).join(), /hides its exit code/, cmd);
	for (const stage of ['tail', 'head', 'tee', 'cat', 'sort', 'uniq', 'wc', 'sed', 'awk'])
		assert.match(verifyProblems(`node script.js | ${stage} -5`).join(), /hides the exit code/, stage);
	// pipefail before the pipe means the exit code is not actually hidden
	assert.deepEqual(verifyProblems('set -o pipefail; node script.js | tail -5'), []);
	// a real check stays clean even when it is followed unconditionally by another command:
	// a leftover from an earlier task, not a fixture to "fix" here.
	assert.deepEqual(verifyProblems('echo "missing toolchain" >&2; false'), []);
	assert.deepEqual(verifyProblems('cmd && echo ok'), []);
	assert.deepEqual(verifyProblems('cmd | grep -q x'), []);
	assert.deepEqual(verifyProblems('npm test'), []);

	const flagged = validatePlan([t([{ text: 'x', verify: 'true' }])]).join();
	assert.match(flagged, /a "Task": "true" always exits 0/);
});

test('verify lint: one verify per criterion', () => {
	const dup = validatePlan([t([{ text: 'a', verify: 'test -f a' }, { text: 'b', verify: 'test -f a' }])]).join();
	assert.match(dup, /same verify command/);
	const spaced = validatePlan([t([{ text: 'a', verify: 'test -f a' }, { text: 'b', verify: '  test -f   a  ' }])]).join();
	assert.match(spaced, /same verify command/);
	assert.deepEqual(validatePlan([t([{ text: 'a', verify: 'cmd && echo ok' }])]), []);
	assert.deepEqual(validatePlan([t([{ text: 'a', verify: 'cmd | grep -q x' }])]), []);
	assert.deepEqual(validatePlan([t([{ text: 'a', verify: 'test -f a' }, { text: 'b', verify: 'test -f b' }])]), []);
});
