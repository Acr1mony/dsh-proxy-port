/**
 * Where the tests look for an application archive to load the host's modules from.
 *
 * The plugin reaches `@deepseek-ai/dsh-http-proxy` and `undici` through
 * `resources/app.asar`, and plain Node cannot read a packed archive. A *directory*
 * with that name works instead, because resolution is by path: copy
 * `@deepseek-ai/dsh-http-proxy` and `undici` out of an installed DSH into
 * `<root>/resources/app.asar/dsh/node_modules/` and point the tests at `<root>`.
 *
 * Search order: `DSH_LOCAL_PROXY_FIXTURE`, the author's `_probe` tree, then a
 * `fixture/` directory inside this repository.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * @returns an existing archive root to assign to `process.env.DSH_APP_ASAR`.
 * @throws when no candidate exists, with the one command that fixes it.
 */
export function fixtureRoot() {
	const candidates = [
		process.env.DSH_LOCAL_PROXY_FIXTURE,
		path.resolve(import.meta.dirname, '..', '..', '_probe', 'fake', 'resources', 'app.asar'),
		path.resolve(import.meta.dirname, '..', 'fixture', 'resources', 'app.asar')
	];
	const found = candidates.find((candidate) => typeof candidate === 'string' && candidate !== '' && fs.existsSync(candidate));
	if (found !== undefined) return found;
	throw new Error(
		'no fixture archive found: set DSH_LOCAL_PROXY_FIXTURE to a directory containing resources/app.asar/'
		+ ' (copy @deepseek-ai/dsh-http-proxy and undici from an installed DeepSeek Harness into dsh/node_modules/ there)'
	);
}
