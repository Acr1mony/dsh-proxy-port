/**
 * dsh-local-proxy — route DSH's network operations through a local HTTP proxy.
 *
 * The policy is DSH's own (`@deepseek-ai/dsh-http-proxy`), so `web_fetch`,
 * plain `fetch()`, and spawned children (`curl`, `git`, `pnpm`) all agree on one
 * proxy URL instead of each learning about it separately. See `lib/policy.js`
 * for why the module is imported by file URL rather than by package name.
 *
 * The port is chosen at runtime with `/proxy <port>`; see `lib/command.js`.
 * That command writes `local-proxy.json` in the profile directory, which wins
 * over the row config, so a restart begins on the last chosen port without
 * anyone editing YAML. The row config stays the shipped default, and
 * `lib/schema.js` deliberately declares no live fields: one editor per port.
 */

import { createProxyCommand } from './command.js';
import { normalizeConfig, proxyUrlOf } from './config.js';
import { activate, deactivate, snapshot } from './policy.js';
import { Config, schemaSource } from './schema.js';
import { profileDirectory, readState, statePath, writeState } from './state.js';
import { createProxyTool } from './tool.js';

export { Config, schemaSource };

export const name = 'dsh-local-proxy';

/** The tool registry must exist before `local_proxy` can be registered. */
export const inject = ['tools'];

/**
 * Read one config field.
 *
 * A host may hand a field over as a live `{ get() }` reference; the plain value
 * is the shape this plugin's own schema produces.
 *
 * @param config - the row config the loader passed to `apply`.
 * @param key - field name.
 * @returns the current value, or `undefined` when unreadable.
 */
function readField(config, key) {
	const value = config?.[key];
	if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
		try {
			return value.get();
		} catch {
			return undefined;
		}
	}
	return value;
}

/**
 * Snapshot every known field of the row config.
 *
 * @param config - the row config the loader passed to `apply`.
 * @returns a plain object a normalizer accepts.
 */
function readRowConfig(config) {
	const raw = {};
	for (const key of ['enabled', 'host', 'port', 'proxyUrl', 'noProxy', 'childNodes', 'verifyUrl']) {
		raw[key] = readField(config, key);
	}
	return raw;
}

/**
 * Mount the plugin.
 *
 * @param ctx - the plugin context.
 * @param config - the row config; `/proxy` state overrides it.
 */
export function apply(ctx, config) {
	const report = (level, message) => {
		try {
			const logger = ctx?.logger;
			const sink = logger?.[level];
			if (typeof sink === 'function') {
				sink.call(logger, message);
				return;
			}
		} catch {
			/* fall through to the console */
		}
		if (level === 'error') console.error(message);
		else console.warn(message);
	};

	if (process.env.DSH_LOCAL_PROXY_DEBUG) {
		console.log(`[dsh-local-proxy] apply() entered, schema=${schemaSource}, cwd=${process.cwd()}`);
	}

	/** The profile directory `/proxy` writes its state file into. */
	const profileDir = profileDirectory(ctx);

	/** Fields `/proxy` persisted; they win over the row config on every start. */
	let persisted = readState(profileDir);

	/** Signature and state of the installation that is live right now. */
	let applied;

	/** Serializes reconciles so two config changes cannot interleave. */
	let queue = Promise.resolve();

	/**
	 * The config the running plugin should honor.
	 *
	 * @returns a normalized config plus its warnings.
	 */
	const effective = () => normalizeConfig({ ...readRowConfig(config), ...persisted });

	/**
	 * Bring the process-wide policy in line with the current config.
	 *
	 * @returns a promise that settles after the policy was installed or removed.
	 */
	const reconcile = () => {
		queue = queue.then(async () => {
			const { config: next, warnings } = effective();
			for (const warning of warnings) report('warn', `local-proxy: ${warning}`);
			const signature = JSON.stringify(next);
			if (signature === applied?.signature) return;

			if (!next.enabled) {
				await deactivate();
				applied = { signature, state: undefined };
				report('info', 'local-proxy: disabled by configuration; every request goes direct');
				return;
			}

			try {
				const state = await activate(next);
				applied = { signature, state };
				const url = proxyUrlOf(next);
				if (state.routed) {
					report('info', `local-proxy: network operations now use ${url} (${state.entry})`);
				} else {
					report('warn', `local-proxy: policy installed for ${url} but web_fetch still routes direct — ${state.messages.join(' / ') || 'the loaded proxy module is not the one dsh-web-fetch-http uses'}`);
				}
			} catch (error) {
				applied = { signature, state: undefined };
				report('warn', `local-proxy: cannot install the proxy policy: ${error instanceof Error ? error.message : String(error)}`);
			}
		}).catch(() => { /* already reported */ });
		return queue;
	};

	const ctl = {
		config: () => effective().config,
		state: () => snapshot(effective().config),
		source: () => ({ schema: schemaSource, persisted: { ...persisted }, stateFile: statePath(profileDir) }),
		/**
		 * Store a change and apply it: the `/proxy` path.
		 *
		 * The file is written first so a failed write leaves the running policy
		 * untouched.
		 *
		 * @param patch - fields to persist.
		 * @returns the config now in force.
		 */
		async persist(patch) {
			const next = { ...persisted, ...patch };
			writeState(profileDir, next);
			persisted = next;
			await reconcile();
			return effective().config;
		},
		web() {
			try {
				return ctx.get('web');
			} catch {
				return undefined;
			}
		}
	};

	ctx.tools.register(createProxyTool(ctl));

	// `commands` is a UI service: a headless host has no command surface, and a
	// required injection would keep the whole plugin (and its tool) pending.
	ctx.inject(['commands'], (scoped) => {
		scoped.commands.register(createProxyCommand(ctl));
	});

	ctx.effect(async () => {
		await reconcile();
		return () => deactivate();
	}, 'dsh-local-proxy:install');

	if (schemaSource === 'fallback') {
		report('warn', 'local-proxy: @deepseek-ai/schemastery is missing from the application archive, so no configuration form renders; use `/proxy <port>` or the row config in cordis.patch.yml');
	}
}

/** Remaining snapshot for callers that want the state without a tool round-trip. */
export { snapshot };
