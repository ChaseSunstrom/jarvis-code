/**
 * Ink, React and the cockpit, loaded as React's production build.
 *
 * Nothing sets NODE_ENV for a CLI, so React picks its development build, and react-reconciler's
 * dev build calls performance.measure() for every component render: its root fiber always has
 * ProfileMode. Node keeps every measure in its global timeline, with a structured clone of the
 * detail, and never drops one: at 24 fps that grew the cockpit to a 4 GB OOM.
 *
 * React picks its build when first required, so NODE_ENV only has to hold for the import. It is
 * restored after: agents and verify commands are spawned with {...process.env}
 * (src/agents/spawn.ts), and npm skips devDependencies under NODE_ENV=production.
 */
export async function loadCockpit() {
	const was = process.env.NODE_ENV;
	process.env.NODE_ENV ??= 'production';
	try {
		return await Promise.all([import('ink'), import('react'), import('./Cockpit.js')]);
	} finally {
		if (was === undefined) delete process.env.NODE_ENV;
	}
}
