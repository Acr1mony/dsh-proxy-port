# dsh-local-proxy

English | [中文](./README.zh.md)

Route DeepSeek Harness's own network calls — `web_fetch`, `fetch()`, anything that goes through undici — through a local HTTP proxy, chosen from the composer instead of a config file.

```text
you:    /proxy 7897
plugin: proxy http://127.0.0.1:7897
        web_fetch and fetch() both use it
        bypass: loopback only
        source: saved state (enabled, host, port, proxyUrl)
```

## Why this needs a plugin

`web_fetch` does not decide about proxies itself. It asks `@deepseek-ai/dsh-http-proxy`'s `proxyRouteFor(url)`, which reads that module's process-wide state: an installed policy, or "direct + DNS pinning". Two consequences follow.

- Installing a private undici dispatcher is not enough. `web_fetch` would still see "direct" and keep pinning DNS, while plain `fetch()` took another route. The two halves would disagree, and only one of them is the tool the model actually calls.
- Setting `HTTP_PROXY` in the environment is not enough either. The module snapshots the launch environment, so a variable set after boot is not what it routes by.

So this plugin drives the real thing, in the copy of the module the host already imported:

1. `createRequire()` against `resources/app.asar` resolves the true entry of `@deepseek-ai/dsh-http-proxy`; a profile plugin cannot resolve `@deepseek-ai/*` by name — see [Install](#install).
2. `import(pathToFileURL(entry))` loads that same file. ESM caches by URL, so this is the host's module instance, not a second copy.
3. `installProxyFromEnvironment(env, report)` is called with a `Map` that answers `env.get('http_proxy').value`, the only shape that module reads.

The installed policy replaces the global undici dispatcher with a `ProxyAgent` factory and publishes `http_proxy` / `https_proxy` / `all_proxy` / `no_proxy` into `process.env`, so libraries that read the environment — and spawned children — agree with it.

Loopback addresses always bypass the proxy. SOCKS and PAC are rejected by that module: only `http:` / `https:` proxies are accepted.

## Install

Requirements:

- DeepSeek Harness desktop (the Electron build; the plugin locates the application archive to reach the host's own modules).
- Node `^22.19 || >=24` inside that app.
- A local HTTP proxy that speaks `CONNECT` (Clash, Clash Verge, v2ray, mitmproxy, …).

### A. Register as a profile bundle (recommended)

A profile plugin is a bundle: the plugin page lists bundles, so a bare loader row never appears there. From a checkout at `E:\path\to\dsh-local-proxy`, edit `~/.dsh/profiles/<profile>/package.json` (on the desktop build the profile is `desktop`):

```jsonc
{
  "dependencies": { "dsh-local-proxy": "file:E:\\path\\to\\dsh-local-proxy" },
  "dsh": { "profile": { "bundles": ["…", "dsh-local-proxy"] } }
}
```

Add a row override in the same directory's `cordis.patch.yml` — the row itself comes from this package's `cordis.patch.yml`, the profile only overrides defaults:

```yaml
- id: dsh-local-proxy
  name: dsh-local-proxy
  config:
    enabled: true
    host: 127.0.0.1
    port: 7890
    proxyUrl: ''
    noProxy: ''
    childNodes: true
    verifyUrl: https://example.com/
```

Restart the application.

### B. Let DSH install it

Ask the `plugin_manager` tool to run `install_bundle` with `spec: "file:E:\\path\\to\\dsh-local-proxy"`. The `file:` spec is written into dependencies verbatim, and because this package declares `dsh.bundle.patch`, `reconcile()` also adds it to `dsh.profile.bundles`. This needs `danger-full-access` or manual approval, and still needs a restart.

## Usage

The port is a command, not a field. `/proxy` runs in the host, produces no model message, and costs no tokens.

| Input | Effect |
| --- | --- |
| `/proxy 7897` | Use `http://127.0.0.1:7897` now, and from the next start |
| `/proxy` · `/proxy status` | Current address, whether `web_fetch` really uses it, bypass list, source |
| `/proxy off` · `/proxy on` | Uninstall / reinstall the policy (off restores the route that was in force before it) |
| `/proxy http://10.0.0.5:3128` | Full URL — also for an `https:` proxy or a non-loopback host |
| `/proxy 10.0.0.5:3128` | `host:port` |
| anything else | Usage text; nothing changes |

`/proxy` needs DSH's `commands` service (part of the base layer and of the Web client). The plugin asks for it optionally: a headless host without a command surface keeps the tool and skips the command instead of staying unmounted.

### Where the value is stored

`<profile>/local-proxy.json`, written by the command:

```json
{ "enabled": true, "host": "127.0.0.1", "port": 7897, "proxyUrl": "" }
```

Precedence: state file → row config → built-in defaults. The row config is what ships; the state file is what you chose. Nothing here *has* to be edited by hand.

## Tool: `local_proxy`

The model-side view of the same state — for evidence, not convenience.

| Action | What it answers |
| --- | --- |
| `status` | Is the policy installed? Which module file, which proxy URL, does `proxyRouteFor(verifyUrl)` say proxied, what is persisted |
| `set` | Same effect as `/proxy`: change host/port/enabled/noProxy, persist, apply immediately |
| `diagnose` | TCP reachability of the proxy port plus the route for one URL — no business request |
| `test` | A real request (global `fetch`, then optionally `ctx.web.fetch`) and which route it took |

## Configuration reference

Row config keys, all optional:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` uninstalls the policy; every request goes direct |
| `host` / `port` | `127.0.0.1` / `7890` | Proxy address; a bad port falls back to 7890 with a warning instead of failing the plugin |
| `proxyUrl` | `''` | Full proxy URL such as `http://127.0.0.1:7897`; wins over host/port |
| `noProxy` | `''` | Comma-separated bypass hosts; loopback is always bypassed |
| `childNodes` | `true` | Publish the proxy variables plus `NODE_USE_ENV_PROXY=1` for child processes |
| `verifyUrl` | `https://example.com/` | Target that `status` / `diagnose` / `test` use by default |

## Tests

```bash
node test/smoke.mjs     # real traffic traverses a proxy; dispose restores the previous route
node test/apply.mjs     # mount, tool + command registration, persisted toggle, unmount
node test/command.mjs   # /proxy parsing, persistence, remount keeps the chosen port
```

- `smoke.mjs` starts a local proxy and asserts that the environment is published, `proxyRouteFor` says proxied, `fetch()` really traverses the proxy, loopback stays direct, and dispose restores both the route and the environment.
- `apply.mjs` mounts with a fake host context: `apply(ctx, config)` must register the tool and `/proxy`, `ctx.effect()` must install the policy, a persisted change must toggle it, and the disposer must uninstall it.
- `command.mjs` drives the command itself, including rejected input (`abc`, `70000`, `0`, `host:99999`), `on` / `off` / `status`, a full URL, and a remount that must still run on the persisted port.

The tests need a Node binary — no DSH installation — but one thing cannot come from this repository: an archive root to resolve the host's modules through. Plain Node cannot read a packed `.asar`, yet resolution is by path, so a *directory* with that name works. Copy `@deepseek-ai/dsh-http-proxy` and `undici` out of an installed DeepSeek Harness into `<root>/resources/app.asar/dsh/node_modules/`, then point `DSH_LOCAL_PROXY_FIXTURE` at `<root>` (the lookup also tries `fixture/` in the repository and the author's private `_probe` tree). Without a HTTP proxy library present, `apply.mjs` still passes — the plugin warns and skips the install, which is the fallback it ships.

## Limitations

- **In-process Node only.** `fetch`, undici, and libraries that read `http_proxy`. A shell's `curl` or Python's `requests` follow their own environment, which `childNodes` only publishes — whether a child inherits it is the host's spawn policy.
- **HTTP CONNECT only.** No SOCKS5, no PAC; both are refused by the host module, not by this plugin.
- **Electron archive layout.** The module is located under `resources/app.asar`; `DSH_APP_ASAR` overrides the location for an unusual install.
- **One proxy per process.** That is the granularity of the host's policy; a per-request proxy is not offered.

## License

MIT
