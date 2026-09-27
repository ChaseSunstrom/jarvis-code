// Starts an agent that would run forever, prints its pid, then crashes: the agent must die too.
const { run } = await import(process.argv[2]);
const p = run(process.execPath, ['-e', 'console.log(process.pid); setInterval(() => {}, 1000)'], { cwd: process.cwd(), timeoutMin: 5 }, (_v, raw) => {
	console.log(raw);
	setTimeout(() => {
		throw new Error('crash');
	}, 50);
});
void p;
