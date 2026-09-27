import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relevantLessons } from '../src/orchestrator.js';

const task = (over: Partial<{ title: string; type: string; steps: string[]; brief: string; acs: { text: string; verify?: string }[] }> = {}) => ({
	title: 'Fix the excerpt reader',
	type: 'FIX',
	steps: ['read src/excerpt.ts', 'add a guard'],
	brief: 'excerpt() mishandles symlinks',
	acs: [{ text: 'symlinks are rejected', verify: 'npm test' }],
	...over,
});

test('lessons: the ones that share words with the task come first', () => {
	// newest first, as Project.lessons() returns them
	const lessons = [
		'unrelated newest lesson about deploy timing',
		'another unrelated lesson about the tui reactor',
		'excerpt() in src/excerpt.ts already handles symlink-escape safety',
	];
	const ranked = relevantLessons(lessons, task());
	assert.equal(ranked[0], 'excerpt() in src/excerpt.ts already handles symlink-escape safety', 'the lesson sharing words/paths with the task ranks first, despite being oldest');
	assert.ok(ranked.length <= 5);

	const many = Array.from({ length: 8 }, (_, i) => `unrelated lesson number ${i}`);
	assert.equal(relevantLessons(many, task()).length, 5, 'at most 5 lessons come back');

	const noOverlap = ['oldest unrelated lesson', 'middle unrelated lesson', 'newest unrelated lesson'];
	assert.deepEqual(relevantLessons(noOverlap, task()), noOverlap.slice(0, 5), 'no overlap: newest-first input order is kept');
});
