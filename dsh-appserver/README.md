# dsh-appserver

独立的 DSH App Server。它直接使用 DSH Cordis 原生服务，为 Flowix 提供接近 Codex app-server 的 Thread、Turn、Item 和管理接口，不依赖旧版 Flowix bridge。

## 架构

```text
stdio / HTTP / SSE
        ↓
DshAppServer（握手、校验、调度、错误映射）
        ↓
Resource Methods（Thread / Turn / Command / Model / Credential / Runtime / Session）
        ↓
NativeDshAdapter
        ↓
DSH Services（agents / sessions / persistence / llm / settings / credentials）
```

进程内 Agent 句柄和流式投影状态由 `AgentRuntimeRegistry` 管理；持久历史始终以 DSH Session event log 为事实源。通知投影放在 `projections/` 中，协议级校验和领域错误放在 `protocol/` 中。

Session 只读访问与查询、Thread/Turn 生命周期、附件准入、命令与 Skill、模型目录、模型配置、凭证管理和 Runtime 能力探测分别由独立 Service 负责。`NativeDshAdapter` 保留为兼容门面。

## 接口

- 生命周期：`initialize`、`shutdown`
- Thread：`thread/start`、`thread/resume`、`thread/read`、`thread/list`、`thread/fork`、`thread/close`、`thread/archive`
- Turn：`turn/start`、`turn/steer`、`turn/interrupt`、`thread/turns/list`
- 历史：`thread/events/list`、`session/history`
- 命令：`thread/command`、`thread/skills`
- 模型：`model/catalog`、`model/discover`、`model/config/*`
- 凭证：`credential/read`、`credential/set`、`credential/unset`
- Runtime：`runtime/capabilities`、`runtime/status`
- Session：`session/flush`、`session/ensure`、`session/prompt`、`session/dispose`、`run/cancel`

`initialize` 返回的 capabilities 根据当前 Cordis Context 中实际存在的服务动态生成。Flowix 自有扩展统一使用 `flowix/*` 命名空间。

## Transport

### stdio

stdio 使用 JSONL，一行一个 JSON-RPC 消息。相同 Thread 的请求串行，不同 Thread 可以并行。

### HTTP / SSE

- `POST /rpc`
- `GET /events?threadId=<id>&afterSeq=<seq>&clientId=<id>`
- `GET /readyz`
- `GET /healthz`

HTTP 默认监听 `127.0.0.1`。SSE 支持 `Last-Event-ID`、事件 `id`、心跳、慢客户端背压，以及回放和实时事件之间的缓冲去重。

HTTP 配置项：

```yaml
http:
  host: 127.0.0.1
  port: 0
  maxBodyBytes: 1048576
  heartbeatMs: 15000
  maxSseConnections: 64
  maxReplayEvents: 5000
  authToken: optional-local-secret
  secureClientIdentity: false
  pairingMaxAttempts: 5
  pairingWindowMs: 60000
  pairingBlockMs: 300000
  requestTimeoutMs: 30000
  headersTimeoutMs: 15000
  keepAliveTimeoutMs: 5000
  clientIdentityTtlMs: 86400000
```

移动端推荐流程：

```text
POST /auth/pair       配对设备，获得 accessToken / refreshToken
POST /auth/refresh    刷新 Token（刷新后旧 accessToken 失效）
POST /rpc             发送 JSON-RPC 命令
GET  /events          SSE 实时事件（accessToken 可放 query，供原生 EventSource 使用）
GET  /sync            前台恢复后按 afterSeq 补事件
GET  /exports/:id     下载受认证的临时导出文件
POST /auth/revoke     撤销当前设备
```

移动认证可通过 `http.mobileAuth.pairingSecret` 开启，建议同时设置 `persistencePath` 持久化设备 Token。移动 Web 需要显式配置 `allowedOrigins`；原生 App 不需要 CORS。

Server 配置支持 `server.maxQueuedRequests`。设置 `telemetry: true` 后会通过 Cordis logger 输出脱敏的 RPC 完成事件，只包含方法、请求 ID、连接 ID、Thread ID、耗时、结果状态和队列统计，不记录 prompt、凭证或附件内容。也可以传入自定义 `observer(event)`。

长历史保护配置：

```yaml
server:
  connectionTtlMs: 86400000
  history:
    concurrency: 2
    maxQueued: 16
    timeoutMs: 3000
    warningEvents: 5000
    maxProjectionEvents: 20000
    maxResultBytes: 10485760
  projection:
    maxSessions: 64
    ttlMs: 300000
    maxEstimatedBytes: 67108864
  workers:
    size: 2
    thresholdEvents: 5000
    timeoutMs: 5000
  exports:
    inlineBytes: 1048576
    maxBytes: 104857600
    ttlMs: 900000
```

超过限制时返回稳定的 `history_too_large` 或 `result_too_large`，不会继续占用实时 Turn、Approval 和 SSE 所需的执行资源。

设置 `authToken` 后，除 `/readyz` 外的请求必须携带 `Authorization: Bearer <token>`。如果监听非回环地址，宿主必须配置认证和 TLS。

启用 `secureClientIdentity` 后，首次 `initialize` 会通过 `x-dsh-client-id` 和 `x-dsh-client-secret` 响应头签发连接身份。后续 RPC 必须回传这两个请求头；SSE 使用 `clientId`、`clientSecret` 查询参数。该模式用于防止同机进程伪造 Approval 所有权，默认关闭以兼容旧客户端。

## Approval

服务端通过 JSON-RPC server request 转发 DSH 原生 approval：

- `accept` → `allowed-once`
- `decline` → `rejected`
- `cancel` → `cancelled`

Pending approval 是进程内状态，会在 SSE 重连时回放；持久化的 approval event 只作为审计历史。

## Cordis 挂载

```yaml
- id: dsh-appserver
  name: './src/cordis-plugin.js'
  config:
    stdio: true
```

## Flowix 安装流程

Flowix 启动时只检查本地 `dsh` 命令、Flowix 管理的 DSH Runtime，以及 `DSH_HOME/profiles/flowix` 中的 App Server profile；缺少任何一项都不会自动安装或弹窗。用户可以在 Flowix“偏好设置 → DeepSeek Harness”中打开 DSH 官方安装页面，安装后点“重新检查”。检测到 Runtime 但缺少 profile 时，用户点击“安装 DSH App Server 插件”。

profile 安装到 `DSH_HOME/profiles/flowix`，其中包含 `dsh-appserver` bundle 和 Flowix Cordis patch。安装后 Flowix 启动该 profile 并通过 stdio JSON-RPC 握手；握手成功后 DSH Agent 才标记为 Ready。`DSH_HOME` 未设置时使用默认 `~/.dsh`。安装过程不会改写 DSH 默认 profile。

## 开发检查

```sh
npm run typecheck
npm run docs:protocol
npm test
npm run test:models
npm run test:http-transport
npm run test:runtime-stdio
npm run test:runtime-http
```

`typecheck` 严格检查 TypeScript 协议类型，并对核心 JavaScript、Service、Projection 模块执行模块解析和语法检查。Runtime smoke test 需要本机已安装的 Flowix DSH。
