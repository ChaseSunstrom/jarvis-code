/** What every agent adapter reports, whatever CLI it drives. */
export type AgentEvent =
	| { type: 'init'; model?: string; session?: string }
	| { type: 'text'; text: string }
	| { type: 'tool'; id?: string; name: string; summary: string }
	| { type: 'tool_result'; id?: string; name: string; ok: boolean; error?: string }
	| { type: 'change'; path: string; diff?: string }
	/** The session left the requested model. `sticky`: later turns stay on `to` unless switched back. */
	| { type: 'model'; from?: string; to: string; reason: string; sticky: boolean }
	| { type: 'reupgrade'; model: string; ok: boolean }
	| { type: 'usage'; costUsd?: number; tokens?: number }
	| { type: 'log'; text: string };

export interface RunSpec {
	prompt: string;
	cwd: string;
	model?: string;
	role: 'planner' | 'worker';
	/** Appended to the agent's system prompt (or prepended to the prompt where there is none). */
	context?: string;
	/** Learned-bad tools: `Name` or `Name(subagent)`. */
	blockedTools: string[];
	/** Directory holding the jarvis-code Claude Code plugin, when it is not installed globally. */
	pluginDir?: string;
	env?: Record<string, string>;
}

export interface Outcome {
	ok: boolean;
	/** The agent's final message. */
	summary: string;
	error?: string;
	costUsd?: number;
	exitCode: number | null;
	/** Model the session ended on, when the agent reports it. */
	model?: string;
}

export interface AgentRun {
	done: Promise<Outcome>;
	kill(): void;
	/** Switch the live session's model; absent when the CLI cannot. */
	setModel?(model: string): void;
}

export type Emit = (e: AgentEvent) => void;

/** Short one-line description of a tool call for the activity feed. */
export function summarize(name: string, input: unknown): string {
	const i = (input ?? {}) as Record<string, unknown>;
	const pick = i.command ?? i.file_path ?? i.filePath ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt;
	const s = typeof pick === 'string' ? pick : '';
	return (s ? `${name} ${s}` : name).replace(/\s+/g, ' ').slice(0, 160);
}
