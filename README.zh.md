# dsh-local-proxy

[English](./README.md) | 中文

在输入框敲一条 `/proxy 7897`，之后 DeepSeek Harness 进程内的出站 HTTP(S) 全部经本地代理出去 —— 端口在对话里选，不用翻配置文件。

```text
你：  /proxy 7897
插件：proxy http://127.0.0.1:7897
       web_fetch and fetch() both use it
       bypass: loopback only
       source: saved state (enabled, host, port, proxyUrl)
```

## 为什么必须做成插件

`web_fetch` 自己不做代理判断，它问的是 `@deepseek-ai/dsh-http-proxy` 的 `proxyRouteFor(url)`，而那个函数读的是该模块的进程级状态：要么"已安装策略"，要么"直连 + DNS 锁定"。

于是有两条看似可行、实际无效的路：

- **自己另装一个 undici dispatcher 不够。** `web_fetch` 仍然拿到"直连"并继续锁 DNS，而裸 `fetch()` 走了另一条路 —— 两半不一致，而模型真正调用的是前者。
- **在环境里设 `HTTP_PROXY` 也不够。** 该模块读的是启动环境快照，启动之后再设的变量不参与路由判定。

因此本插件驱动的是真实的那份状态，而且在宿主已经加载的那个模块实例上：

1. 以 `resources/app.asar` 为基准用 `createRequire()` 解析 `@deepseek-ai/dsh-http-proxy` 的真实入口（profile 插件按包名解析不到 `@deepseek-ai/*`，见[安装](#安装)）；
2. 用 `import(pathToFileURL(入口))` 加载同一个文件 —— ESM 按 URL 缓存，所以拿到的是宿主的实例，不是第二份拷贝；
3. 调用它的 `installProxyFromEnvironment(env, report)`，`env` 是一个能回答 `env.get('http_proxy').value` 的 `Map` 视图，这是该模块唯一读取的形状。

装上策略后：全局 undici dispatcher 换成 `ProxyAgent` 工厂，同时把 `http_proxy` / `https_proxy` / `all_proxy` / `no_proxy` 写进 `process.env`，于是读环境变量的库和派生出的子进程也跟随。

回环地址永远直连。SOCKS 与 PAC 被该模块拒绝：只接受 `http:` / `https:` 代理。

## 安装

环境要求：

- DeepSeek Harness 桌面版（Electron 构建；插件要定位应用归档才能拿到宿主自己的模块）；
- 该应用内置 Node `^22.19 || >=24`；
- 一个支持 `CONNECT` 的本地 HTTP 代理（Clash、Clash Verge、v2ray、mitmproxy 等）。

### A. 注册成 profile bundle（推荐）

profile 插件就是一个 bundle：侧栏「插件」页只列 bundle，裸的 loader 行不会出现在那里。假设源码在 `E:\path\to\dsh-local-proxy`，编辑 `~/.dsh/profiles/<profile>/package.json`（桌面版 profile 名为 `desktop`）：

```jsonc
{
  "dependencies": { "dsh-local-proxy": "file:E:\\path\\to\\dsh-local-proxy" },
  "dsh": { "profile": { "bundles": ["…", "dsh-local-proxy"] } }
}
```

在同目录的 `cordis.patch.yml` 里加一条行覆盖 —— 行本身由本包自己的 `cordis.patch.yml` 提供，profile 只覆盖默认值：

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

重启应用。

### B. 让 DSH 自己装

对 `plugin_manager` 工具执行 `install_bundle`，`spec: "file:E:\\path\\to\\dsh-local-proxy"`。
`file:` 形式的 spec 会被原样写进依赖；又因为本包声明了 `dsh.bundle.patch`，`reconcile()` 会把它同时加进 `dsh.profile.bundles`。这条路径需要 `danger-full-access` 或人工批准，并且同样要重启。

## 用法

端口是一个命令，不是一个输入框。`/proxy` 在宿主里直接执行：不产生模型消息，不消耗 token。

| 输入 | 效果 |
| --- | --- |
| `/proxy 7897` | 改用 `http://127.0.0.1:7897`，立即生效，下次启动仍是它 |
| `/proxy` · `/proxy status` | 当前地址、`web_fetch` 是否真的走代理、直连名单、来源 |
| `/proxy off` · `/proxy on` | 卸载 / 重新安装策略（off 还原为插件安装前的路由） |
| `/proxy http://10.0.0.5:3128` | 完整 URL，也用于 `https:` 代理或非本机 host |
| `/proxy 10.0.0.5:3128` | `host:port` 形式 |
| 其它 | 返回用法说明，不改动任何状态 |

`/proxy` 依赖 DSH 的 `commands` 服务（基础层自带，Web 客户端也用）。插件以可选注入方式获取它：没有命令面的无头宿主会保留工具、跳过命令，而不是整个插件挂起。

### 值存在哪里

`<profile>/local-proxy.json`，由命令写入：

```json
{ "enabled": true, "host": "127.0.0.1", "port": 7897, "proxyUrl": "" }
```

优先级：状态文件 → 行配置 → 内置默认值。行配置是"出厂设置"，状态文件是"你选的那个"。这里没有任何一项**必须**手改。

## 工具：`local_proxy`

同一份状态的模型侧视图，用于取证而不是图方便。

| action | 回答什么 |
| --- | --- |
| `status` | 策略是否安装；用的是哪个模块文件、哪个代理 URL；`proxyRouteFor(verifyUrl)` 是否判定为代理；已持久化哪些字段 |
| `set` | 与 `/proxy` 等价：改 host/port/enabled/noProxy，落盘并立即生效 |
| `diagnose` | 代理端口的 TCP 连通性 + 某条 URL 的路由判定，不发业务请求 |
| `test` | 真发一次请求（先全局 `fetch`，再可选 `ctx.web.fetch`），报告走了哪条路 |

## 配置项

行配置的键（都可省略）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 卸载策略，所有请求直连 |
| `host` / `port` | `127.0.0.1` / `7890` | 代理地址；端口非法时回落 7890 并告警，不会让插件加载失败 |
| `proxyUrl` | `''` | 完整代理 URL，如 `http://127.0.0.1:7897`，优先于 host/port |
| `noProxy` | `''` | 逗号分隔的直连主机；回环地址始终直连 |
| `childNodes` | `true` | 为子进程发布代理变量以及 `NODE_USE_ENV_PROXY=1` |
| `verifyUrl` | `https://example.com/` | `status` / `diagnose` / `test` 默认使用的目标 |

## 测试

```bash
node test/smoke.mjs     # 真实流量穿过代理；dispose 复原此前的路由
node test/apply.mjs     # 挂载、注册工具与 /proxy、持久化开关、卸载
node test/command.mjs   # /proxy 解析、落盘、重新挂载后仍是新端口
```

- `smoke.mjs`：起一个本地代理，断言环境变量已发布、`proxyRouteFor` 判定为代理、`fetch()` 真的穿过代理、回环仍直连、dispose 后路由与环境都复原。
- `apply.mjs`：用假的宿主上下文挂载：`apply(ctx, config)` 必须注册工具与 `/proxy`，`ctx.effect()` 必须安装策略，一次持久化改动必须能开关策略，disposer 必须卸载。
- `command.mjs`：直接驱动命令，覆盖非法输入（`abc`、`70000`、`0`、`host:99999`）、`on` / `off` / `status`、完整 URL，以及"重新挂载后仍用持久化的端口"。

测试只需要一个 Node 二进制，不需要装 DSH —— 但有一件东西没法随仓库走：一个能让插件解析到宿主模块的归档根目录。Node 读不了打包好的 `.asar`，而解析是按路径走的，所以叫这个名字的*目录*同样有效：把已安装的 DeepSeek Harness 里的 `@deepseek-ai/dsh-http-proxy` 与 `undici` 拷进 `<root>/resources/app.asar/dsh/node_modules/`，再把 `DSH_LOCAL_PROXY_FIXTURE` 指向 `<root>`（查找顺序还包括仓库内的 `fixture/` 与作者私有的 `_probe` 目录）。归档里没有代理库时 `apply.mjs` 仍会通过 —— 插件会告警并跳过安装，这正是它自带的回退路径。

## 边界

- **只覆盖进程内的 Node 侧。** 即 `fetch`、undici，以及读 `http_proxy` 的库。shell 里的 `curl`、Python 的 `requests` 走各自的环境变量，`childNodes` 只负责把变量发布出去 —— 子进程是否继承取决于宿主的 spawn 策略。
- **只支持 HTTP CONNECT。** 不支持 SOCKS5 与 PAC，这是宿主模块的限制，不是本插件的取舍。
- **依赖 Electron 的归档布局。** 模块位于 `resources/app.asar` 下；非典型安装可用 `DSH_APP_ASAR` 指定位置。
- **一个进程一个代理。** 这是宿主策略的粒度；不提供按请求切换代理。

## 许可证

MIT
