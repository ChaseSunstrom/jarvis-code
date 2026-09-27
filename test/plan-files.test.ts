import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validatePlan } from '../src/context.js';
import { parsePlan, plannerPrompt, replanPrompt } from '../src/orchestrator.js';
import type { PlannedTask } from '../src/tasks.js';

const t = (files: string[], steps: string[] = [], tier = 'S'): PlannedTask => ({ key: 'a', title: 'Task', tier, acs: [{ text: 'x', verify: 'npm test' }], steps, files });

function tree(): string {
	const dir = mkdtempSync(join(tmpdir(), 'jc-plan-files-'));
	mkdirSync(join(dir, 'src'));
	writeFileSync(join(dir, 'src', 'a.ts'), '');
	writeFileSync(join(dir, 'src', 'b.ts'), '');
	writeFileSync(join(dir, 'src', 'c.ts'), '');
	return dir;
}

test('plan files: invented paths are flagged unless a step creates them', () => {
	const dir = tree();
	try {
		assert.deepEqual(validatePlan([t(['src/a.ts'])], dir), []);
		assert.match(validatePlan([t(['src/nope.ts'])], dir).join(), /"src\/nope.ts", which does not exist: fix the path, or add a step that creates it/);
		// a step only mentioning the path does not make it new
		assert.match(validatePlan([t(['src/nope.ts'], ['Edit src/nope.ts'])], dir).join(), /does not exist/);
		for (const step of ['Create src/nope.ts', 'Add src/nope.ts with the parser', 'Write src/nope.ts', 'A new file src/nope.ts'])
			assert.deepEqual(validatePlan([t(['src/nope.ts'], [step])], dir), [], step);
		for (const f of ['/etc/passwd', '../outside.ts', 'src/../../outside.ts'])
			assert.match(validatePlan([t([f], [`Create ${f}`])], dir).join(), /outside the repository: list paths relative to the repository root/, f);
		// without a cwd the paths are not checked, and a plan without files stays valid
		assert.deepEqual(validatePlan([t(['src/nope.ts'])]), []);
		assert.deepEqual(validatePlan([{ key: 'a', title: 'Task', acs: [{ text: 'x', verify: 'npm test' }] }], dir), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('plan files: an S task over more than 2 files is flagged', () => {
	const dir = tree();
	try {
		const three = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
		assert.match(validatePlan([t(three)], dir).join(), /is tier S but lists 3 files .*make it M or split it/);
		// no tier means S
		assert.match(validatePlan([{ ...t(three), tier: undefined }], dir).join(), /make it M or split it/);
		assert.deepEqual(validatePlan([t(three, [], 'M')], dir), []);
		assert.deepEqual(validatePlan([t(three.slice(0, 2))], dir), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('plan files: prompts ask for files and parsePlan keeps them as strings', () => {
	assert.match(plannerPrompt('g', '/r'), /"files"/);
	assert.match(replanPrompt({ id: 'T-0001', title: 'x', type: 'FIX', tier: 'S', acs: [], steps: [] }, '/r', 'why'), /"files"/);
	assert.deepEqual(parsePlan('{"tasks":[{"title":"A","files":["src/a.ts",3]}]}')?.[0].files, ['src/a.ts', '3']);
	assert.equal(parsePlan('{"tasks":[{"title":"A","files":"src/a.ts"}]}')?.[0].files, undefined);
});

test('plan files: a verify command running an npm run script package.json lacks is flagged', () => {
	const dir = tree();
	try {
		const v = (verify: string, files: string[] = []): PlannedTask => ({ key: 'a', title: 'Task', acs: [{ text: 'x', verify }], steps: [], files });
		assert.deepEqual(validatePlan([v('npm run lint')], dir), [], 'no package.json, no check');
		writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'x', build: 'y' } }));
		assert.match(validatePlan([v('npm run lint')], dir).join(), /runs "npm run lint", but package.json has no "lint" script \(it has: test, build\)/);
		for (const cmd of ['pnpm run lint', 'yarn run lint', 'npm run-script lint', 'npm run build && npm run lint'])
			assert.match(validatePlan([v(cmd)], dir).join(), /no "lint" script/, cmd);
		assert.deepEqual(validatePlan([v('npm run build && npm test')], dir), []);
		// the task adds the script itself
		assert.deepEqual(validatePlan([v('npm run lint', ['package.json'])], dir), []);
		// without a cwd nothing is read
		assert.deepEqual(validatePlan([v('npm run lint')]), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
