import type { Check } from './tasks.js';

export type Cause = 'flaky' | 'bad-check' | 'env' | 'missing-context' | 'too-big' | 'agent';

/** A limit's exit code is 126/127 for a bare command (e.g. `jq`); a missing `./script.sh` is the agent's own miss. */
const bareWord = (cmd: string): boolean => {
	const first = cmd.trim().split(/\s+/)[0] ?? '';
	return first.length > 0 && !first.includes('/');
};

const LIMIT = /turn limit|max(?:imum)? turns|time limit|timed? ?out|context limit|context window|ran out of (?:turns|time)/i;
const NEEDS_INFO = /^(BLOCKED|NEEDS)[:\s].+$/im;

/** Names why an attempt failed, from its checks and summary. Pure: no I/O, no wiring here. */
export function diagnose(a: { checks: Check[]; summary: string; error?: string; sameRoutes?: number; rerunPassed?: boolean }): { cause: Cause; why: string; check?: Check } {
	if (a.rerunPassed) return { cause: 'flaky', why: 'a rerun of the same attempt passed' };

	const badCheck = a.checks.find((c) => !c.ok && (c.code === 126 || c.code === 127) && bareWord(c.cmd));
	if (badCheck) return { cause: 'bad-check', why: `${badCheck.cmd.trim().split(/\s+/)[0]} exited ${badCheck.code}: command not found`, check: badCheck };

	if ((a.sameRoutes ?? 0) >= 2) return { cause: 'env', why: `the same failure hit ${a.sameRoutes} routes: likely the environment, not the agent` };

	const needs = `${a.summary}\n${a.error ?? ''}`.match(NEEDS_INFO);
	if (needs) return { cause: 'missing-context', why: `the agent asked for information: ${needs[0].trim()}` };

	const mixed = a.checks.some((c) => c.ok) && a.checks.some((c) => !c.ok);
	if (mixed) return { cause: 'too-big', why: 'some checks passed and some failed: the task is likely more than one step' };
	if (LIMIT.test(`${a.summary} ${a.error ?? ''}`)) return { cause: 'too-big', why: 'the agent hit a turn, time or context limit' };

	return { cause: 'agent', why: (a.error || a.summary || 'the agent did not satisfy the checks').trim().split('\n')[0].slice(0, 200) };
}
