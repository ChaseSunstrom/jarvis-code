import type { AgentConfig, AgentKind } from '../config.js';
import * as claude from './claude.js';
import * as codex from './codex.js';
import * as generic from './generic.js';
import * as opencode from './opencode.js';
import type { AgentRun, Emit, RunSpec } from './types.js';

export * from './types.js';

const ADAPTERS: Record<AgentKind, { start(cfg: AgentConfig, spec: RunSpec, emit: Emit): AgentRun }> = { claude, codex, opencode, generic };

export function startAgent(cfg: AgentConfig, spec: RunSpec, emit: Emit): AgentRun {
	return ADAPTERS[cfg.kind].start(cfg, spec, emit);
}
