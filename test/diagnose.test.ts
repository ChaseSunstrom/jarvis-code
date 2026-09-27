import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { diagnose, type Cause } from '../src/diagnose.js';
import { shell, type Check } from '../src/tasks.js';

const ok = (cmd: string): Check => ({ cmd, ok: true, code: 0, output: 'pass' });
const fail = (cmd: string, code?: number, output = 'fail'): Check => ({ cmd, ok: false, code, output });

test('diagnose: each failure gets a cause', () => {
	const cases: { name: string; input: Parameters<typeof diagnose>[0]; cause: Cause }[] = [
		{ name: 'flaky rerun', input: { checks: [fail('npm test')], summary: 'it failed', rerunPassed: true }, cause: 'flaky' },
		{ name: 'bare missing command', input: { checks: [fail('jq . out.json', 127, 'sh: 1: jq: not found')], summary: 'no jq' }, cause: 'bad-check' },
		{ name: 'not executable', input: { checks: [fail('shellcheck lint.sh', 126, 'permission denied')], summary: 'oops' }, cause: 'bad-check' },
		{ name: 'missing agent script is not bad-check', input: { checks: [fail('./script.sh', 127, 'not found')], summary: 'still working' }, cause: 'agent' },
		{ name: 'same failure across routes', input: { checks: [fail('npm test')], summary: 'it failed', sameRoutes: 2 }, cause: 'env' },
		{ name: 'blocked line', input: { checks: [fail('npm test')], summary: 'BLOCKED: need the staging DB password' }, cause: 'missing-context' },
		{ name: 'needs line', input: { checks: [fail('npm test')], summary: 'NEEDS: which endpoint should this call?' }, cause: 'missing-context' },
		{ name: 'mixed pass and fail', input: { checks: [ok('npx tsc -p .'), fail('node --test dist/test/a.test.js')], summary: 'one check failed' }, cause: 'too-big' },
		{ name: 'turn limit', input: { checks: [fail('npm test')], summary: 'stopped', error: 'hit the max turns limit' }, cause: 'too-big' },
		{ name: 'plain agent miss', input: { checks: [fail('npm test')], summary: 'the diff does not compile' }, cause: 'agent' },
	];
	for (const c of cases) assert.equal(diagnose(c.input).cause, c.cause, c.name);
	for (const c of cases) assert.match(diagnose(c.input).why, /\S/, `${c.name}: why`);
	// The why lands in one-line block reasons, notify messages and report table cells.
	assert.equal(diagnose({ checks: [fail('npm test')], summary: '\nFirst line.\nSecond line.' }).why, 'First line.');
});

test('diagnose: transient model and network failures before any check ran', () => {
	for (const error of ['API Error: 529 Overloaded', 'rate_limit_error', 'read ECONNRESET', 'connect ETIMEDOUT 1.2.3.4:443', 'getaddrinfo EAI_AGAIN api.example.com', 'socket hang up', 'Network error', 'HTTP 429 Too Many Requests', 'Rate limit exceeded']) {
		assert.equal(diagnose({ checks: [], summary: '', error }).cause, 'transient', error);
	}
	assert.equal(diagnose({ checks: [], summary: 'server overloaded, gave up' }).cause, 'transient');
	// A check that ran and printed 429 is the task failing, not the agent losing its model.
	assert.equal(diagnose({ checks: [fail('npm test', 1, 'expected 200, got 429')], summary: 'it failed', error: 'status 429' }).cause, 'agent');
	// Usage limits last for hours: the circuit breaker must see them, not a quick retry.
	assert.equal(diagnose({ checks: [], summary: '', error: 'Claude AI usage limit reached (429)' }).cause, 'agent');
	// Word-bounded: a port or id that merely contains 429 is not a status code.
	assert.equal(diagnose({ checks: [], summary: 'listening on 14290' }).cause, 'agent');
	// A plain time-out stays too-big; only ETIMEDOUT with no checks is the network.
	assert.equal(diagnose({ checks: [], summary: 'stopped', error: 'timed out after 600s' }).cause, 'too-big');
});

test('diagnose: order beats a later match', () => {
	// A rerun that passed wins even though the same failure also hit two routes.
	const rerun = diagnose({ checks: [fail('npm test')], summary: 'BLOCKED: need creds', sameRoutes: 3, rerunPassed: true });
	assert.equal(rerun.cause, 'flaky');
	// env (2+ routes) is checked before the BLOCKED line.
	const env = diagnose({ checks: [fail('npm test')], summary: 'BLOCKED: need creds', sameRoutes: 2 });
	assert.equal(env.cause, 'env');
});

test('diagnose: checks carry their exit code', async () => {
	const tmp = mkdtempSync(join(tmpdir(), 'jc-diagnose-'));
	const passed = await shell('exit 0', tmp, 5);
	assert.equal(passed.code, 0);
	const missing = await shell('jc-no-such-command-xyz', tmp, 5);
	assert.equal(missing.ok, false);
	assert.equal(missing.code, 127);
});
