/**
 * Plugin configuration: normalized once, never thrown from `apply`.
 *
 * Three inputs share this shape: the row config declared in schema.js, the
 * state file `/proxy` writes (`local-proxy.json`, higher precedence), and the
 * data a `local_proxy` call hands back. Only the command persists.
 */

/** Defaults: a Clash/v2ray-style local HTTP proxy on the common 7890 port. */
export const DEFAULT_CONFIG = Object.freeze({
	enabled: true,
	host: '127.0.0.1',
	port: 7890,
	proxyUrl: '',
	noProxy: '',
	childNodes: true,
	verifyUrl: 'https://example.com/'
});

const KEYS = Object.keys(DEFAULT_CONFIG);

/**
 * Coerce one raw config object into a usable one.
 *
 * Nothing here throws: a bad port falls back to the default and lands in
 * `warnings`, because a proxy plugin that refuses to load would take the whole
 * network stack down with it.
 *
 * @param raw - row config, persisted state, or a `local_proxy` patch.
 * @returns the normalized config plus human-readable warnings.
 */
export function normalizeConfig(raw) {
	const warnings = [];
	const source = raw !== null && typeof raw === 'object' ? raw : {};
	const config = { ...DEFAULT_CONFIG };
	for (const key of KEYS) {
		const value = source[key];
		if (value === undefined || value === null) continue;
		config[key] = value;
	}

	config.enabled = config.enabled !== false && config.enabled !== 'false';
	config.childNodes = config.childNodes !== false && config.childNodes !== 'false';
	config.host = String(config.host ?? '').trim() || DEFAULT_CONFIG.host;
	config.proxyUrl = String(config.proxyUrl ?? '').trim();
	config.noProxy = String(config.noProxy ?? '').trim();
	config.verifyUrl = String(config.verifyUrl ?? '').trim() || DEFAULT_CONFIG.verifyUrl;

	const port = Number.parseInt(String(config.port ?? ''), 10);
	if (Number.isInteger(port) && port > 0 && port < 65536) {
		config.port = port;
	} else {
		warnings.push(`port ${JSON.stringify(config.port)} is not 1..65535; using ${DEFAULT_CONFIG.port}`);
		config.port = DEFAULT_CONFIG.port;
	}

	if (config.host.includes('://')) {
		// Accept a pasted base URL such as `http://127.0.0.1` and keep only its authority.
		try {
			const parsed = new URL(config.host);
			config.host = parsed.hostname;
			if (parsed.port !== '') config.port = Number.parseInt(parsed.port, 10);
			warnings.push(`host looked like a URL; using ${config.host}:${config.port}`);
		} catch {
			warnings.push(`host ${JSON.stringify(config.host)} is not a URL; using it verbatim`);
		}
	}

	const proxyUrl = proxyUrlOf(config);
	if (!isHttpProxyUrl(proxyUrl)) {
		warnings.push(`proxy URL ${JSON.stringify(proxyUrl)} is not an http(s) URL; falling back to http://${DEFAULT_CONFIG.host}:${DEFAULT_CONFIG.port}`);
		config.host = DEFAULT_CONFIG.host;
		config.port = DEFAULT_CONFIG.port;
		config.proxyUrl = '';
	}
	return { config, warnings };
}

/**
 * The single proxy URL every consumer of this plugin uses.
 *
 * @param config - a normalized config.
 * @returns `config.proxyUrl` when set, else `http://host:port`.
 */
export function proxyUrlOf(config) {
	const explicit = String(config?.proxyUrl ?? '').trim();
	if (explicit !== '') return explicit;
	const host = String(config?.host ?? DEFAULT_CONFIG.host).trim() || DEFAULT_CONFIG.host;
	const port = Number.parseInt(String(config?.port ?? DEFAULT_CONFIG.port), 10) || DEFAULT_CONFIG.port;
	return `http://${host}:${port}`;
}

/**
 * Whether a proxy URL is one `dsh-http-proxy` will accept.
 *
 * @param value - candidate proxy URL.
 * @returns true for a parseable `http:` or `https:` URL.
 */
export function isHttpProxyUrl(value) {
	try {
		const parsed = new URL(String(value));
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

/**
 * Split proxy URL into the host/port a TCP reachability probe needs.
 *
 * @param value - a proxy URL.
 * @returns `{ host, port }`, defaulting to 80/443 by scheme.
 */
export function proxyAddress(value) {
	const parsed = new URL(String(value));
	const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number.parseInt(parsed.port, 10);
	return { host: parsed.hostname, port };
}

/** Fields a caller may override through the tool; the rest is not user-serviceable. */
export const SETTABLE_KEYS = Object.freeze(['enabled', 'host', 'port', 'proxyUrl', 'noProxy', 'childNodes', 'verifyUrl']);
