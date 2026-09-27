import type { Config } from './config.js';
import type { Activity, Orchestrator } from './orchestrator.js';
import { colorDepth, paint, palette } from './theme.js';
import { clock, elapsed, KIND, visible } from './tui/style.js';

/** Line-per-event output for pipes, CI and `--plain`: the same feed the TUI shows. */
export function attachPlain(o: Orchestrator, ui: Config['ui'], out: NodeJS.WriteStream = process.stdout): () => void {
	const depth = colorDepth(process.env, !!out.isTTY);
	const line = (a: Activity) => {
		if (!visible(a, ui)) return;
		const [icon, tone] = KIND[a.kind];
		out.write(`${paint(clock(a.at), palette.textFaint, 1, depth)} ${paint(icon, palette[tone], 1, depth)} ${a.text}\n`);
		if (a.kind === 'change' && a.detail) for (const l of a.detail.split('\n').slice(0, 6)) out.write(`           ${l}\n`);
	};
	o.on('activity', line);
	return () => {
		o.off('activity', line);
		const s = o.snapshot();
		const n = (st: string) => s.tasks.filter((t) => t.status === st).length;
		out.write(
			`\n${paint('jarvis-code', palette.accent, 1, depth)}: ${n('done')}/${s.tasks.length - n('split')} done, ${n('blocked')} blocked, ${n('review')} to review · $${s.cost.toFixed(2)} · ${elapsed(Date.now() - s.started)}\n`,
		);
		if (o.reportPath) out.write(`${paint('report', palette.textDim, 1, depth)} ${o.reportPath}\n`);
	};
}
