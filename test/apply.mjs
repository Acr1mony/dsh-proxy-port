/**
 * Wiring test for the plugin entry, without DSH.
 *
 * Exercises exactly what the host does with a profile row: `inject` must list
 * `tools`, `apply(ctx, config)` must register the tool and hand its activation
 * back through `ctx.effect()`, and disposing that effect must restore the route.
 *
 * Run: node dsh-local-proxy/test/apply.mjs
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

assert.equal(plugin.name, 'dsh-local-proxy');
assert.deepEqual(plugin.inject, ['tools']);
assert.equal(typeof plugin.apply, 'function');

const proxy = http.createServer((_request, response) => response.end('ok'));
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-local-proxy-'));
const registered = [];
const commands = {
	list: [],
	register(definition) {
		commands.list.push(definition);
		return () => {};
	},
};
let disposer;
let activation;

const ctx = {
	baseUrl: path.join(profile, 'cordis.yml'),
	tools: { register: (tool) => registered.push(tool) },
	inject(names, callback) {
		assert.deepEqual(names, ['commands'], 'the command surface is the only optional service');
		return callback({ commands });
	},
	effect(callback) {
		activation = Promise.resolve(callback()).then((value) => {
			if (typeof value !== 'function') throw new Error('effect must resolve to a disposer');
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
	logger: {
		info: (message) => console.log('[info]', message),
		warn: (message) => console.log('[warn]', message),
		error: (message) => console.log('[error]', message),
	},
};

plugin.apply(ctx, plugin.Config({ host: '127.0.0.1', port: proxy.address().port }));
await activation;

assert.equal(registered.length, 1, 'the tool must be registered once');
const tool = registered[0];
assert.equal(tool.name, 'local_proxy');
assert.equal(typeof tool.execute, 'function');
assert.equal(commands.list.length, 1, 'the /proxy command must be registered once');
assert.equal(commands.list[0].name, 'proxy');

assert.equal(isInstalled(), true, 'apply() must install the policy');
assert.equal(routeFor('https://aiweb.112078.xyz/').proxied, true);

const status = await tool.execute({ action: 'status' });
assert.equal(status.ok, true);
assert.match(status.detail, /routed=true/);

const off = await tool.execute({ action: 'set', enabled: false });
assert.equal(off.ok, true);
assert.equal(isInstalled(), false, 'a persisted change must be able to disable the policy');
assert.match((await tool.execute({ action: 'status' })).detail, /saved=\{"enabled":false\}/);

const on = await tool.execute({ action: 'set', enabled: true });
assert.equal(on.ok, true);
assert.equal(isInstalled(), true, 'a persisted change must be able to reinstall the policy');

if (typeof disposer !== 'function') throw new Error('no disposer captured');
await disposer();
assert.equal(isInstalled(), false, 'unloading the plugin must uninstall the policy');
assert.equal(routeFor('https://aiweb.112078.xyz/').proxied, false);

proxy.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log('all apply() wiring checks passed');
