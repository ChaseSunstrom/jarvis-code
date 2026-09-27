import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { contextPack } from '../src/context.js';

test('context pack: conventions file and files by directory, within the size limit', () => {
	const dir = mkdtempSync(join(tmpdir(), 'jc-context-pack-'));
	try {
		execFileSync('git', ['init', '-q'], { cwd: dir });
		writeFileSync(join(dir, 'CLAUDE.md'), `# Rules\nMARKER: tabs, not spaces\n${'x'.repeat(20000)}\n`);
		mkdirSync(join(dir, 'src'));
		mkdirSync(join(dir, 'test'));
		writeFileSync(join(dir, 'src', 'a.ts'), '');
		writeFileSync(join(dir, 'src', 'b.ts'), '');
		writeFileSync(join(dir, 'test', 'a.test.ts'), '');
		// Staged is enough for ls-files, and needs no git identity.
		execFileSync('git', ['add', '-A'], { cwd: dir });
		const pack = contextPack(dir, { workers: ['claude'] });
		assert.match(pack, /Conventions \(CLAUDE\.md, first lines\):\n# Rules\nMARKER: tabs, not spaces/);
		assert.match(pack, /Files by directory \(git ls-files\):\nsrc\/ 2 · test\/ 1/);
		assert.ok(pack.length <= 6000, `pack is ${pack.length} chars`);
		assert.ok(pack.indexOf('Workers available') < pack.indexOf('Conventions'), 'new sections come last, so the size limit trims them first');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
