/**
 * The transport half: find DSH's own `@deepseek-ai/dsh-http-proxy` and drive it.
 *
 * `dsh-web-fetch-http` decides per request whether to tunnel or to pin DNS, and
 * it asks `proxyRouteFor()` — module state owned by the copy of
 * `@deepseek-ai/dsh-http-proxy` that DSH itself imported, which lives inside
 * `resources/app.asar/dsh/node_modules`. A profile plugin cannot resolve that
 * package by name (its own `node_modules` has no `@deepseek-ai/*`), so the entry
 * is located on disk and imported by absolute file URL: Node's ESM cache is
 * keyed by URL, so this lands on the same module instance the host uses instead
 * of a second copy whose `proxyRouteFor()` would answer "direct" to `web_fetch`
 * while a private dispatcher routed `fetch()`.
 *
 * Nothing here throws into the plugin lifecycle: every failure becomes state the
 * `local_proxy` tool reports.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { proxyAddress, proxyUrlOf } from './config.js';

/** The package whose decisions `dsh-web-fetch-http` follows. */
const PACKAGE = '@deepseek-ai/dsh-http-proxy';

/**
 * A URL that must route through the proxy when the policy is live: HTTPS, not
 * loopback, and not in any plausible bypass list. It is never fetched — only
 * `proxyRouteFor()` is asked about it.
 */
const ROUTE_PROBE = 'https://dsh-proxy-port.invalid/';

/** Loaded module, cached across re-installs: the import is cheap but not free. */
let loaded;

/** The installation this plugin owns, or `undefined` when no policy is active. */
let active;

/**
 * Where DSH's application archive may live.
 *
 * `process.resourcesPath` is authoritative under Electron; the walked-up
 * candidates and `DSH_APP_ASAR` cover a plugin mounted outside the app's main
 * process, and a checkout where the archive sits beside the executable.
 *
 * @returns existing candidate archive paths, most specific first.
 */
export function archiveRoots() {
	const candidates = [];
	const push = (candidate) => {
		if (typeof candidate !== 'string' || candidate === '') return;
		if (!candidates.includes(candidate)) candidates.push(candidate);
	};

	push(process.env.DSH_APP_ASAR);
	if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') push(path.join(process.resourcesPath, 'app.asar'));

	let directory = path.dirname(process.execPath ?? '');
	for (let hop = 0; hop < 6 && directory !== ''; hop++) {
		push(path.join(directory, 'resources', 'app.asar'));
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}

	return candidates.filter((candidate) => {
		try {
			return fs.existsSync(candidate);
		} catch {
			return false;
		}
	});
}

/**
 * Resolve the proxy package's entry file from one archive root.
 *
 * `createRequire` is used first because it applies the package's `exports` map
 * exactly as the host's own resolution does — the resulting path is the one the
 * host ends up importing, which is what keeps the ESM cache entry shared.
 *
 * @param archive - an existing `app.asar` path.
 * @returns the entry file, or `undefined` with the attempts recorded.
 */
function resolveEntry(archive) {
	const attempts = [];
	const bases = [path.join(archive, 'dsh'), archive];
	for (const base of bases) {
		try {
			const require = createRequire(path.join(base, 'package.json'));
			const resolved = require.resolve(PACKAGE);
			if (resolved !== '') return { entry: resolved, attempts };
		} catch (error) {
			attempts.push(`${base}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const fallback = path.join(base, 'node_modules', ...PACKAGE.split('/'), 'lib', 'index.js');
		try {
			if (fs.existsSync(fallback)) return { entry: fallback, attempts };
		} catch {
			/* an unreadable archive root is just another miss */
		}
		attempts.push(fallback);
	}
	return { attempts };
}

/**
 * Import DSH's proxy policy module once.
 *
 * @returns `{ module, entry }` for the loaded policy package.
 * @throws when no archive root yields a module exporting the expected API.
 */
export async function loadPolicyModule() {
	if (loaded !== undefined) return loaded;
	const attempts = [];
	for (const archive of archiveRoots()) {
		const { entry, attempts: tried } = resolveEntry(archive);
		attempts.push(...tried);
		if (entry === undefined) continue;
		try {
			const module = await import(pathToFileURL(entry).href);
			if (typeof module.installProxyFromEnvironment !== 'function' || typeof module.proxyRouteFor !== 'function') {
				attempts.push(`${entry}: package does not export installProxyFromEnvironment/proxyRouteFor`);
				continue;
			}
			loaded = { module, entry };
			return loaded;
		} catch (error) {
			attempts.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`cannot load ${PACKAGE} from the DSH install (${attempts.join(' | ') || 'no app.asar found'})`);
}

/**
 * The launch-environment view `dsh-http-proxy` reads.
 *
 * It only ever calls `env.get(name)?.value`, so a Map of `{ value }` records has
 * the same shape as DSH's launch-environment snapshot without pretending to be it.
 *
 * @param config - a normalized config.
 * @returns one record per proxy variable the policy resolves.
 */
function environmentOf(config) {
	const proxy = proxyUrlOf(config);
	const entries = new Map();
	for (const name of ['http_proxy', 'https_proxy', 'all_proxy']) entries.set(name, { value: proxy });
	if (config.noProxy !== '') entries.set('no_proxy', { value: config.noProxy });
	return entries;
}

/**
 * Whether something is listening on the proxy address.
 *
 * @param config - a normalized config.
 * @param timeoutMs - connect budget.
 * @returns reachability, latency, and the address probed.
 */
export async function probeProxy(config, timeoutMs = 2500) {
	const { host, port } = proxyAddress(proxyUrlOf(config));
	const startedAt = Date.now();
	const { Socket } = await import('node:net');
	return await new Promise((resolve) => {
		const socket = new Socket();
		let settled = false;
		const finish = (reachable, error) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve({ reachable, host, port, latencyMs: Date.now() - startedAt, error });
		};
		socket.setTimeout(timeoutMs);
		socket.once('connect', () => finish(true));
		socket.once('timeout', () => finish(false, `connect timed out after ${timeoutMs}ms`));
		socket.once('error', (error) => finish(false, error.code ?? error.message));
		socket.connect(port, host);
	});
}

/**
 * Route decision for one URL, as `web_fetch` will see it.
 *
 * @param url - absolute URL.
 * @returns `{ proxied, proxy }`, or `{ error }` when the module is not loaded.
 */
export function routeFor(url) {
	if (active === undefined) return { proxied: false, proxy: undefined, moduleLoaded: loaded !== undefined };
	try {
		const route = active.module.proxyRouteFor(new URL(String(url)));
		return { proxied: route?.proxied === true, proxy: route?.proxy, moduleLoaded: true };
	} catch (error) {
		return { proxied: false, moduleLoaded: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Stop the policy this plugin installed, if any.
 *
 * The disposer is async (it closes the undici agent), so callers await it.
 *
 * @returns nothing; a failing disposer is reported rather than thrown.
 */
export async function deactivate() {
	const current = active;
	if (current === undefined) return;
	active = undefined;
	try {
		await current.disposer?.();
	} catch (error) {
		current.messages.push(`dispose failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (current.previousChildFlag === undefined) Reflect.deleteProperty(process.env, 'NODE_USE_ENV_PROXY');
	else process.env.NODE_USE_ENV_PROXY = current.previousChildFlag;
}

/**
 * Install the policy for `config`, replacing any policy already installed.
 *
 * @param config - a normalized config.
 * @returns the resulting state snapshot.
 */
export async function activate(config) {
	await deactivate();
	if (!config.enabled) return snapshot(config, { status: 'disabled' });

	const { module, entry } = await loadPolicyModule();
	const messages = [];
	let disposer;
	try {
		disposer = await module.installProxyFromEnvironment(environmentOf(config), (message) => {
			messages.push(String(message));
		});
	} catch (error) {
		return snapshot(config, {
			status: 'failed',
			entry,
			messages: [...messages, `install failed: ${error instanceof Error ? error.message : String(error)}`]
		});
	}

	let previousChildFlag;
	if (config.childNodes) {
		previousChildFlag = process.env.NODE_USE_ENV_PROXY;
		process.env.NODE_USE_ENV_PROXY = '1';
	}

	const probe = module.proxyRouteFor(new URL(ROUTE_PROBE));
	active = {
		module,
		entry,
		config,
		messages,
		disposer,
		previousChildFlag,
		proxyUrl: proxyUrlOf(config),
		routed: probe?.proxied === true
	};
	return snapshot(config);
}

/**
 * The state the tool and the log render, built from whatever is installed now.
 *
 * @param config - the config the caller believes is in force.
 * @param override - fields replacing the derived ones (disabled/failed paths).
 * @returns a plain, JSON-safe snapshot.
 */
export function snapshot(config, override = {}) {
	const current = active;
	return {
		status: override.status ?? (current === undefined ? 'off' : current.routed ? 'active' : 'inactive'),
		enabled: config?.enabled === true,
		proxyUrl: override.proxyUrl ?? current?.proxyUrl ?? (config === undefined ? '' : proxyUrlOf(config)),
		entry: override.entry ?? current?.entry ?? loaded?.entry ?? '',
		routed: current?.routed === true,
		messages: override.messages ?? current?.messages ?? [],
		config,
		processEnv: {
			http_proxy: process.env.http_proxy ?? '',
			https_proxy: process.env.https_proxy ?? '',
			no_proxy: process.env.no_proxy ?? '',
			NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY ?? ''
		}
	};
}

/** Whether a policy is installed right now. */
export function isInstalled() {
	return active !== undefined;
}
