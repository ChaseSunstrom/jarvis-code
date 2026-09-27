import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

test('README install line works on npm 12: git deps and install scripts must be allowed', () => {
	const line = readme.split('\n').find((l) => l.startsWith('npm install -g') && l.includes('github:ChaseSunstrom/jarvis-code'));
	assert.ok(line, 'no npm install -g line');
	assert.match(line, /--allow-git=all/, 'npm 12 refuses git dependencies without --allow-git');
	assert.match(line, /--allow-scripts=jarvis-code/, 'npm 12 skips the prepare build without --allow-scripts');
});
