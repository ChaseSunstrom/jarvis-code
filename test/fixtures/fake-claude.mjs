#!/usr/bin/env node
// A stand-in for `claude -p --input-format stream-json --output-format stream-json` that
// behaves like the real CLI (2.1.280) around model switches: a sticky refusal fallback moves
// the rest of the turn to the fallback model; an accepted set_model applies from the NEXT
// turn, which opens with a fresh init. Every stdin line and the argv go to $FAKE_LOG.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = (o) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + '\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
log({ argv: process.argv.slice(2) });
let model = arg('--model') ?? 'claude-fable-5-1';
let next;
const mode = process.env.FAKE_MODE ?? 'downgrade';
const rl = createInterface({ input: process.stdin });
let turns = 0;
let waiting;
rl.on('line', (raw) => {
	const m = JSON.parse(raw);
	log({ stdin: m });
	if (m.type === 'control_request' && m.request?.subtype === 'set_model') {
		next = m.request.model;
		out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id } });
		waiting?.();
		return;
	}
	if (m.type !== 'user') return;
	turns++;
	if (next) (model = next), (next = undefined);
	out({ type: 'system', subtype: 'init', model, session_id: 's-1', tools: [] });
	if (turns > 1) return finish(`reviewed on ${model}`);
	out({ type: 'assistant', parent_tool_use_id: null, message: { model, content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a.txt', old_string: 'x', new_string: 'y' } }] } });
	out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
	out({ type: 'assistant', parent_tool_use_id: null, message: { model, content: [{ type: 'tool_use', id: 't2', name: 'Agent', input: { subagent_type: 'Explore', description: 'look around' } }] } });
	out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: 'subagent crashed' }] }] } });
	if (mode !== 'downgrade') return finish(`done on ${model}`);
	out({ type: 'system', subtype: 'model_refusal_fallback', trigger: 'refusal', direction: 'sticky', scope: 'session', original_model: model, fallback_model: 'claude-opus-4-8', request_id: 'r1', api_refusal_category: 'cyber', uuid: 'u1', session_id: 's-1' });
	model = 'claude-opus-4-8';
	// The turn goes on (on the fallback model) whether or not a switch arrives.
	const t = setTimeout(() => finish(`done on ${model}`), 1500);
	waiting = () => { clearTimeout(t); waiting = undefined; finish(`done on ${model}`); };
});
function finish(text) {
	out({ type: 'assistant', parent_tool_use_id: null, message: { model, content: [{ type: 'text', text }] } });
	out({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.12 * turns, session_id: 's-1' });
}
rl.on('close', () => process.exit(0));
