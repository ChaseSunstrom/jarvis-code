import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { codeExcerpts, failureExcerpts } from '../src/excerpt.js';

/** A repo in `<tmp>/repo`, with a secret file next to it (outside the repo) to escape to. */
function fixture(files: Record<string, string>): { root: string; outside: string } {
	const tmp = mkdtempSync(join(tmpdir(), 'jc-excerpt-'));
	const root = join(tmp, 'repo');
	for (const [f, body] of Object.entries(files)) {
		mkdirSync(dirname(join(root, f)), { recursive: true });
		writeFileSync(join(root, f), body);
	}
	const outside = join(tmp, 'outside.ts');
	writeFileSync(outside, 'outside secret\n');
	return { root, outside };
}

const numbered = (name: string, n: number) => Array.from({ length: n }, (_, i) => `const ${name}${i + 1} = ${i + 1};`).join('\n') + '\n';
const task = (title: string, more: { tier?: string; brief?: string; steps?: string[]; acs?: { text: string; verify?: string }[]; files?: string[] } = {}) =>
	({ title, tier: more.tier ?? 'M', brief: more.brief, steps: more.steps ?? [], acs: more.acs ?? [], files: more.files });

test('excerpt: named files and line refs', () => {
	const { root } = fixture({
		'src/a.ts': numbered('a', 100),
		'src/b.ts': numbered('b', 60),
		'test/c.test.ts': 'const typed: string = "source";\n',
		'dist/test/c.test.js': 'const compiled = "build output";\n',
	});
	const out = codeExcerpts(
		task('Fix src/a.ts:20 and src/b.ts', {
			brief: 'The tsc error is at src/a.ts(80,3).',
			steps: ['Create src/new.ts'],
			acs: [{ text: 'c passes', verify: 'npx tsc -p . && node --test dist/test/c.test.js' }],
		}),
		root,
	);
	// ±15 around each ref, merged into one file entry with a gap marker between the windows.
	assert.equal(out.match(/^src\/a\.ts /gm)?.length, 1, out);
	for (const n of [5, 20, 35, 65, 80, 95]) assert.ok(out.includes(`const a${n} = ${n};`), `a${n}`);
	for (const n of [4, 36, 64, 96]) assert.ok(!out.includes(`const a${n} = ${n};`), `a${n}`);
	assert.match(out, /^ 20  const a20 = 20;$/m, 'numbered with the file line');
	assert.match(out, /const a35 = 35;\n…\n 65  const a65/);
	// No ref: the head of the file.
	assert.ok(out.includes('const b40 = 40;') && !out.includes('const b41 = 41;'));
	// The verify command's build output points at its source.
	assert.ok(out.includes('test/c.test.ts') && out.includes('"source"') && !out.includes('build output'));
	assert.ok(out.includes('src/new.ts: does not exist yet (the task may create it)'));
	// First-mention order.
	const at = ['src/a.ts', 'src/b.ts', 'src/new.ts', 'test/c.test.ts'].map((f) => out.indexOf(f));
	assert.deepEqual([...at].sort((x, y) => x - y), at);
	assert.equal(codeExcerpts(task('Tidy the wording'), root), '');
});

test('excerpt: declared files come first', () => {
	const { root } = fixture({ 'src/a.ts': numbered('a', 5), 'src/b.ts': numbered('b', 5), 'src/c.ts': numbered('c', 5) });
	const out = codeExcerpts(task('Fix src/a.ts:2 and src/b.ts', { files: ['src/c.ts', './src/b.ts'] }), root);
	const at = ['src/c.ts', 'src/b.ts', 'src/a.ts'].map((f) => out.indexOf(`${f} (`));
	assert.ok(at.every((i) => i >= 0), out);
	assert.deepEqual([...at].sort((x, y) => x - y), at);
	// A declared file the text also names is excerpted once.
	assert.equal(out.match(/^src\/b\.ts /gm)?.length, 1, out);
});

test('excerpt: budget and unsafe paths', () => {
	const long = Array.from({ length: 200 }, (_, i) => `// ${String(i).padStart(4, '0')} ${'x'.repeat(90)}`).join('\n');
	const files: Record<string, string> = {};
	for (let i = 0; i < 8; i++) files[`src/big${i}.ts`] = long;
	const { root, outside } = fixture({
		...files,
		'.env': 'TOKEN=hunter2\n',
		'config/.env.local': 'TOKEN=hunter2\n',
		'keys/server.pem': 'PRIVATE KEY\n',
		'keys/api.key': 'PRIVATE KEY\n',
		'keys/id_ed25519': 'PRIVATE KEY\n',
		'bin/tool.js': 'binary\0data\n',
	});
	symlinkSync(outside, join(root, 'src/link.ts'));
	symlinkSync(join(root, '.env'), join(root, 'src/notes.ts'));

	const names = Array.from({ length: 8 }, (_, i) => `src/big${i}.ts`).join(' ');
	for (const [tier, budget] of [['S', 4000], ['M', 8000], ['L', 12000]] as const) {
		const out = codeExcerpts(task(`Read ${names}`, { tier }), root);
		assert.ok(out.length <= budget, `${tier}: ${out.length} > ${budget}`);
		assert.ok(out.length > budget - 200, `${tier} uses its budget`);
		assert.ok(out.endsWith('\n… (cut)'), tier);
		assert.ok(!out.includes('src/big7.ts'), `${tier} stops adding files`);
	}

	const unsafe = task(`Read .env config/.env.local keys/server.pem keys/api.key keys/id_ed25519 bin/tool.js src/ keys/ src/link.ts src/notes.ts ../outside.ts src/../../outside.ts ${outside}`, {
		acs: [{ text: 'no secrets', verify: `cat ${outside} /etc/passwd` }],
	});
	assert.equal(codeExcerpts(unsafe, root), '');
});

test('excerpt: backticked symbols resolve to their definitions', () => {
	const files: Record<string, string> = { 'src/frob.ts': 'export function frob(x) {\n\treturn x + 1;\n}\n' };
	for (let i = 0; i < 5; i++) files[`src/many${i}.ts`] = `export function many() {\n\treturn ${i};\n}\n`;
	const { root } = fixture(files);
	execFileSync('git', ['init', '-q'], { cwd: root });
	execFileSync('git', ['add', '.'], { cwd: root });

	const out = codeExcerpts(task('Fix `frob`', { steps: ['Update `frob` to handle zero'] }), root);
	assert.match(out, /export function frob/);

	const miss = codeExcerpts(task('Fix `unknownSymbolXyz`'), root);
	assert.equal(miss, '');

	const capped = codeExcerpts(task('Fix `many`', { tier: 'L' }), root);
	assert.equal((capped.match(/export function many/g) ?? []).length, 3, capped);
});

test('excerpt: failing check locations', () => {
	const { root, outside } = fixture({
		'src/a.ts': numbered('a', 60),
		'src/b.ts': numbered('b', 60),
		'src/c.ts': numbered('c', 5),
		'dist/src/c.js': 'const BUILT_JS_MARKER = 1;\n',
		'src/d.ts': numbered('d', 60),
		'src/e.ts': numbered('e', 60),
	});
	const output = [
		'src/a.ts(45,7): error TS2322: type mismatch',
		'src/b.ts:30:2 assertion failed',
		'    at Object.<anonymous> (dist/src/c.js:3:1)',
		`    at Object.<anonymous> (${join(root, 'src/d.ts')}:15:3)`,
		`    at file://${join(root, 'src/e.ts')}:25:2`,
		`    at Object.<anonymous> (${outside}:1:1)`,
	].join('\n');

	const out = failureExcerpts(output, root);
	// tsc's `path(L,C)`, ±10 lines around the failing line.
	for (const n of [35, 45, 55]) assert.ok(out.includes(`const a${n} = ${n};`), `a${n}`);
	for (const n of [34, 56]) assert.ok(!out.includes(`const a${n} = ${n};`), `a${n}`);
	// `path:L:C`.
	for (const n of [20, 30, 40]) assert.ok(out.includes(`const b${n} = ${n};`), `b${n}`);
	for (const n of [19, 41]) assert.ok(!out.includes(`const b${n} = ${n};`), `b${n}`);
	// A dist/*.js ref names its .ts source; the built JS is never excerpted.
	assert.ok(out.includes('src/c.ts') && out.includes('const c1 = 1;'));
	assert.ok(!out.includes('dist/src/c.js') && !out.includes('BUILT_JS_MARKER'));
	// A stack frame's absolute `(path:L:C)`.
	for (const n of [5, 15, 25]) assert.ok(out.includes(`const d${n} = ${n};`), `d${n}`);
	for (const n of [4, 26]) assert.ok(!out.includes(`const d${n} = ${n};`), `d${n}`);
	// A `file://` URL.
	for (const n of [15, 25, 35]) assert.ok(out.includes(`const e${n} = ${n};`), `e${n}`);
	for (const n of [14, 36]) assert.ok(!out.includes(`const e${n} = ${n};`), `e${n}`);
	// Outside the repo: dropped, not read.
	assert.ok(!out.includes('outside'));

	assert.equal(failureExcerpts('no locations in this output', root), '');

	// Budget: many refs, kept under a small budget.
	const manyRefs = Array.from({ length: 20 }, (_, i) => `src/a.ts:${i * 2 + 1}:1`).join('\n');
	const capped = failureExcerpts(manyRefs, root, 300);
	assert.ok(capped.length <= 300, `${capped.length} > 300`);
	assert.ok(capped.endsWith('… (cut)'), capped);
});
