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
	if (existsSync(file) && !existsSync(`${file}.jarvis-code.bak`)) writeFileSync(`${file}.jarvis-code.bak`, readFileSync(file));
	writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
	return file;
}

/** Install the worker integration for one agent CLI; returns what was done, line by line. */
export function install(target: Target): string[] {
	if (target === 'codex') return [`added the jarvis-code PreToolUse hook to ${writeCodexHooks(true)}`, 'Codex asks you to trust a new hook once; approve it.'];
	if (target === 'opencode') {
		const link = paths.opencodePlugin();
		mkdirSync(dirname(link), { recursive: true });
		if (existsSync(link) || opencodeInstalled()) unlinkSync(link);
		symlinkSync(join(PLUGIN_DIR, 'opencode', 'jarvis-code.js'), link);
		return [`linked ${link} → ${join(PLUGIN_DIR, 'opencode', 'jarvis-code.js')}`];
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
	return out;
}

export function uninstall(target: Target): string[] {
	if (target === 'codex') return [`removed the jarvis-code hook from ${writeCodexHooks(false)}`];
	if (target === 'opencode') {
		if (opencodeInstalled()) unlinkSync(paths.opencodePlugin());
		return [`removed ${paths.opencodePlugin()}`];
	}
	try {
		execFileSync('claude', ['plugin', 'uninstall', 'jarvis-code@jarvis-code'], { stdio: 'pipe' });
		return ['claude plugin uninstall jarvis-code@jarvis-code: ok'];
	} catch (e) {
		return [`claude plugin uninstall: ${String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).trim()}`];
	}
}
