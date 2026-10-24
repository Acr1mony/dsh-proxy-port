/**
 * The plugin's `Config`: the shipped defaults and the shape of the row config.
 *
 * The port is not edited here. `/proxy <port>` owns that field at runtime
 * (`lib/command.js`) and stores it in the profile's `local-proxy.json`, which
 * wins over this row config. Nothing is declared volatile on purpose: a volatile
 * field would make DSH render a configuration form for a value the command
 * already owns, and two editors for one port is how a "changed it, nothing
 * happened" report starts.
 *
 * `@deepseek-ai/schemastery` is a host package: it is not on the profile's
 * resolution path, so it is imported from the application archive by file URL —
 * the same trick `lib/policy.js` uses for the proxy policy module. An unresolved
 * schema only costs validation, never the proxy: `fallbackConfig` keeps the
 * plugin loadable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULT_CONFIG, normalizeConfig } from './config.js';
import { archiveRoots } from './policy.js';

/** Host package that provides the schema builder. */
const PACKAGE = '@deepseek-ai/schemastery';

/** Candidate entry files of the schema package inside one archive root. */
const ENTRY_CANDIDATES = Object.freeze([
	['dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'],
	['node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'],
	['dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.js'],
	['node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.js']
]);

/**
 * Import the schema builder from the application archive.
 *
 * @returns the module namespace, or `undefined` when no archive carries it.
 */
async function loadSchemastery() {
	for (const archive of archiveRoots()) {
		for (const candidate of ENTRY_CANDIDATES) {
			const file = path.join(archive, ...candidate);
			try {
				if (!fs.existsSync(file)) continue;
				return await import(pathToFileURL(file).href);
			} catch {
				/* try the next candidate */
			}
		}
	}
	return undefined;
}

const schemastery = await loadSchemastery();

/** Where the schema came from; `fallback` means the row config is only normalized. */
export const schemaSource = schemastery === undefined ? 'fallback' : 'schemastery';

/**
 * What the schema builder exports.
 *
 * The package default-exports `z`; the named `Schema` is what a loader would
 * hand to `new z(...)`, and neither shape is stable enough to assume alone.
 */
const z = schemastery?.default ?? schemastery?.Schema ?? schemastery?.z;

/**
 * A config schema for a host without the schema package.
 *
 * Cordis accepts a plain function in place of a schema and calls it to normalize
 * the row config.
 *
 * @param value - row config from the patch layer.
 * @returns the normalized config.
 */
const fallbackConfig = (value) => normalizeConfig(value).config;

/**
 * The row config schema: defaults plus validation, no live fields.
 */
export const Config = typeof z === 'function'
	? z.object({
		enabled: z.boolean()
			.description('Route DSH network operations through the proxy. Off sends every request direct.')
			.default(DEFAULT_CONFIG.enabled),
		host: z.string()
			.description('Proxy host. Only used when proxyUrl is empty.')
			.default(DEFAULT_CONFIG.host),
		port: z.number()
			.description('Default local HTTP proxy port; change it at runtime with /proxy <port>.')
			.step(1)
			.min(1)
			.max(65535)
			.default(DEFAULT_CONFIG.port),
		proxyUrl: z.string()
			.description('Full proxy URL such as http://127.0.0.1:7890. Overrides host and port when set.')
			.default(DEFAULT_CONFIG.proxyUrl),
		noProxy: z.string()
			.description('Comma-separated hosts that skip the proxy. Loopback always skips it.')
			.default(DEFAULT_CONFIG.noProxy),
		childNodes: z.boolean()
			.description('Point spawned child processes (curl, git, pnpm) at the same proxy through env.')
			.default(DEFAULT_CONFIG.childNodes),
		verifyUrl: z.string()
			.description('URL that local_proxy diagnose and test check by default.')
			.default(DEFAULT_CONFIG.verifyUrl)
	})
	: fallbackConfig;
