import type { Config, DowngradePolicy } from './config.js';

export interface Decision {
	action: DowngradePolicy['action'];
	model?: string;
	why: string;
}

/** `claude-fable*` style match; exact keys win over patterns. */
function policyFor(cfg: Config['downgrade'], model: string | undefined): DowngradePolicy {
	if (!model) return cfg.default;
	if (cfg.models[model]) return cfg.models[model];
	for (const [pat, pol] of Object.entries(cfg.models)) {
		if (!pat.includes('*')) continue;
		const re = new RegExp(`^${pat.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
		if (re.test(model)) return pol;
	}
	return cfg.default;
}

/**
 * What to do when a session leaves its model. Only sticky switches matter: a turn-scoped
 * fallback (overload, availability) returns to the primary on its own. A usage-credit
 * consent swap is left alone — switching back would only re-open the same gate.
 */
export function decide(cfg: Config['downgrade'], e: { from?: string; to: string; reason: string; sticky: boolean }, count: number): Decision {
	if (!e.sticky) return { action: 'accept', why: `turn-scoped ${e.reason} fallback` };
	if (e.reason === 'consent') return { action: 'accept', why: 'usage-credit consent swap' };
	const pol = policyFor(cfg, e.from);
	const model = pol.to ?? e.from;
	if (!model) return { action: 'accept', why: 'no model to return to' };
	if (pol.action === 'accept') return { action: 'accept', why: 'policy accepts downgrades' };
	if (count >= pol.max) return { action: 'accept', why: `${count} re-upgrades already this run (max ${pol.max})` };
	return { action: pol.action, model, why: `${e.reason}: ${e.from ?? '?'} → ${e.to}` };
}
