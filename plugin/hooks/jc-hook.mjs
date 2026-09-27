#!/usr/bin/env node
// PreToolUse hook for Claude Code and Codex (both send {tool_name, tool_input} on stdin and
// read the same deny shape back). Outside a jarvis-code run it does nothing at all.
import { refusal } from './guard.mjs';

if (process.env.JARVIS_CODE_RUN !== '1') process.exit(0);
let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
	let input = {};
	try {
		input = JSON.parse(raw || '{}');
	} catch {
		process.exit(0); // never break a session over a malformed payload
	}
	const reason = refusal(String(input.tool_name ?? ''), input.tool_input ?? {});
	if (reason)
		process.stdout.write(
			JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
		);
});
