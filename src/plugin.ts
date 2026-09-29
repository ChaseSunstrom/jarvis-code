import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package root (this file is dist/src/plugin.js). */
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const PLUGIN_DIR = join(ROOT, 'plugin');
const HOOK = join(PLUGIN_DIR, 'hooks', 'jc-hook.mjs');

export type Target = 'claude' | 'codex' | 'opencode';
export const TARGETS: Target[] = ['claude', 'codex', 'opencode'];

const readJson = (file: string): Record<string, any> => {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return {};
	}
};

export const paths = {
	claudeSettings: () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'),
	codexHooks: () => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'hooks.json'),
	opencodePlugin: () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode', 'plugins', 'jarvis-code.js'),
	codexConfig: () => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'),
	opencodeConfig: () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode', 'opencode.json'),
};

/** The MCP server (`jarvis-code mcp`) as each agent registers it. */
const MCP_TOML = '# jarvis-code MCP server: `jarvis-code plugin uninstall codex` removes it\n[mcp_servers.jarvis-code]\ncommand = "jarvis-code"\nargs = ["mcp"]\n';
const MCP_OPENCODE = { type: 'local', command: ['jarvis-code', 'mcp'], enabled: true };
const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
/** A one-time copy of a file jarvis-code is about to change. */
const backup = (file: string) => existsSync(file) && !existsSync(`${file}.jarvis-code.bak`) && writeFileSync(`${file}.jarvis-code.bak`, readFileSync(file));

/**
 * Codex: one table appended to config.toml, marked as ours, so uninstall takes out exactly it.
 * A jarvis-code server they configured themselves is left alone.
 */
function codexMcp(add: boolean): string {
	const file = paths.codexConfig();
	const text = read(file);
	const ours = text.includes(MCP_TOML);
	if (!add) {
		if (!ours) return `no jarvis-code MCP server of ours in ${file}`;
		backup(file);
		writeFileSync(file, text.replace(`\n${MCP_TOML}`, '').replace(MCP_TOML, ''));
		return `removed the jarvis-code MCP server from ${file}`;
	}
	if (ours) return `the jarvis-code MCP server is already in ${file}`;
	// TOML allows spaces around the dots of a header or a dotted key: a second table would break the file.
	if (/^\s*\[\s*mcp_servers\s*\.\s*("jarvis-code"|jarvis-code)\s*\]|mcp_servers\s*\.\s*("jarvis-code"|jarvis-code)\s*\./m.test(text)) return `${file} already has a jarvis-code MCP server of yours: left as it is`;
	mkdirSync(dirname(file), { recursive: true });
	backup(file);
	writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${MCP_TOML}`);
	return `added the jarvis-code MCP server to ${file} (tools: status, tasks, task_show, history, queue_goal, add_task, tell)`;
}

/** OpenCode: an `mcp` entry in opencode.json, only when it is plain JSON (comments would be lost); otherwise the entry to add. */
function opencodeMcp(add: boolean): string {
	const file = paths.opencodeConfig();
	const text = read(file);
	const snippet = `"mcp": { "jarvis-code": ${JSON.stringify(MCP_OPENCODE)} }`;
	let data: Record<string, any>;
	try {
		data = text.trim() ? JSON.parse(text) : { $schema: 'https://opencode.ai/config.json' };
	} catch {
		return add ? `${file} is not plain JSON (comments?), so it was not rewritten: add this to ${file} yourself: ${snippet}` : `${file} is not plain JSON: remove its "jarvis-code" mcp entry yourself`;
	}
	const ours = JSON.stringify(data.mcp?.['jarvis-code']?.command) === JSON.stringify(MCP_OPENCODE.command);
	if (!add) {
		if (!ours) return `no jarvis-code MCP server of ours in ${file}`;
		delete data.mcp['jarvis-code'];
		if (!Object.keys(data.mcp).length) delete data.mcp;
	} else {
		if (data.mcp?.['jarvis-code'] && !ours) return `${file} already has a jarvis-code MCP server of yours: left as it is`;
		data.mcp = { ...data.mcp, 'jarvis-code': MCP_OPENCODE };
	}
	mkdirSync(dirname(file), { recursive: true });
	backup(file);
	writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
	return add ? `added the jarvis-code MCP server to ${file}` : `removed the jarvis-code MCP server from ${file}`;
}

/** Whether jarvis-code's own MCP registration is in place for the agent (Claude Code: it comes with the plugin). */
export const mcpInstalled: Record<Target, () => boolean> = {
	claude: () => claudeInstalled(),
	codex: () => read(paths.codexConfig()).includes(MCP_TOML),
	opencode: () => {
		try {
			return JSON.stringify(JSON.parse(read(paths.opencodeConfig()) || '{}').mcp?.['jarvis-code']?.command) === JSON.stringify(MCP_OPENCODE.command);
		} catch {
			return false;
		}
	},
};

/** Enabled in Claude Code's user settings: then workers need no `--plugin-dir`, and passing one would load it twice. */
export function claudeInstalled(): boolean {
	const enabled = readJson(paths.claudeSettings()).enabledPlugins ?? {};
	return Object.entries(enabled).some(([k, v]) => k.startsWith('jarvis-code@') && v === true);
}

const isOurs = (entry: any) => JSON.stringify(entry ?? {}).includes('jc-hook.mjs');

export function codexInstalled(): boolean {
	return (readJson(paths.codexHooks()).hooks?.PreToolUse ?? []).some(isOurs);
}

export function opencodeInstalled(): boolean {
	try {
		return lstatSync(paths.opencodePlugin()).isSymbolicLink() && readlinkSync(paths.opencodePlugin()).endsWith(join('opencode', 'jarvis-code.js'));
	} catch {
		return false;
	}
}

export const installed: Record<Target, () => boolean> = { claude: claudeInstalled, codex: codexInstalled, opencode: opencodeInstalled };

function writeCodexHooks(add: boolean): string {
	const file = paths.codexHooks();
	const data = readJson(file);
	data.hooks ??= {};
	const kept = (data.hooks.PreToolUse ?? []).filter((e: unknown) => !isOurs(e));
	if (add) kept.push({ matcher: '.*', hooks: [{ type: 'command', command: `node "${HOOK}" PreToolUse`, timeout: 10, statusMessage: 'jarvis-code guard' }] });
	if (kept.length) data.hooks.PreToolUse = kept;
	else delete data.hooks.PreToolUse;
	mkdirSync(dirname(file), { recursive: true });
	backup(file);
	writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
	return file;
}

/** Install the worker integration for one agent CLI; returns what was done, line by line. */
export function install(target: Target): string[] {
	if (target === 'codex') return [`added the jarvis-code PreToolUse hook to ${writeCodexHooks(true)}`, 'Codex asks you to trust a new hook once; approve it.', codexMcp(true)];
	if (target === 'opencode') {
		const link = paths.opencodePlugin();
		mkdirSync(dirname(link), { recursive: true });
		if (existsSync(link) || opencodeInstalled()) unlinkSync(link);
		symlinkSync(join(PLUGIN_DIR, 'opencode', 'jarvis-code.js'), link);
		return [`linked ${link} → ${join(PLUGIN_DIR, 'opencode', 'jarvis-code.js')}`, opencodeMcp(true)];
	}
	const cmds = [
		['plugin', 'marketplace', 'add', ROOT],
		['plugin', 'install', 'jarvis-code@jarvis-code'],
	];
	const out: string[] = [];
	for (const args of cmds) {
		try {
			execFileSync('claude', args, { stdio: 'pipe' });
			out.push(`claude ${args.join(' ')}: ok`);
		} catch (e) {
			const msg = String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).trim().split('\n').pop();
			out.push(`claude ${args.join(' ')}: ${msg}`);
		}
	}
	out.push('the jarvis-code MCP server comes with the plugin (tools: status, tasks, task_show, history, queue_goal, add_task, tell; /jarvis-code:queue <goal>)');
	return out;
}

export function uninstall(target: Target): string[] {
	if (target === 'codex') return [`removed the jarvis-code hook from ${writeCodexHooks(false)}`, codexMcp(false)];
	if (target === 'opencode') {
		if (opencodeInstalled()) unlinkSync(paths.opencodePlugin());
		return [`removed ${paths.opencodePlugin()}`, opencodeMcp(false)];
	}
	try {
		execFileSync('claude', ['plugin', 'uninstall', 'jarvis-code@jarvis-code'], { stdio: 'pipe' });
		return ['claude plugin uninstall jarvis-code@jarvis-code: ok'];
	} catch (e) {
		return [`claude plugin uninstall: ${String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).trim()}`];
	}
}
