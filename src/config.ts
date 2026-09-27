import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

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
	/** `priority`: first healthy route in order · `best`: highest learned score. */
	strategy: 'priority' | 'best';
	maxAttempts: number;
	maxParallel: number;
	foreman: { bin: string; closeTasks: boolean };
	verify: { timeoutSec: number };
	ui: {
		showDiffs: boolean;
		showTools: boolean;
		showText: boolean;
		fps: number;
		reactor: 'large' | 'small' | 'off';
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
}

const KIND_DEFAULTS: Record<AgentKind, Omit<AgentConfig, 'kind'>> = {
	claude: { enabled: 'auto', bin: 'claude', models: [], args: [], env: {}, disablePlugins: ['foreman@foreman'], timeoutMin: 60 },
	codex: { enabled: 'auto', bin: 'codex', models: [], args: [], env: {}, disablePlugins: [], timeoutMin: 60 },
	opencode: { enabled: 'auto', bin: 'opencode', models: [], args: [], env: {}, disablePlugins: [], timeoutMin: 60 },
	generic: { enabled: true, bin: '', models: [], args: ['{prompt}'], env: {}, disablePlugins: [], timeoutMin: 60 },
};

export const DEFAULTS: Config = {
	agents: {
		claude: { kind: 'claude', ...KIND_DEFAULTS.claude },
		codex: { kind: 'codex', ...KIND_DEFAULTS.codex },
		opencode: { kind: 'opencode', ...KIND_DEFAULTS.opencode },
	},
	planner: [],
	workers: [],
	strategy: 'priority',
	maxAttempts: 3,
	maxParallel: 1,
	foreman: { bin: 'fm', closeTasks: true },
	verify: { timeoutSec: 600 },
	ui: {
		showDiffs: false,
		showTools: false,
		showText: false,
		fps: 24,
		reactor: 'large',
		reducedMotion: false,
		alternateScreen: true,
		activityLines: 12,
	},
	learning: { enabled: true, minSamples: 3, disableBelow: 0.35, cooldownMin: 24 * 60, decay: 0.9, blockTools: true, neverBlock: [] },
	downgrade: { default: { action: 'reupgrade', max: 3 }, models: {} },
};

export const paths = {
	configDir: () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'jarvis-code'),
	stateDir: () => process.env.JARVIS_CODE_STATE || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'jarvis-code'),
	globalConfig: () => join(paths.configDir(), 'config.json'),
	projectConfig: (cwd: string) => join(cwd, '.jarvis-code.json'),
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
	return { ...raw, agents };
}

export interface Loaded {
	config: Config;
	sources: string[];
}

/** Defaults ← global config ← project `.jarvis-code.json` ← overrides (CLI flags). */
export function loadConfig(cwd: string, overrides: unknown = {}): Loaded {
	let config = DEFAULTS;
	const sources: string[] = [];
	for (const file of [paths.globalConfig(), paths.projectConfig(cwd)]) {
		const data = readJson(file);
		if (data === undefined) continue;
		if (!isObj(data)) throw new Error(`${file}: must be a JSON object`);
		config = merge(config, data);
		sources.push(file);
	}
	return { config: normalize(merge(config, overrides)), sources };
}

export function agentEnabled(a: AgentConfig): boolean {
	return a.enabled === 'auto' ? onPath(a.bin) : a.enabled;
}
