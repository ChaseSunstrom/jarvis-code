import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handoffNotes, retryNote, WORKER_CONTEXT } from '../src/orchestrator.js';

test('handoff: TRIED and NEXT lines, deduped, "none" ignored, at most 5 of each', () => {
	const text = [
		'Could not finish.',
		'- TRIED: **patching** the parser',
		'TRIED: patching the parser',
		'NEXT: none',
		'next: fix the lexer first',
		'not a TRIED: line',
		...Array.from({ length: 7 }, (_, i) => `TRIED: idea ${i}`),
	].join('\n');
	assert.deepEqual(handoffNotes(text), [
		'TRIED: patching the parser',
		'TRIED: idea 0',
		'TRIED: idea 1',
		'TRIED: idea 2',
		'TRIED: idea 3',
		'NEXT: fix the lexer first',
	]);
	assert.deepEqual(handoffNotes('done\nLESSON: x'), []);
});

test('handoff: TRIED and NEXT lines lead the retry note', () => {
	const handoff = ['TRIED: patching the parser', 'NEXT: fix the lexer first'];
	const note = retryNote({
		attempt: 1,
		route: 'claude:x',
		reason: 'check failed: false',
		checks: [{ cmd: 'true', ok: true, output: '' }, { cmd: 'false', ok: false, output: 'boom' }],
		handoff,
	});
	assert.ok(note.startsWith("The last worker's handoff (their notes; check before relying on them):\n- TRIED: patching the parser\n- NEXT: fix the lexer first\n\n"));
	assert.ok(note.indexOf('NEXT:') < note.indexOf('Attempt 1') && note.indexOf('Attempt 1') < note.indexOf('- FAILED: `false`'));
	const reviewed = retryNote({ attempt: 2, route: 'claude:x', reason: '', checks: [], findings: ['add a test'], handoff });
	assert.ok(reviewed.startsWith("The last worker's handoff"));
	assert.ok(!retryNote({ attempt: 1, route: 'claude:x', reason: 'agent failed', checks: [], handoff: [] }).includes('handoff'));
});

test('handoff: workers are asked for the lines', () => {
	assert.match(WORKER_CONTEXT, /"TRIED: <approach and what happened>" and "NEXT: <what you would try next>"/);
	assert.match(WORKER_CONTEXT, /uncommitted changes already in the tree .*are intended: build on them and do not revert them/);
});
