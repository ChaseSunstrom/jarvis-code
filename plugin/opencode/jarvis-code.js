// OpenCode plugin for jarvis-code workers: refuses learned-bad tools and task-state commands
// during a jarvis-code run; returns no hooks at all outside one.
import { refusal } from '../hooks/guard.mjs';

export const JarvisCode = async () => {
	if (process.env.JARVIS_CODE_RUN !== '1') return {};
	return {
		'tool.execute.before': async (input, output) => {
			const reason = refusal(String(input?.tool ?? ''), output?.args ?? {});
			if (reason) throw new Error(reason);
		},
	};
};
