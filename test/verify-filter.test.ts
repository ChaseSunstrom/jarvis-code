import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { shell } from '../src/tasks.js';

test('verify filter: a test filter that matches nothing fails the check', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'jc-verify-filter-'));
	writeFileSync(join(dir, 'a.test.mjs'), "import { test } from 'node:test';\ntest('alpha', () => {});\n");

	// --test-isolation=none: node's default per-file process isolation reports a filtered-out
	// file as a trivial pass named after the file, hiding the zero count we need to see.
	const noMatch = await shell('node --test --test-isolation=none --test-name-pattern nomatch a.test.mjs', dir, 30);
	assert.equal(noMatch.ok, false);
	assert.match(noMatch.output, /jarvis-code: the test filter matched no tests, so this check proves nothing$/);

	const matched = await shell('node --test --test-isolation=none --test-name-pattern alpha a.test.mjs', dir, 30);
	assert.equal(matched.ok, true);

	const unfiltered = await shell('node --test a.test.mjs', dir, 30);
	assert.equal(unfiltered.ok, true);
});
