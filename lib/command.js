/**
 * The `/proxy` command: the port is chosen from the composer, not a form.
 *
 * A command runs against the host without becoming a model message, which is
 * exactly the shape this needs: one line in, a proxy URL out, no tokens spent
 * and no file edited by hand. Registration and the command grammar are DSH's
 * (`@deepseek-ai/dsh-commands`); everything below is parsing plus text.
 */

import { proxyUrlOf } from './config.js';

/** Discovery metadata, shared with the package description. */
export const COMMAND_NAME = 'proxy';

/** One-line description the command palette shows. */
export const COMMAND_DESCRIPTION = 'Route DSH network operations through a local HTTP proxy (127.0.0.1:<port>)';

/** Usage text returned for an input this command cannot read. */
const USAGE = 'usage: /proxy <port> | /proxy status | /proxy on | /proxy off | /proxy <http://host:port>';

/** `host:port`, for a proxy that does not listen on loopback. */
const HOST_PORT = /^(?<host>[A-Za-z0-9._-]+):(?<port>\d{1,5})$/u;

/**
 * Read one port argument.
 *
 * @param value - digits as typed.
 * @returns the port, or `undefined` when it is not 1..65535.
 */
function parsePort(value) {
	if (!/^\d{1,5}$/u.test(value)) return undefined;
	const port = Number.parseInt(value, 10);
	return port > 0 && port < 65536 ? port : undefined;
}

/**
 * Turn a command line into the fields to persist.
 *
 * @param rawInput - everything after `/proxy`, separator whitespace included.
 * @returns `{ patch }`, `{ text }` for a read-only answer, or `{ error }`.
 */
export function parseProxyCommand(rawInput) {
	const input = String(rawInput ?? '').trim();
	if (input === '' || input.toLowerCase() === 'status') return { read: true };

	const lower = input.toLowerCase();
	if (lower === 'off' || lower === 'disable') return { patch: { enabled: false } };
	if (lower === 'on' || lower === 'enable') return { patch: { enabled: true } };

	const port = parsePort(input);
	if (port !== undefined) return { patch: { enabled: true, host: '127.0.0.1', port, proxyUrl: '' } };

	if (/^https?:\/\//iu.test(input)) {
		try {
			const url = new URL(input);
			if (url.port === '' && url.protocol === 'http:' && url.hostname === '') throw new Error('no host');
			const parsedPort = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number.parseInt(url.port, 10);
			return { patch: { enabled: true, host: url.hostname, port: parsedPort, proxyUrl: url.origin } };
		} catch {
			return { error: `"${input}" is not a usable proxy URL.` };
		}
	}

	const match = HOST_PORT.exec(input);
	if (match?.groups !== undefined) {
		const hostPort = parsePort(match.groups.port);
		if (hostPort !== undefined) return { patch: { enabled: true, host: match.groups.host, port: hostPort, proxyUrl: '' } };
	}

	if (/^\d+$/u.test(input)) return { error: `port ${input} is outside 1..65535.` };
	return { error: `cannot read "${input}".` };
}

/**
 * Render the current state as one line plus its address.
 *
 * @param config - the effective config.
 * @param state - the policy snapshot.
 * @param persisted - which fields the state file holds.
 * @returns plain text for the composer.
 */
export function renderState(config, state, persisted) {
	const address = proxyUrlOf(config);
	if (state.status !== 'active') {
		return `proxy ${address} — not in force (${state.status})${state.messages.length > 0 ? `\n${state.messages.join('\n')}` : ''}`;
	}
	const route = state.routed
		? 'web_fetch and fetch() both use it'
		: 'installed, but web_fetch still routes direct — check that the running host is the one this plugin patched';
	const saved = Object.keys(persisted).length === 0 ? 'row config' : `saved state (${Object.keys(persisted).join(', ')})`;
	const bypass = config.noProxy === '' ? 'loopback only' : `loopback, ${config.noProxy}`;
	return `proxy ${address}\n${route}\nbypass: ${bypass}\nsource: ${saved}`;
}

/**
 * Build the command definition.
 *
 * @param ctl - plugin control surface: `{ config(), state(), persist(patch), source() }`.
 * @returns a `ctx.commands.register()` definition.
 */
export function createProxyCommand(ctl) {
	const answer = (kind, text) => ({ kind, text });

	return {
		name: COMMAND_NAME,
		description: COMMAND_DESCRIPTION,
		input: { hint: '<port>' },
		async handler({ rawInput }) {
			const parsed = parseProxyCommand(rawInput);
			if (parsed.error !== undefined) return answer('error', `${parsed.error}\n${USAGE}`);
			if (parsed.read === true) return answer('success', renderState(ctl.config(), ctl.state(), ctl.source().persisted));

			try {
				await ctl.persist(parsed.patch);
			} catch (error) {
				return answer('error', `cannot apply the proxy change: ${error instanceof Error ? error.message : String(error)}`);
			}
			return answer('success', renderState(ctl.config(), ctl.state(), ctl.source().persisted));
		}
	};
}
