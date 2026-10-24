/**
 * The model-facing `local_proxy` tool.
 *
 * Its job is evidence, not configuration convenience: after `apply` installs a
 * policy the agent needs one call that says which proxy URL is live, whether
 * `web_fetch`'s own router agrees, and whether the port answers at all.
 */

import { proxyAddress, proxyUrlOf, SETTABLE_KEYS } from './config.js';
import { probeProxy, routeFor, snapshot } from './policy.js';

/**
 * Read a response body as text with a byte cap, without trusting its length.
 *
 * @param response - a fetch Response.
 * @param limit - maximum characters retained.
 * @returns the retained text and the full byte count when known.
 */
async function readText(response, limit = 400) {
	try {
		const text = await response.text();
		return { text: text.slice(0, limit), length: text.length };
	} catch (error) {
		return { text: `(body unreadable: ${error instanceof Error ? error.message : String(error)})`, length: 0 };
	}
}

/**
 * Build the tool definition.
 *
 * @param ctl - plugin control surface: `{ config(), apply(next), web() }`.
 * @returns a registry-ready tool definition.
 */
export function createProxyTool(ctl) {
	const renderState = (state) => [
		`status=${state.status} proxy=${state.proxyUrl || '(none)'} routed=${state.routed}`,
		`module=${state.entry || '(not loaded)'}`,
		`env http_proxy=${state.processEnv.http_proxy || '(unset)'} https_proxy=${state.processEnv.https_proxy || '(unset)'} NODE_USE_ENV_PROXY=${state.processEnv.NODE_USE_ENV_PROXY || '(unset)'}`,
		...(state.messages.length > 0 ? [`messages: ${state.messages.join(' / ')}`] : [])
	].join('\n');

	return {
		name: 'local_proxy',
		description:
			'Inspect and change the process-wide local HTTP proxy that DSH network operations use (default http://127.0.0.1:7890). '
			+ 'Users change the port from the composer with /proxy <port>; this tool is the model-side view of the same state. '
			+ 'Actions: status (current proxy, whether web_fetch routes through it, published env), '
			+ 'set (change host/port/enabled/noProxy and persist it, the same effect as /proxy), '
			+ 'diagnose (TCP reachability of the proxy port plus the route web_fetch would take), '
			+ 'test (fetch a URL through the proxy and report status and bytes).',
		parameters: {
			type: 'object',
			additionalProperties: false,
			required: ['action'],
			properties: {
				action: {
					type: 'string',
					enum: ['status', 'set', 'diagnose', 'test'],
					description: 'What to do.'
				},
				host: { type: 'string', description: 'set: proxy host, default 127.0.0.1.' },
				port: { type: 'integer', description: 'set: proxy port, 1-65535.' },
				proxyUrl: { type: 'string', description: 'set: full proxy URL (http:// or https://); overrides host and port.' },
				enabled: { type: 'boolean', description: 'set: turn the proxy policy on or off.' },
				noProxy: { type: 'string', description: 'set: comma-separated bypass list; loopback is always bypassed.' },
				url: { type: 'string', description: 'diagnose/test: URL to inspect, defaults to the configured verifyUrl.' }
			}
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				required: ['action', 'ok', 'message'],
				properties: {
					action: { type: 'string' },
					ok: { type: 'boolean' },
					message: { type: 'string' },
					detail: { type: 'string' }
				}
			},
			render: (_args, value) => [{
				type: 'text',
				text: `${value.ok ? 'OK' : 'FAIL'} local_proxy ${value.action}: ${value.message}${value.detail === undefined ? '' : `\n${value.detail}`}`
			}]
		},
		timeoutMs: 60_000,
		isConcurrencySafe: () => false,
		async execute(args) {
			const action = args.action;
			try {
				if (action === 'status') {
					const state = snapshot(ctl.config());
					return {
						action,
						ok: state.status === 'active',
						message: state.status === 'active'
							? `all network operations go through ${state.proxyUrl}`
							: `no proxy policy is in force (status=${state.status})`,
						detail: [
							renderState(state),
							`config: schema=${ctl.source().schema} saved=${JSON.stringify(ctl.source().persisted)} (${ctl.source().stateFile})`
						].join('\n')
					};
				}

				if (action === 'set') {
					const patch = {};
					for (const key of SETTABLE_KEYS) if (args[key] !== undefined) patch[key] = args[key];
					const config = await ctl.persist(patch);
					const state = snapshot(config);
					return {
						action,
						ok: config.enabled ? state.routed : true,
						message: config.enabled
							? `proxy now ${proxyUrlOf(config)}; saved to ${ctl.source().stateFile}`
							: 'proxy policy disabled and saved',
						detail: renderState(state)
					};
				}

				if (action === 'diagnose') {
					const config = ctl.config();
					const route = routeFor(args.url ?? config.verifyUrl);
					const probe = config.enabled ? await probeProxy(config) : { reachable: false, host: '', port: 0, latencyMs: 0 };
					const target = args.url ?? config.verifyUrl;
					return {
						action,
						ok: probe.reachable && route.proxied,
						message: probe.reachable
							? `${probe.host}:${probe.port} accepts TCP connections in ${probe.latencyMs}ms; ${target} routes ${route.proxied ? `through ${route.proxy}` : 'DIRECT'}`
							: `${probe.host}:${probe.port} is not reachable${probe.error === undefined ? '' : ` (${probe.error})`}`,
						detail: [
							`proxy URL: ${config.enabled ? proxyUrlOf(config) : '(disabled)'}`,
							`route for ${target}: ${route.proxied ? `proxied via ${route.proxy}` : 'direct'}`,
							`policy module: ${snapshot(config).entry || '(not loaded)'}`,
							`process env: http_proxy=${process.env.http_proxy ?? '(unset)'} https_proxy=${process.env.https_proxy ?? '(unset)'}`
						].join('\n')
					};
				}

				if (action === 'test') {
					const config = ctl.config();
					const url = args.url ?? config.verifyUrl;
					const route = routeFor(url);
					const startedAt = Date.now();
					const signal = AbortSignal.timeout(20_000);
					let lines = [`url: ${url}`, `route: ${route.proxied ? `proxied via ${route.proxy}` : 'direct'}`];

					let ok = false;
					let summary = '';
					try {
						const response = await fetch(url, { signal, redirect: 'follow' });
						const body = await readText(response);
						ok = response.ok;
						summary = `HTTP ${response.status} in ${Date.now() - startedAt}ms, ${body.length} chars`;
						lines.push(`fetch: ${summary}`, `body head: ${body.text.replace(/\s+/gu, ' ').slice(0, 200)}`);
					} catch (error) {
						summary = `fetch failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
						lines.push(summary);
					}

					const web = ctl.web();
					if (web !== undefined && typeof web.fetch === 'function') {
						try {
							const startedWeb = Date.now();
							const result = await web.fetch({ url }, AbortSignal.timeout(20_000));
							const size = typeof result?.content === 'string' ? result.content.length : typeof result?.text === 'string' ? result.text.length : 0;
							lines.push(`web_fetch: ok in ${Date.now() - startedWeb}ms, ${size} chars`);
						} catch (error) {
							lines.push(`web_fetch: failed — ${error instanceof Error ? error.message : String(error)}`);
						}
					}

					return { action, ok: ok && route.proxied, message: summary, detail: lines.join('\n') };
				}

				return { action: String(action), ok: false, message: `unknown action ${JSON.stringify(action)}` };
			} catch (error) {
				return {
					action: String(action),
					ok: false,
					message: error instanceof Error ? error.message : String(error)
				};
			}
		}
	};
}

/** Exported for the smoke test: the address a diagnose call would probe. */
export { proxyAddress };
