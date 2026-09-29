import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

export type AgentKind = 'claude' | 'codex' | 'opencode' | 'generic';

export interface AgentConfig {
	kind: AgentKind;
	/** `auto` = on when `bin` is on PATH. */
	enabled: boolean | 'auto';
	bin: string;
	/** Each model is its own route (`agent:model`); empty = the CLI's own default. */
	models: string[];
	/** Extra CLI args. For `generic`, `{prompt}` is replaced by the task prompt. */
	args: string[];
	env: Record<string, string>;
	/** Claude Code plugins switched off inside workers, so an orchestrator plugin is never driven twice. */
	disablePlugins: string[];
	timeoutMin: number;
	/** A worker silent this long (no output line at all) is taken as hung and killed. */
	idleMin: number;
}

export interface DowngradePolicy {
	/** reupgrade: switch the live session back · retry: rerun the task on `to` · accept: keep going. */
	action: 'reupgrade' | 'retry' | 'accept';
	/** Model to go back to; default is the model that was downgraded. */
	to?: string;
	/** Re-upgrades per session before the downgrade is accepted. */
	max: number;
}

export interface Config {
	agents: Record<string, AgentConfig>;
	/** Route ids (`agent` or `agent:model`) in preference order; empty = every enabled route. */
	planner: string[];
	workers: string[];
	/**
	 * Route ids per role (ROUTE_ROLES), per task type (ROUTE_TYPES, for workers) or `default`, so one kind of work
	 * can go to the agent best at it. It only chooses among defined agents, so an untrusted project config may set it.
	 */
	routes: Record<string, string[]>;
	/** `priority`: first healthy route in order · `best`: highest learned score (per task type) · `escalate`: workers listed cheapest → strongest, big and security tasks start strongest. */
	strategy: 'priority' | 'best' | 'escalate';
	maxAttempts: number;
	maxParallel: number;
	/**
	 * `preflight`: before the first attempt, run every AC's verify once on the untouched tree, so the worker knows what already passes.
	 * `final`: after the last task, rerun the verify commands of the tasks closed in this run and report any that now fail.
	 */
	verify: { timeoutSec: number; preflight: boolean; final: boolean };
	ui: {
		showDiffs: boolean;
		showTools: boolean;
		showText: boolean;
		fps: number;
		reactor: 'large' | 'small' | 'off';
		/** `blocks`: anti-aliased half blocks (truecolor); `braille`: finer dots, font-dependent. */
		reactorStyle: 'blocks' | 'braille';
		/** Feed and queue marks: `text` tags (done, fail, run) or `glyph` symbols. */
		icons: 'text' | 'glyph';
		reducedMotion: boolean;
		alternateScreen: boolean;
		activityLines: number;
	};
	learning: {
		enabled: boolean;
		/** Outcomes needed before a route/tool can be switched off. */
		minSamples: number;
		/** Switched off when the smoothed success rate drops below this. */
		disableBelow: number;
		/** After this long a switched-off route gets one probe run. */
		cooldownMin: number;
		/** Weight kept by old outcomes on each new one (1 = never forget). */
		decay: number;
		/** Switch off learned-bad subagents/MCP/web tools inside workers. */
		blockTools: boolean;
		/** Extra tools learning must never switch off (core tools like Bash, Read, Edit never are). */
		neverBlock: string[];
	};
	downgrade: { default: DowngradePolicy; models: Record<string, DowngradePolicy> };
	/** Which passing tasks a second agent reviews (their diff only) before they close: `risky` = tier M/L or SECURITY. */
	review: 'off' | 'risky' | 'all';
	/** A shell command run when a task blocks and when a run ends; the message is `$1`. Empty = off. */
	notify: string;
	/** With maxParallel > 1 in a git repository, each attempt works in its own worktree and its changes land only when they pass. */
	worktrees: boolean;
	/** A task that blocks is split once by a planner into smaller tasks that replace it. */
	replan: boolean;
	/** Caps per run; 0 = none. Over a cap the run stops, killing its workers; their tasks stay queued. */
	budget: { usd: number; minutes: number };
	planning: {
		/** `auto`: a prompt writer grounds every goal and open ones are brainstormed first · `direct`: one planner · `deep`: always brainstorm. */
		mode: 'auto' | 'direct' | 'deep';
		/**
		 * `tree`: one agent splits the goal into categories, then each category is expanded level by
		 * level (broad ideas, then subtopics of the best of them, and so on) · `flat`: every lens in rounds.
		 */
		brainstorm: 'tree' | 'flat';
		/**
		 * The tree's bounds: `depth` levels counting the categories, up to `categories` of them, the best
		 * `breadth` ideas of each category expanded at each level, and at most `maxCalls` agent sessions.
		 */
		tree: { depth: number; categories: number; breadth: number; maxCalls: number };
		/** Brainstorm angles; the prompt writer may add up to 3 for the goal. A tree covers them in its categories. */
		lenses: string[];
		/** Most brainstorm rounds; a round adding fewer than `minNew` ideas ends it. */
		rounds: number;
		minNew: number;
		/** Brainstormers at once. */
		parallel: number;
		/** A critic on another route scores and ranks the ideas, so the planner starts from the best rather than all of them. */
		critique: boolean;
		/** At the end of a run, an agent checks the goal's done-items against what landed and queues follow-up work for the gaps. */
		coverage: boolean;
	};
	/** Remember (redacted, across projects) what the user asks for and turns down, so later plans lean toward what they want. */
	intent: boolean;
	/** `improve` runs rounds of plan-and-work, each seeing what the last landed; a round landing fewer than `minLanded` tasks ends it. */
	improve: { rounds: number; minLanded: number };
}

/** Keys of `routes` besides `default`. ROUTE_TYPES is store.ts's TYPES, written out because store.ts imports this file. */
export const ROUTE_ROLES = ['promptWriter', 'brainstorm', 'critic', 'planner', 'reviewer', 'workers'];
export const ROUTE_TYPES = ['RESEARCH', 'CLEAN', 'PERF', 'SECURITY', 'FIX', 'FEATURE'];

const KIND_DEFAULTS: Record<AgentKind, Omit<AgentConfig, 'kind'>> = {
	claude: { enabled: 'auto', bin: 'claude', models: [], args: [], env: {}, disablePlugins: ['foreman@foreman'], timeoutMin: 60, idleMin: 30 },
	codex: { enabled: 'auto', bin: 'codex', models: [], args: [], env: {}, disablePlugins: [], timeoutMin: 60, idleMin: 30 },
	opencode: { enabled: 'auto', bin: 'opencode', models: [], args: [], env: {}, disablePlugins: [], timeoutMin: 60, idleMin: 30 },
	generic: { enabled: true, bin: '', models: [], args: ['{prompt}'], env: {}, disablePlugins: [], timeoutMin: 60, idleMin: 30 },
};

export const DEFAULTS: Config = {
	agents: {
		claude: { kind: 'claude', ...KIND_DEFAULTS.claude },
		codex: { kind: 'codex', ...KIND_DEFAULTS.codex },
		opencode: { kind: 'opencode', ...KIND_DEFAULTS.opencode },
	},
	planner: [],
	workers: [],
	routes: {},
	strategy: 'priority',
	maxAttempts: 3,
	maxParallel: 1,
	verify: { timeoutSec: 600, preflight: true, final: false },
	ui: {
		showDiffs: false,
		showTools: false,
		showText: false,
		fps: 24,
		reactor: 'large',
		reactorStyle: 'blocks',
		icons: 'text',
		reducedMotion: false,
		alternateScreen: true,
		activityLines: 12,
	},
	learning: { enabled: true, minSamples: 3, disableBelow: 0.35, cooldownMin: 24 * 60, decay: 0.9, blockTools: true, neverBlock: [] },
	downgrade: { default: { action: 'reupgrade', max: 3 }, models: {} },
	review: 'risky',
	replan: true,
	worktrees: true,
	notify: '',
	budget: { usd: 0, minutes: 0 },
	planning: {
		mode: 'auto',
		brainstorm: 'tree',
		tree: { depth: 4, categories: 6, breadth: 3, maxCalls: 24 },
		lenses: ['user value', 'reliability', 'simplicity', 'bold bets', 'unstated needs (what the user will want next without saying it)'],
		rounds: 3,
		minNew: 3,
		parallel: 4,
		critique: true,
		coverage: true,
	},
	intent: true,
	improve: { rounds: 3, minLanded: 1 },
};

export const paths = {
	configDir: () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'jarvis-code'),
	stateDir: () => process.env.JARVIS_CODE_STATE || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'jarvis-code'),
	globalConfig: () => join(paths.configDir(), 'config.json'),
	projectConfig: (cwd: string) => join(cwd, '.jarvis-code.json'),
	trustFile: () => join(paths.stateDir(), 'trusted.json'),
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Objects merge key by key; arrays and scalars replace. */
export function merge<T>(base: T, over: unknown): T {
	if (!isObj(base) || !isObj(over)) return (over === undefined ? base : over) as T;
	const out: Record<string, unknown> = { ...base };
	for (const [k, v] of Object.entries(over)) out[k] = k in out ? merge(out[k], v) : v;
	return out as T;
}

function readJson(file: string): unknown {
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch (e) {
		throw new Error(`${file}: ${(e as Error).message}`);
	}
}

export function onPath(bin: string): boolean {
	if (!bin) return false;
	if (bin.includes('/')) return existsSync(bin);
	return (process.env.PATH || '').split(delimiter).some((d) => d && existsSync(join(d, bin)));
}

/** Fill each agent from its kind's defaults, so a config can add `local: {kind: "opencode", models: [...]}`. */
export function normalize(raw: Config): Config {
	const agents: Record<string, AgentConfig> = {};
	for (const [name, a] of Object.entries(raw.agents)) {
		const kind = (a.kind ?? name) as AgentKind;
		if (!(kind in KIND_DEFAULTS)) throw new Error(`agents.${name}.kind: unknown kind "${kind}" (claude, codex, opencode, generic)`);
		agents[name] = merge({ kind, ...KIND_DEFAULTS[kind] }, a);
		if (kind === 'generic' && !agents[name].bin) throw new Error(`agents.${name}.bin: a generic agent needs a command`);
		if (!Array.isArray(agents[name].models)) throw new Error(`agents.${name}.models: must be an array`);
	}
	for (const key of ['planner', 'workers'] as const) if (!Array.isArray(raw[key])) throw new Error(`${key}: must be an array of route ids`);
	if (!isObj(raw.routes)) throw new Error('routes: an object of role, task type or default → route ids');
	const routes: Record<string, string[]> = {};
	for (const [k, ids] of Object.entries(raw.routes)) {
		const key = ROUTE_TYPES.includes(k.toUpperCase()) ? k.toUpperCase() : k;
		if (key !== 'default' && !ROUTE_ROLES.includes(key) && !ROUTE_TYPES.includes(key)) throw new Error(`routes.${k}: a role (${ROUTE_ROLES.join(', ')}), a task type (${ROUTE_TYPES.join(', ')}) or default`);
		if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id)) throw new Error(`routes.${k}: must be an array of route ids`);
		routes[key] = ids;
	}
	for (const k of ['usd', 'minutes'] as const)
		if (typeof raw.budget[k] !== 'number' || !(raw.budget[k] >= 0)) throw new Error(`budget.${k}: a number, 0 (no cap) or more`);
	if (!['priority', 'best', 'escalate'].includes(raw.strategy)) throw new Error('strategy: priority, best or escalate');
	if (!['off', 'risky', 'all'].includes(raw.review)) throw new Error('review: off, risky or all');
	if (!['text', 'glyph'].includes(raw.ui.icons)) throw new Error('ui.icons: text or glyph');
	const pl = raw.planning;
	if (!['auto', 'direct', 'deep'].includes(pl.mode)) throw new Error('planning.mode: auto, direct or deep');
	for (const k of ['rounds', 'parallel'] as const) if (!Number.isInteger(pl[k]) || pl[k] < 1) throw new Error(`planning.${k}: a whole number, 1 or more`);
	if (!['tree', 'flat'].includes(pl.brainstorm)) throw new Error('planning.brainstorm: tree or flat');
	// Every bound is capped: a tree's agent sessions are paid for, and a loop over them must end.
	// A depth of 1 would stop at the categories, which are headings, not ideas: the planner would get nothing.
	const bounds = { depth: [2, 6], categories: [1, 12], breadth: [1, 10], maxCalls: [1, 200] } as const;
	for (const [k, [min, max]] of Object.entries(bounds) as [keyof typeof bounds, readonly [number, number]][])
		if (!Number.isInteger(pl.tree?.[k]) || pl.tree[k] < min || pl.tree[k] > max) throw new Error(`planning.tree.${k}: a whole number from ${min} to ${max}`);
	if (!Number.isInteger(pl.minNew) || pl.minNew < 0) throw new Error('planning.minNew: a whole number, 0 or more');
	if (!Array.isArray(pl.lenses) || !pl.lenses.every((l) => typeof l === 'string')) throw new Error('planning.lenses: an array of angle names');
	for (const k of ['critique', 'coverage'] as const) if (typeof pl[k] !== 'boolean') throw new Error(`planning.${k}: true or false`);
	if (typeof raw.intent !== 'boolean') throw new Error('intent: true or false');
	if (!Number.isInteger(raw.improve.rounds) || raw.improve.rounds < 1) throw new Error('improve.rounds: a whole number, 1 or more');
	if (!Number.isInteger(raw.improve.minLanded) || raw.improve.minLanded < 0) throw new Error('improve.minLanded: a whole number, 0 or more');
	return { ...raw, agents, routes };
}

export interface Loaded {
	config: Config;
	sources: string[];
	/** What an untrusted project config tried to set and was not allowed to. */
	warnings: string[];
}

/**
 * Keys that decide what runs on this machine. A repository's own `.jarvis-code.json` may set
 * them only once the user trusts that exact file (`jarvis-code config trust`): cloning a
 * repository must not be enough to run its commands.
 */
const COMMAND_KEYS = ['bin', 'args', 'env', 'kind'] as const;

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

function trustTable(): Record<string, string> {
	try {
		const t = JSON.parse(readFileSync(paths.trustFile(), 'utf8'));
		return isObj(t) ? (t as Record<string, string>) : {};
	} catch {
		return {};
	}
}

function saveTrust(table: Record<string, string>): void {
	mkdirSync(dirname(paths.trustFile()), { recursive: true });
	const tmp = `${paths.trustFile()}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(table, null, 2));
	renameSync(tmp, paths.trustFile());
}

/** Trust the project config in `cwd` as it is now; any later edit needs trusting again. */
export function trustProject(cwd: string): string {
	const file = resolve(paths.projectConfig(cwd));
	if (!existsSync(file)) throw new Error(`no ${file} to trust`);
	saveTrust({ ...trustTable(), [file]: digest(readFileSync(file, 'utf8')) });
	return file;
}

export function untrustProject(cwd: string): void {
	const table = trustTable();
	delete table[resolve(paths.projectConfig(cwd))];
	saveTrust(table);
}

function trusted(file: string, text: string): boolean {
	// For CI and containers: set by whoever starts jarvis-code, never by a repository.
	if (process.env.JARVIS_CODE_TRUST === 'all') return true;
	return trustTable()[resolve(file)] === digest(text);
}

/** An untrusted project config without its command keys, and what was dropped. */
function untrustedPart(data: Record<string, unknown>, known: Config): { data: Record<string, unknown>; dropped: string[] } {
	const dropped: string[] = [];
	const out = { ...data };
	if ('notify' in out) {
		delete out.notify;
		dropped.push('notify');
	}
	if (isObj(out.agents)) {
		const agents: Record<string, unknown> = {};
		for (const [name, a] of Object.entries(out.agents as Record<string, unknown>)) {
			if (!isObj(a)) continue;
			const safe = { ...(a as Record<string, unknown>) };
			const kind = String(safe.kind ?? name);
			// A new agent of a CLI kind runs that CLI as installed; a generic one is nothing but its command.
			if (!known.agents[name] && !['claude', 'codex', 'opencode'].includes(kind)) {
				dropped.push(`agents.${name}`);
				continue;
			}
			for (const k of COMMAND_KEYS)
				if (k in safe && !(k === 'kind' && !known.agents[name])) {
					delete safe[k];
					dropped.push(`agents.${name}.${k}`);
				}
			agents[name] = safe;
		}
		out.agents = agents;
	}
	return { data: out, dropped };
}

/** Defaults ← global config ← project `.jarvis-code.json` ← overrides (CLI flags). */
export function loadConfig(cwd: string, overrides: unknown = {}): Loaded {
	let config = DEFAULTS;
	const sources: string[] = [];
	const warnings: string[] = [];
	for (const [file, own] of [[paths.globalConfig(), true], [paths.projectConfig(cwd), false]] as const) {
		let data = readJson(file);
		if (data === undefined) continue;
		if (!isObj(data)) throw new Error(`${file}: must be a JSON object`);
		if (!own && !trusted(file, readFileSync(file, 'utf8'))) {
			const part = untrustedPart(data as Record<string, unknown>, config);
			data = part.data;
			if (part.dropped.length) warnings.push(`${file} sets ${part.dropped.join(', ')}, which run commands: ignored until you run \`jarvis-code config trust\` there`);
		}
		config = merge(config, data);
		sources.push(file);
	}
	return { config: normalize(merge(config, overrides)), sources, warnings };
}

export function agentEnabled(a: AgentConfig): boolean {
	return a.enabled === 'auto' ? onPath(a.bin) : a.enabled;
}
