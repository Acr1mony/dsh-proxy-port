/**
 * Smoke test for the transport half, runnable without DSH.
 *
 * It cannot prove that a *profile* copy of this plugin shares the ESM cache entry
 * with the host's own `@deepseek-ai/dsh-http-proxy` — that needs the real app.asar
 * and the real loader. What it does prove, against a stand-in archive layout:
 *   - the entry is located through `package.json` exports (createRequire),
 *   - `installProxyFromEnvironment` accepts the config's env view,
 *   - the policy answers `proxyRouteFor()` with a proxied route for a remote URL
 *     and a direct route for loopback,
 *   - requests really traverse the proxy, and
 *   - the disposer restores both the route and the environment.
 *
 * Run: node dsh-local-proxy/test/smoke.mjs
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';

import { fixtureRoot } from './fixture.mjs';

process.env.DSH_APP_ASAR = fixtureRoot();

const { normalizeConfig } = await import('../lib/config.js');
const { activate, deactivate, isInstalled, routeFor, snapshot } = await import('../lib/policy.js');

const seen = [];
const proxy = http.createServer((request, response) => {
	seen.push(request.url);
	response.writeHead(200, { 'content-type': 'text/plain' });
	response.end(`via-proxy:${request.url}`);
});
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const proxyPort = proxy.address().port;

const { config } = normalizeConfig({ enabled: true, host: '127.0.0.1', port: proxyPort });

// The host may already have installed a policy from its own environment, so the
// teardown assertions below compare against what was there before this test ran.
const remote = 'https://aiweb.112078.xyz/';
const before = {
	httpProxy: process.env.http_proxy,
	nodeUseEnvProxy: process.env.NODE_USE_ENV_PROXY,
	routed: routeFor(remote).proxied,
	installed: isInstalled(),
};

const state = await activate(config);
assert.equal(state.status, 'active', `expected an active policy: ${JSON.stringify(state)}`);
assert.equal(state.routed, true, 'proxyRouteFor() must answer proxied for a remote HTTPS URL');
assert.ok(state.entry.endsWith('index.js'), `unexpected entry ${state.entry}`);
assert.equal(process.env.http_proxy, `http://127.0.0.1:${proxyPort}`);
assert.equal(process.env.NODE_USE_ENV_PROXY, '1');

assert.equal(routeFor(remote).proxied, true);
assert.equal(routeFor('http://127.0.0.1:9/').proxied, false, 'loopback must stay direct');

const seenBefore = seen.length;
const response = await fetch('http://example.invalid/probe');
assert.equal(response.status, 200);
assert.equal(await response.text(), 'via-proxy:http://example.invalid/probe');
assert.equal(seen.length, seenBefore + 1, 'the request must reach the proxy');
console.log(`ok: fetch traversed the proxy (${seen.at(-1)})`);

await deactivate();
assert.equal(isInstalled(), before.installed, 'disposing must restore the previous policy state');
assert.equal(routeFor(remote).proxied, before.routed, 'disposing must restore the previous route');
assert.equal(process.env.http_proxy, before.httpProxy, 'disposing must restore the environment');
assert.equal(process.env.NODE_USE_ENV_PROXY, before.nodeUseEnvProxy);
assert.notEqual(process.env.http_proxy, `http://127.0.0.1:${proxyPort}`, 'the test policy must be gone');
console.log('ok: dispose restored the previous route and environment');

const disabled = await activate({ ...config, enabled: false });
assert.equal(disabled.status, 'disabled');
assert.equal(snapshot(config).status, 'off');

proxy.close();
console.log('all smoke checks passed');
