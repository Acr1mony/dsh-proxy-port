/**
 * `/proxy` test: the composer command must change the port, persist it, and
 * survive a remount.
 *
 * What the host provides is faked exactly as far as the plugin uses it — a
 * `commands` service that captures the definition, a `tools` registry, `effect`,
 * and `profileContext`. Everything below asserts observable behavior: the route
 * `web_fetch` would take, the text the composer shows, and the state file.
 *
 * Run: node dsh-proxy-port/test/command.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { fixtureRoot } from './fixture.mjs';

process.env.DSH_APP_ASAR = fixtureRoot();

const plugin = await import('../lib/index.js');
const { isInstalled, routeFor } = await import('../lib/policy.js');

/** One live proxy candidate: anything that accepts TCP on its port. */
const proxy = http.createServer((_request, response) => response.end('ok'));
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const proxyPort = proxy.address().port;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proxy-port-command-'));

/**
 * Mount the plugin against a fake host.
 *
 * @param port - the row config port, which the persisted state must be able to override.
 * @returns the captured command, the tool, and a disposer.
 */
async function mount(port) {
	const registered = [];
	const commands = [];
	let disposer;
	let activation;
	const ctx = {
		baseUrl: path.join(profile, 'cordis.yml'),
		tools: { register: (tool) => registered.push(tool) },
		inject(_names, callback) {
			return callback({ commands: { register: (definition) => commands.push(definition) } });
		},
		effect(callback) {
			activation = Promise.resolve(callback()).then((value) => {
				disposer = value;
				return value;
			});
			return activation;
		},
		get(name) {
			if (name === 'tools') return ctx.tools;
			if (name === 'profileContext') return { dir: profile, patchPath: path.join(profile, 'cordis.patch.yml') };
			return undefined;
		},
		logger: { info: () => {}, warn: () => {}, error: () => {} },
	};
	plugin.apply(ctx, plugin.Config({ host: '127.0.0.1', port }));
	await activation;
	assert.equal(registered.length, 1);
	assert.equal(commands.length, 1, 'the /proxy command must be registered');
	return { command: commands[0], tool: registered[0], dispose: disposer };
}

const first = await mount(1);
assert.equal(first.command.name, 'proxy');
assert.equal(typeof first.command.handler, 'function');
assert.equal(first.command.input.hint, '<port>');

// The row config's unusable port is replaced by the command.
const applied = await first.command.handler({ rawInput: ` ${proxyPort}` });
assert.equal(applied.kind, 'success', applied.text);
assert.match(applied.text, new RegExp(`http://127\\.0\\.0\\.1:${proxyPort}`, 'u'));
assert.match(applied.text, /web_fetch and fetch\(\) both use it/u);
assert.equal(isInstalled(), true);
assert.equal(routeFor('https://aiweb.112078.xyz/').proxied, true);

const stateFile = path.join(profile, 'local-proxy.json');
const stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
assert.equal(stored.port, proxyPort);
assert.equal(stored.host, '127.0.0.1');
assert.equal(stored.enabled, true);

// Bare `/proxy` reports instead of changing anything.
const status = await first.command.handler({ rawInput: '' });
assert.equal(status.kind, 'success');
assert.match(status.text, new RegExp(`:${proxyPort}`, 'u'));
assert.match(status.text, /source: saved state/u);

// Off, on, and unreadable input.
const off = await first.command.handler({ rawInput: 'off' });
assert.equal(off.kind, 'success');
assert.equal(isInstalled(), false);
assert.match(off.text, /not in force/u);

const on = await first.command.handler({ rawInput: 'on' });
assert.equal(on.kind, 'success');
assert.equal(isInstalled(), true);

for (const rawInput of ['abc', '70000', '0', '127.0.0.1:99999']) {
	const rejected = await first.command.handler({ rawInput });
	assert.equal(rejected.kind, 'error', `"${rawInput}" must be rejected`);
	assert.match(rejected.text, /usage: \/proxy/u);
}

// A full URL is accepted too, and keeps its scheme.
const viaUrl = await first.command.handler({ rawInput: `http://127.0.0.1:${proxyPort}` });
assert.equal(viaUrl.kind, 'success');
assert.match(viaUrl.text, new RegExp(`http://127\\.0\\.0\\.1:${proxyPort}`, 'u'));

await first.dispose();
assert.equal(isInstalled(), false);

// A remount starts from the persisted value, not from the row config.
const second = await mount(1);
assert.equal(routeFor('https://aiweb.112078.xyz/').proxied, true);
const afterRemount = await second.tool.execute({ action: 'status' });
assert.match(afterRemount.detail, new RegExp(`"port":${proxyPort}`, 'u'), 'the persisted port must survive a remount');
assert.match(afterRemount.message, new RegExp(`:${proxyPort}`, 'u'));

await second.dispose();
proxy.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log('all /proxy command checks passed');
