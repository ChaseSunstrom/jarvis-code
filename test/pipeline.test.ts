import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coveragePrompt, critiquePrompt, ideasMarkdown, improveGoal, newIdeas, nextRound, parseBrief, parseCoverage, parseScores, planningContext, promptWriterPrompt, rank, words, type Idea } from '../src/pipeline.js';

test('idea merge: near-duplicate titles merge into the kept idea, distinct ones stay', () => {
	assert.deepEqual([...words('Add the Dark-mode toggles to UI')], ['dark', 'mode', 'toggle']);
	const seen: Idea[] = [{ title: 'Add a dark mode toggle' }];
	const fresh = newIdeas(seen, [{ title: 'Dark mode toggle' }, { title: 'Add caching' }, { title: 'Add logging' }, { title: 'add CACHING!' }, { title: 'Caching' }]);
	assert.deepEqual(fresh.map((i) => i.title), ['Add caching', 'Add logging']);
	assert.equal(seen[0].merged, 1, 'the seen idea counts its near-duplicate');
	assert.equal(fresh[0].merged, 2, 'an exact normalized duplicate and a same-words title both merge into the earlier idea');
	assert.equal(fresh[1].merged, undefined);
	assert.deepEqual(newIdeas([], [{ title: 'Retry failed uploads' }, { title: 'Retry failed downloads' }]).length, 2, 'Jaccard 0.5 stays apart');
	assert.deepEqual(newIdeas([], [{ title: 'a b' }, { title: 'A B' }, { title: 'c d' }]).map((i) => i.title), ['a b', 'c d'], 'stopword-only titles still dedupe exactly');
	const ctx = planningContext(undefined, [...seen, ...fresh]);
	assert.match(ctx, /- Add a dark mode toggle \(\+1 similar\)/);
	assert.match(ctx, /- Add caching \(\+2 similar\)/);
	assert.doesNotMatch(ctx, /Add logging \(\+/);
	assert.match(ideasMarkdown('g', seen), /\*\*Add a dark mode toggle\*\* \(\+1 similar\)/);
});

test('critique scores: the critic numbers ideas, scores parse strictly, and rank orders by value*2 - effort - risk', () => {
	const ideas: Idea[] = [{ title: 'A', lens: 'x' }, { title: 'B', why: 'cites src/b.ts', lens: 'x' }, { title: 'C', lens: 'y' }, { title: 'D', lens: 'y' }];
	const p = critiquePrompt('improve it', 'the brief', ideas);
	assert.ok(p.startsWith('JARVIS-CODE CRITIQUE'));
	assert.match(p, /^1\. A$/m);
	assert.match(p, /^2\. B: cites src\/b\.ts$/m);
	assert.match(p, /read-only/);
	assert.match(p, /cited files don't exist/);
	assert.match(p, /\{"scores":\[\{"n":1,"value":5,"effort":2,"risk":1,"note":"\.\.\."\}\]\}/);

	const reply = `Here you go:\n\`\`\`json\n${JSON.stringify({
		scores: [
			{ n: 1, value: 2, effort: 1, risk: 1 },
			{ n: 2, value: 5, effort: 2, risk: 1, note: ' solid ' },
			{ n: 3, value: 6, effort: 1, risk: 1 },
			{ n: 4, value: 3.5, effort: 1, risk: 1 },
			{ n: 5, value: 5, effort: 1, risk: 1 },
			{ n: 0, value: 5, effort: 1, risk: 1 },
			{ n: 1, value: 5, effort: 1, risk: 1 },
			{ n: 3, value: '5', effort: 1, risk: 1 },
		],
	})}\n\`\`\``;
	const scores = parseScores(reply, 4)!;
	assert.deepEqual(scores, [
		{ n: 1, value: 2, effort: 1, risk: 1 },
		{ n: 2, value: 5, effort: 2, risk: 1, note: 'solid' },
	]);
	assert.equal(parseScores('I think they are all fine.', 4), undefined);
	assert.equal(parseScores('{"scores":"none"}', 4), undefined);
	assert.equal(parseScores('{"scores":[{"n":9,"value":1,"effort":1,"risk":1}]}', 4), undefined, 'nothing usable');

	const ranked = rank(ideas, [...scores, { n: 4, value: 5, effort: 1, risk: 1 }]);
	assert.deepEqual(ranked.map((i) => [i.title, i.score]), [['D', 8], ['B', 7], ['A', 2], ['C', undefined]]);
	assert.deepEqual(rank([{ title: 'P' }, { title: 'Q' }, { title: 'R' }], [{ n: 2, value: 1, effort: 1, risk: 1 }]).map((i) => i.title), ['Q', 'P', 'R'], 'unscored keep their order, after the scored');
	assert.equal(ideas[0].score, undefined, 'rank does not mutate its input');

	const ctx = planningContext(undefined, ranked);
	assert.match(ctx, /ranked by a critic/);
	assert.match(ctx, /- B \[v5 e2 r1\]: cites src\/b\.ts Critic: solid \(x\)/);
	assert.match(ctx, /- C \(y\)/);
	assert.doesNotMatch(planningContext(undefined, ideas), /ranked by a critic/);
	assert.match(ideasMarkdown('g', ranked), /\*\*B\*\* \(x, .*, v5 e2 r1, score 7\): cites src\/b\.ts Critic: solid/);
});

test('coverage parse: the brief carries done items, and coverage answers parse per item', () => {
	const w = promptWriterPrompt('add a status page', '/repo');
	assert.match(w, /3-8 items the user would call done/);
	assert.match(w, /"done":\["\.\.\."\]/);
	const many = Array.from({ length: 15 }, (_, i) => `item ${i}`);
	assert.deepEqual(parseBrief(JSON.stringify({ brief: 'b', kind: 'open', lenses: [], done: [' page loads ', 3, '', ...many] }))?.done, ['page loads', ...many.slice(0, 11)]);
	assert.deepEqual(parseBrief('{"brief":"b"}')?.done, []);

	const p = coveragePrompt('add a status page', ['the page loads', 'npm test passes'], [{ id: 'T-0001', title: 'Add the page', note: 'added src/status.ts' }]);
	assert.ok(p.startsWith('JARVIS-CODE COVERAGE'));
	assert.match(p, /^1\. the page loads$/m);
	assert.match(p, /^2\. npm test passes$/m);
	assert.match(p, /^- T-0001 Add the page: added src\/status\.ts$/m);
	assert.match(p, /\{"items":\[\{"n":1,"met":true,"tasks":\["T-1"\],"missing":""\}\]\}/);
	assert.match(coveragePrompt('g', ['x'], []), /^- none$/m);

	const reply = JSON.stringify({
		items: [
			{ n: 1, met: true, tasks: ['T-0001', 7, ' '], missing: '' },
			{ n: 2, met: false, missing: ' no test for the page ' },
			{ n: 2, met: true },
			{ n: 3, met: true },
			{ n: 1.5, met: true },
			{ n: 1, met: 'yes' },
		],
	});
	assert.deepEqual(parseCoverage(`Checked.\n${reply}`, 2), [
		{ n: 1, met: true, tasks: ['T-0001'], missing: '' },
		{ n: 2, met: false, tasks: [], missing: 'no test for the page' },
	]);
	assert.equal(parseCoverage('all good!', 2), undefined);
	assert.equal(parseCoverage('{"items":[{"n":1}]}', 2), undefined);
});

test('next round: the improve loop ends stopped, dry or at its round cap, and each goal builds on the last round', () => {
	const r = { round: 1, rounds: 3, landed: 2, minLanded: 1, stopped: false };
	assert.equal(nextRound(r), undefined);
	assert.equal(nextRound({ ...r, stopped: true }), 'stopped', 'a capped or stopped run ends the loop');
	assert.equal(nextRound({ ...r, landed: 0 }), 'dry');
	assert.equal(nextRound({ ...r, landed: 0, minLanded: 0 }), undefined, '--min 0 never runs dry');
	assert.equal(nextRound({ ...r, round: 3 }), 'rounds');
	assert.equal(nextRound({ ...r, round: 3, landed: 0 }), 'dry', 'a dry last round says so');

	const first = improveGoal('the docs');
	assert.match(first, /^Improve this project, focusing on the docs:/);
	assert.doesNotMatch(first, /previous round/);
	const next = improveGoal(undefined, ['Add a status page', 'FIX: the retry loop']);
	assert.match(next, /previous round built: "Add a status page"; "FIX: the retry loop"\./);
	assert.match(next, /without redoing it/);
	assert.match(next, /needs users have not stated but will want/);
	assert.doesNotMatch(next, /\n/, 'one line: a title must not read as an intake tag');
	assert.doesNotMatch(next, /jarvis-code/i, 'it runs on the user\'s project, not jarvis-code\'s source');
});
