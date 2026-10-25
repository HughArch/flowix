# 移动端 AI × FNS：可行性调研与方案

> 分支 `feat/mobile-ai-fns-draft` · 2026-10-25 · 状态：调研结论，待评审
>
> 相关代码：`D:\code\flowix`（客户端）、`D:\code\fast-note-sync-service`（服务端，本机 `localhost:9000`，v3.6.1）
>
> **2026-10-25 更新（方案对比后）**：本文论证的是「FNS-first」可行性。发现 `flowix-cli` 的 transport-neutral memo 操作层后，移动端 v1 的最终推荐已改为「本地内置 Agent + 复用应用自身 memo 操作层」；本文保留为远端/云端 Agent 的备选方案。对比与推荐见 `MOBILE-AI-SOLUTION-COMPARISON.md`。

## 0. 结论

**可行，且不需要从零造轮子。**（注意：这是「FNS-first」路径的结论；移动端 v1 的最终推荐见 `MOBILE-AI-SOLUTION-COMPARISON.md`。）

用户设想的链路——「AI 通过 FNS 服务端做笔记增删改查，客户端靠实时同步把结果落到本地」——在现有代码里已经具备 80% 的积木：

| 积木 | 现状 | 位置 |
|---|---|---|
| 服务端笔记 CRUD / 搜索 / 链接 / 文件夹 | 已有完整 REST + MCP 接口 | `internal/routers/router_api.go` |
| 写入后实时广播 | REST/MCP 写操作都会向该用户所有 WS 连接广播 `NoteSyncModify` | `handler_note.go:263`、`mcp_router/note_tools.go:156` |
| 客户端常驻实时监听 | 每个绑定 token 一条 WS，收到广播后 500ms 防抖触发增量同步 | `fns_sync/listener.rs` |
| 增量同步落盘 | 拉取变更 → 通过 `MemoFileStore` 写入本地文件并刷新索引 | `flowix-fns/engine.rs`、`fns_sync/store.rs` |
| 冲突保护 | 默认 `manualMerge`，本地 push 遇到服务端已变更会回 530 | `fns_sync/config.rs:20`、`ws_note.go:140` |
| 内置 AI ReAct 运行时 | 曾在 `agent_flowix` 中存在，仓库历史可恢复（含 provider / stream / prompt / persistence） | `git show 62301a4a^:app/flowix-desktop/src/agent_flowix` |

真正缺的只有三块：

1. **同步落盘后没有 UI 通知。** `MemoFileStore` 写文件时会标记 self-write，watcher 对 Markdown 的 self-write 会直接丢弃，因此不会发 `flowix:path-note-changed`；`reloadOpenDocumentsAfterSync` 目前只被同步面板的手动同步调用。结果是：磁盘已经更新，列表/打开的文档仍显示旧内容。这是 AI 方案必须先补的 P0。
2. **移动端没有可用的 AI 运行时。** 当前所有 Agent 都是外部 CLI（`commands/agent/runtime.rs:7` 明确写着「former built-in runtime was removed」），移动端不能执行外部二进制。需要恢复内置 ReAct 运行时，或改为云端 Agent。
3. **REST 写入是 last-write-wins。** `POST /api/note` 完全忽略 `baseHash`（`handler_note.go:230-263`、`note_service.go:359`），MCP 同理。AI 与用户并发编辑时不会得到 530，而是直接覆盖。需要通过「预同步 + 读后写 + 可选的服务端 CAS」来兜。

另外两个不是阻塞项、但会影响体验的点：

- AI 读之前必须先同步本地未上传的编辑，否则会基于旧内容操作（预同步门）。
- 一轮对话里连续写多条笔记会触发多次防抖同步；大批量操作需要合并通知/延长防抖。

---

## 1. 需求拆解

移动端 AI v1 的最小闭环：

1. 在某个已绑定 FNS 的笔记本里打开 AI 面板；
2. AI 能搜索/读取笔记（含全文搜索、反向链接）；
3. AI 能新建、追加、替换、改 frontmatter、重命名、移动、删除（软删除）；
4. 操作结果在手机本地 1–2 秒内可见，并同步到桌面/其他设备；
5. 用户正在编辑同一篇笔记时不能静默丢数据；
6. 离线、FNS 不可用、token 失效时有明确降级行为。

非目标（v1 不做）：离线 AI 编辑、AI 直接操作附件二进制、跨 vault 操作、AI 自动执行任意 shell/网络工具。

---

## 2. 事实核查

### 2.1 服务端：REST 能力完整

`internal/routers/router_api.go` 的认证路由已经覆盖 AI 需要的全部笔记语义：

| 能力 | 端点 |
|---|---|
| 列表 / 全文搜索（path/content/regex） | `GET /api/notes` |
| 读取单篇（含内容、链接） | `GET /api/note` |
| 新建 / 全量更新 | `POST /api/note`（支持 `createOnly`） |
| 追加 / 头部插入 / 查找替换 | `POST /api/note/append`、`/prepend`、`/replace` |
| frontmatter 增删改 | `PATCH /api/note/frontmatter` |
| 重命名 / 移动 | `POST /api/note/rename`（新路径可换目录，即移动） |
| 删除 / 恢复 / 清空回收站 | `DELETE /api/note`、`PUT /api/note/restore`、`DELETE /api/note/recycle-clear` |
| 反向链接 / 出链 | `GET /api/note/backlinks`、`/outlinks` |
| 历史版本 | `GET /api/note/histories`、`PUT /api/note/history/restore` |
| 文件夹 | `GET/POST/DELETE /api/folder`、`GET /api/folder/tree` 等 |
| 附件 | `GET/POST/DELETE /api/file`、`GET /api/files` |
| vault 发现 | `GET /api/vault` |

四个容易踩的协议细节：

- **业务成功码是 `code: 1`，不是 `code: 200`。** `pkg/code/common.go:5` 定义 `Success = NewSuss(1)`；`SyncProtocol.md` 里的 `code: 200` 示例是旧描述（`REST_API.md` 的 “200” 只是 HTTP 状态）。客户端应以 `status === true` / `code === 1` 判断成功。
- **认证头。** 支持 `Authorization: Bearer <token>` 或 `token: <token>`；带 `IssueType=1` 的 token 还要求 `X-Client` 与 scope 的 `c:` 维度匹配。按 Flowix 接入文档，token scope 应为 `p:rest,ws c:flowix f:*`，因此 AI 的 REST 调用必须带 `X-Client: <FnsToken.client_type>`（通常是 `flowix`），否则 `pkg/app/permission.go` 的 `VerifyPermissions` 会失败。
- 时间戳：REST 写入可以省略 `mtime`/`ctime`，服务端会补当前毫秒时间；不要让 AI 自己生成秒级时间戳（WS 文档里的「秒」是过期描述）。
- **文档与实现有漂移**：`REST_API.md` 里的 `POST /api/note/move` 在当前服务端没有注册（`router_api.go` 只有 `/note/rename`）。移动笔记请直接用 `rename`，把 `path` 设成目标目录下的新路径。

### 2.2 写入会实时广播

REST 写路径在响应后执行：

```go
h.WSS.BroadcastToUser(uid, code.Success.WithData(noteNew).WithVault(params.Vault), "NoteSyncModify")
```

`BroadcastToUser` 按 `uid` 找到该用户所有 WS 连接，因此手机自己、桌面、其他设备都会收到。MCP 的 `note_create_or_update` 等工具也调用了同样的广播。

这意味着：**AI 不需要自己通知客户端**。只要它写服务端，实时链路就会把变更推到所有设备。

### 2.3 客户端：监听 → 同步 → 落盘已通

`fns_sync/listener.rs`：

- 每个绑定 token 维持一条常驻 WS；
- `CHANGE_ACTIONS` 包含 `NoteSyncModify` / `NoteSyncDelete` / `NoteSyncRename` / 文件事件等；
- 收到广播只做一件事：`schedule_sync_with_delay(..., 500ms)`，不直接应用内容；
- 真正的合并在 `flowix-fns::engine::sync_notebook` 里，走游标 + hash 比较 + `manualMerge` 冲突处理。

`MemoFileStore::write_note`（`fns_sync/store.rs:186`）负责把服务端内容写成本地 Markdown，并刷新索引。

### 2.4 缺口一：落盘后 UI 不刷新

同步写入时会调用 `mark_self_write_for(app, target)`。watcher 的 `stabilize_event`（`watcher/manager.rs:756`）对 Markdown 的判断是：

```rust
let indexed_resource = resource_kind_for_path(&event.path).is_some();
...
if !indexed_resource && is_exact_self_write(...) {
    return StableEventDecision::Skip;
}
```

而 core 的 `resource_kind_for_path`（`memo_file/media_resource.rs:241`）只识别图片/音视频/文档等资源，**不包含 `.md`**。因此：

- 同步写入的 Markdown 事件会被当作 self-write 丢弃；
- 不会发出 `flowix:path-note-changed`；
- 笔记列表、打开的文档、tab 都不会自动更新；
- `reloadOpenDocumentsAfterSync`（`features/document/public/sync-coordination.ts:63`）目前只在 `sync-status-panel.tsx:252` 等手动同步路径调用。

所以当前「远端改了笔记 → 手机磁盘更新 → 手机界面仍显示旧内容」是既有缺口，AI 会把它放大成核心体验问题。

**P0 修法**：在 engine 增加一个 applied-change sink（或让 `SyncReport` 携带 applied 列表），由 `FnsSyncService` 在同步结束后统一发 `flowix:path-note-changed`。三种语义要分开：

- 新建/修改 → `{ notebookId, relativePath, deleted: false }`（无 `entry`，前端走 query-invalidated + 索引重读）；
- 删除 → `{ ..., deleted: true }`；
- 重命名 → `{ ..., previousRelativePath, relativePath, kind: "path" }`，**不要退化成 create+delete**，否则打开中的 tab 会被关闭而不是 rebase。

不要复用 watcher 的 `emit_path_changed_with_content`——后者会 `schedule_notebook_sync`，容易形成同步回环。

### 2.5 缺口二：REST 写没有并发保护

WS 的冲突保护依赖 `baseHash` + `manualMerge`（`ws_note.go:140`）。REST 的 `CreateOrUpdate` 虽然先调用 `UpdateCheckWithNote`，但随后以 `mtimeCheck=false` 调用 `ModifyOrCreate`，`BaseHash` 字段在 REST 路径上没有参与判断（`dto/note_dto.go:27` 的字段只在 WS 路径使用）。MCP 的 `note_create_or_update` 更是直接 `ModifyOrCreate`。

后果：

- AI 读到内容 A，用户同时改成 B，AI 再写 C → 服务端直接变成 C；
- 如果用户的 B 还没推到服务端，本地 push 会撞上服务端 hash 变化并得到 530（`manualMerge`），进入冲突中心，不丢；
- 如果 B 已经同步到服务端，AI 的 C 会直接覆盖它，本地下一轮 pull 再把 C 写回，用户侧**不会出现冲突提示**；服务端历史是延迟快照（`ProcessDelay` 用 `ContentLastSnapshot` 做差分），B→C 间隔太近时连 B 也未必留下；
- AI 自己也收不到「刚才读到的版本已经过期」的信号，可能基于 A 生成错误内容。

**P0/P1 修法（服务端小改）**：`POST /api/note` 在请求携带 `baseHash` 时做 CAS：服务端当前 `contentHash != baseHash` → 返回 530 + 三方内容（复用 WS 已有的冲突结构）；不携带 `baseHash` 时保持现有 LWW 行为，向后兼容。这样 AI 工具可以「读的时候拿 contentHash，写的时候带上」，把覆盖窗口缩到最小。

### 2.6 缺口三：移动端没有内置 AI 运行时

- `commands/agent/runtime.rs` 的类型别名直接指向 `ExternalRuntimeKind`，注释写明内置运行时已移除；
- 移动端无法执行外部二进制（`app/state.rs` 的注释、`agent_external/pi/config.rs:284` 的平台分支）；
- `f82d3b3f` 已经把移动端 AI 入口全部隐藏（Sessions/Repositories、创建菜单、偏好页 tab、slash menu 的 agent 项、状态栏 PI 指示）。

但仓库历史里有一套完整的内置 ReAct agent：

```
$ git show 62301a4a^:app/flowix-desktop/src/agent_flowix --stat
context.rs / factory.rs / persistence.rs / provider.rs / stream.rs / tool_runtime.rs
prompt/ / providers/openai_compatible/ / tools/ / state.rs / wire.rs
```

约 500KB 源码（含测试），依赖 `rllm = "1.1"`（crates.io，已从当前 Cargo.toml 移除但可加回）。前端也曾在 `lib/agent-types.ts` 里有 `flowix` 类型（`assets/flowix-agent.svg` 仍在仓库）。**恢复这套代码比从零写一套 LLM 工具循环便宜得多**，且它已经处理了流式、持久化、token 预算、卡死熔断、停止/恢复。

---

## 3. 可行性判定

| 需求 | 判定 | 说明 |
|---|---|---|
| AI 增删改查笔记 | ✅ 可行 | REST 全量覆盖；写后广播 |
| AI 全文搜索 / 链接查询 | ✅ 可行 | `GET /api/notes` + FTS、backlinks/outlinks |
| 变更 1–2s 到本地 | ✅ 可行 | 广播 500ms 防抖 + 增量同步；实测需补 |
| 变更实时反映到 UI | ⚠️ 需补 | self-write 抑制导致无事件；P0 修 |
| 用户与 AI 并发编辑不丢数据 | ⚠️ 部分 | 本地 push 有 530 保护；REST 写需 CAS |
| 离线 AI 编辑 | ❌ v1 不支持 | 服务端是写入面；可做本地 fallback |
| 多设备收敛 | ✅ 可行 | 服务端广播 + 各端 listener |
| 移动端 AI 运行时 | ⚠️ 需恢复 | 历史代码可复用；无现网成品 |
| 附件读写 | ⚠️ v1.1 | REST 有接口；AI 工具先只做列表/信息 |
| 安全与可恢复 | ✅ 基本具备 | 软删除、历史版本、vault 白名单、路径校验 |

**总评：方案成立，风险集中在「一致性」和「UI 投影」，不在 FNS 的 CRUD 能力本身。**

---

## 4. 推荐架构

```
┌───────────────────────────── 手机 App ─────────────────────────────┐
│                                                                    │
│  移动端 AI 面板（复用会话壳，新增 builtin runtime）                 │
│        │                                                           │
│        ▼                                                           │
│  内置 ReAct Agent（恢复 agent_flowix：provider / stream / prompt） │
│        │  tool calls                                               │
│        ▼                                                           │
│  FNS 工具层（当前笔记本 → token + vault；路径沙箱；读写分级）      │
│        │  HTTP /api/*                                              │
│        ▼                                                           │
│  flowix-fns::api（REST client）                                     │
│                                                                    │
│  ── 以下为既有链路，仅补事件 ────────────────────────────────────  │
│  listener（常驻 WS）──▶ 500ms 防抖 ──▶ engine 增量同步             │
│        ──▶ MemoFileStore 写盘 + 索引                               │
│        ──▶ [新增] applied-change sink ──▶ service 统一发事件       │
│                    ──▶ flowix:path-note-changed                    │
│                    ──▶ 列表/tab/编辑器刷新                         │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                FNS 服务端（REST + WS broadcast）
```

### 4.1 一次 AI 写入的时序

```
用户: "把今天的会议记录追加到 2026-10-25.md"
  │
  ├─ 1. 预同步门：flush 打开文档 → 如有本地变更，await 一次 fns_sync_notebook
  │       （保证 AI 读到的是服务端最新版本）
  │
  ├─ 2. LLM → tool_call: note_append(path, content)
  │       REST POST /api/note/append
  │       headers: Authorization: Bearer <token>, X-Client: flowix
  │
  ├─ 3. 服务端：写库 + 历史 + BroadcastToUser("NoteSyncModify", vault)
  │
  ├─ 4. 手机 listener 收到广播 → 500ms 后触发同步
  │       engine: 拉取 NoteSyncModify → 内容不同 → MemoFileStore.write_note
  │
  ├─ 5. store 写盘 + refresh index + 标记 self-write
  │       [新增] engine 收集 applied 变更 → service 同步结束后 emit
  │       flowix:path-note-changed { notebookId, relativePath, deleted:false }
  │
  └─ 6. 前端：列表刷新；若该文档干净则 reload；若脏则提示冲突，不覆盖
```

### 4.2 工具集（v1）

| 工具 | 端点 | 说明 |
|---|---|---|
| `note_list` | `GET /api/notes` | 分页；支持 keyword + searchMode |
| `note_get` | `GET /api/note` | 返回 content + contentHash + links |
| `note_create` | `POST /api/note`（`createOnly=true`） | 已存在则报错，避免误覆盖 |
| `note_update` | `POST /api/note` | 读后写；带 `baseHash`（服务端 CAS 后） |
| `note_append` | `POST /api/note/append` | 优先于全量重写 |
| `note_prepend` | `POST /api/note/prepend` | 已处理 frontmatter |
| `note_replace` | `POST /api/note/replace` | 支持 regex、all、failIfNoMatch |
| `note_patch_frontmatter` | `PATCH /api/note/frontmatter` | properties/tags |
| `note_rename` / `note_move` | `POST /api/note/rename` | 新路径可换目录；没有独立的 `/move` |
| `note_delete` | `DELETE /api/note` | 软删除，进回收站 |
| `note_backlinks` / `note_outlinks` | GET | 链接查询 |
| `folder_list` / `folder_tree` | GET | v1.1 |

**不给 LLM 的：**
- 任意 `vault` 参数（由当前笔记本绑定决定，防止跨库写入）；
- 绝对路径 / `..` / `.flowix/` / 隐藏目录；
- 附件上传（v1.1 再评估）；
- shell、网络请求、任意文件系统访问（旧内置 agent 的 `shell` / `web_search` / `filesystem` 工具在移动端不注册）。

---

## 5. 关键决策

### 5.1 用 REST，不用 MCP

- 按接入文档，Flowix token 的 scope 是 `p:rest,ws`，**没有 `p:mcp`**；走 MCP 要求用户重新签发 token，且 MCP 还多一层 session/transport。
- REST 的端点比 MCP 工具更全（MCP 没有 `note/histories`、`folder/tree`、`folder/create/list` 等；移动笔记两边都走 `rename`）。
- MCP 仍是有价值的后续路径：给桌面/云端 Agent 做「零客户端代码」接入时再用。工具层可以设计成与传输无关，届时复用。

### 5.2 server-first，而不是 local-first

| | server-first（推荐） | local-first |
|---|---|---|
| CRUD 实现 | 服务端一份 | 客户端再实现一份 |
| 全文搜索/链接 | 服务端 FTS 现成 | 依赖本地索引/全量扫描 |
| 远端 Agent 复用 | 直接可用 | 不可用 |
| 延迟 | 一次 HTTP + ~1s 投影 | 本地即时 |
| 离线 | 不可用 | 可用 |
| 打开文档冲突 | 需要协调 | 与现有 watcher 一致 |

移动端 AI 的 LLM 本身通常就需要网络，所以「AI 可用但 FNS 不可用」不是主要场景；换取一份 CRUD 实现和远端复用能力更划算。离线 fallback 留到 v2，通过同一 `NoteTools` trait 接 `LocalFile` 后端即可。

### 5.3 AI 运行时：v1 内置，后续可云端

- **v1 推荐**：恢复 `agent_flowix` 为内置 runtime，用户在偏好里配置 OpenAI-compatible / DeepSeek provider。`AiModelConfig` 仍在当前 `config/user.rs` 里；`rllm = "1.1"` 需要加回 `Cargo.toml`。
- 移动端只暴露这一个 builtin agent；外部 CLI agent 继续隐藏（`f82d3b3f` 的逻辑保留）。
- 后续若做云端 Agent，工具层可以换成 MCP 或服务端 REST，客户端只负责展示——这也是 server-first 的额外收益。

### 5.4 一致性策略

三层防线：

1. **回合开始预同步**：flush 打开的文档；如果该笔记本有未推送变更，`await fns_sync_notebook`（带超时/降级）。避免 AI 基于旧内容操作。
2. **读后写 + 定向操作**：工具结果返回 `contentHash`；更新时带 `baseHash`（服务端 CAS）。优先 `append/replace/frontmatter`，减少全量重写。
3. **冲突兜底**：本地 push 仍走 `manualMerge`。注意它只能保护「尚未推送的本地编辑」；已经同步、随后被 AI 覆盖的版本不会产生 530，而服务端历史是延迟快照，B→C 间隔太近时也可能找不回 B。因此 CAS 是消除这个窗口的关键，不能只依赖冲突中心。

### 5.5 UI 投影

- 后端在同步应用变更后发 `flowix:path-note-changed`，**不要**调用 `emit_path_changed_with_content`（它会再次调度同步）。
- 事件由 engine 的 applied-change sink 收集、service 统一发；重命名要发 `path-moved` 语义，不能拆成 create+delete。
- 前端复用现有投影：
  - `memo-list-refresh-service` → 列表刷新；
  - `notebook-change-events` → tab 关闭、路径 rebase、mention 失效；
  - `reloadOpenDocumentsAfterSync` 扩展为可被事件触发：干净文档 reload，脏文档保持并提示。
- 一批同步只发一组事件（service 在同步结束后按路径 emit；前端已有批处理窗口）。

### 5.6 离线

- v1：FNS 不可达时工具返回结构化错误（`offline` / `fns_unavailable`），AI 明确告知「当前无法修改笔记」，不假装成功；写入不可用。若需要只读降级，可额外注册一个只读本地工具（v1 不默认开启，避免与 server-first 语义混淆）。
- v2：`NoteTools` 增加 local 后端，离线时写本地文件 + 标记待同步，联网后由 engine push；冲突仍走 manualMerge。

### 5.7 安全与权限

- **token 永不进入 LLM 上下文**：工具在设备内执行，LLM 只看到工具结果。
- 工具绑定当前笔记本的 `vault` 与 token，LLM 不可指定 vault。
- 路径沙箱与 `MemoFileStore::resolve` 一致：拒绝绝对路径、`..`、`.flowix`、隐藏目录。
- 删除/重命名/移动默认需要用户确认（可在设置里放开「AI 自动写入」）；删除是软删除，另有历史版本。
- 服务端日志通过 `X-Client-Name` / `X-Client-Version` 区分 AI 操作，便于审计。
- 后续可给 AI 单独签发 `f:note_rw,file_r` + vault 白名单的 token，替代复用同步 token。

---

## 6. 实施拆解

### P0 — 可行性验证（不接 LLM）

1. `flowix-fns` 新增 `api` 模块（`reqwest` + serde）：
   - 认证头、`X-Client`、成功码 `code==1`、错误映射；
   - `GET /api/note`、`GET /api/notes`、`POST /api/note`、`DELETE /api/note`。
2. 一个调试入口（CLI 子命令或临时 IPC），在已绑定的笔记本上跑：读 → 写 → 删除。
3. 补 UI 投影事件：
   - `flowix-fns/engine.rs` 增加 applied-change sink（写/删/重命名分别记录，重命名保留旧路径）；
   - `fns_sync/service.rs` 在同步结束后 emit `flowix:path-note-changed`；
   - 前端验证列表、打开文档、tab 三条路径。
4. 验收：
   - REST 写 → 本地文件变化 ≤ 2s；
   - 列表/文档自动刷新；
   - 空闲时不会因为事件产生同步回环（观察同步历史）。
5. 输出延迟数据（局域网 / 公网各一组）。

### P1 — 移动端 AI MVP

1. 恢复 `agent_flowix`（从 `62301a4a^`）为 `agent_builtin`，加回 `rllm = "1.1"`；移除移动端不注册的 `filesystem` / `shell` / `web_search` / `sub_agent` 工具，新增 `tools/fns.rs`。
2. 后端：
   - 解析当前笔记本的 `SyncState`（token_id + vault）；
   - 新增 IPC：`agent_builtin_chat_stream` / stop / provider 配置；
   - 预同步门（flush + sync + 超时）；
   - 工具策略（路径/大小/确认/速率）。
3. 服务端（小改）：
   - `POST /api/note` 支持 `baseHash` CAS，冲突回 530 + 三段内容；
   - 保持不带 `baseHash` 的旧行为。
4. 前端：
   - `types/agent.ts` / `lib/agent-types.ts` 恢复 `flowix` 类型；
   - 移动端只展示 builtin agent，重新放开创建菜单/会话入口/slash menu 的 agent 项；
   - provider/model/key 设置页（复用旧 `AiModelConfig`）；
   - 工具调用展示（复用现有 tool-display）；
   - 同步事件驱动的文档刷新/冲突提示。
5. 验收：
   - 手机上一轮对话完成「搜索 → 读 → 追加 → 新建 → 删除」；
   - 桌面同步看到同样结果；
   - 并发编辑进入冲突中心，无静默丢失；
   - 断网时 AI 明确报错。

### P2 — 增强

- 附件信息/读取、历史版本恢复、文件夹工具；
- 批量写合并通知（避免一次对话触发 N 次同步）；
- 大 vault 的同步扫描优化（当前每轮 `list_notes` 会遍历并读取全部 Markdown）；
- 离线本地后端；
- AI 专用 token（最小权限）；
- 云端 Agent / MCP 复用。

---

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 同步落盘无 UI 事件 | AI 写完界面不变，用户以为失败 | P0 必做；事件驱动刷新 |
| REST 写覆盖并发编辑 | AI 基于旧内容生成 | 预同步 + CAS + 定向操作 |
| 冲突风暴 | 手机与桌面同时编辑 | manualMerge + 冲突中心；提示用户 |
| 一轮对话多次同步 | CPU/电量/网络抖动 | 防抖窗口内合并；必要时回合结束统一同步 |
| 大 vault 同步慢 | 写入到本地延迟 > 2s | 先测真实库；后续增量/索引优化 |
| 服务端不可达 | AI 无法写 | 结构化错误 + 只读降级 |
| token 权限过大 | 误删/误改 | 软删除 + 历史 + 后续专用 token |
| Prompt injection（笔记内容诱导 AI） | 越权操作 | 工具白名单 + 路径沙箱 + 破坏性操作确认 |
| 移动端后台冻结 | 实时性退化 | 现有 focus sync 已覆盖；事件到来时补拉 |
| 旧代码恢复的兼容性 | `rllm` / API 漂移 | 先编译 + 单测；必要时只挑 provider/stream 核心 |

---

## 8. 验证计划

**单元 / 集成**

- REST client：认证头、成功码、错误码、超时、URL 拼接；
- 路径沙箱：`../`、绝对路径、`.flowix`、隐藏目录全部拒绝；
- 工具层：`createOnly`、读后写、CAS 冲突映射；
- 同步事件：写/删/重命名各发一次正确 payload；无重复、无回环；
- 前端：列表刷新、干净文档 reload、脏文档不覆盖、删除关闭 tab、重命名 rebase。

**端到端（本机 FNS 3.6.1）**

1. 建一个空 notebook 并绑定 vault；
2. 用 P0 harness 写一篇笔记：确认手机文件、列表、编辑器三方一致；
3. 打开该笔记，让 AI 追加：确认编辑器自动更新；
4. 在编辑器里制造未保存修改，同时 AI 写入：确认不覆盖，出现冲突入口；
5. 断开网络后调用工具：确认结构化错误；
6. 桌面端同时在线：确认双向收敛；
7. 连续写 10 篇：确认同步次数/耗时在可接受范围。

**指标**

- 写入→本地文件可见：P50 / P95；
- 广播→同步结束：P50 / P95；
- 空闲 10 分钟的同步次数（回环检测）；
- 一轮对话的工具调用数与 token 消耗。

---

## 9. 开放问题

1. **AI 运行时选型**：v1 内置（设备侧 key）还是直接做云端 Agent？本文推荐内置，复用历史代码。
2. **服务端 CAS 是否接受**：`POST /api/note` 增加可选 `baseHash` 是约 50 行的服务端改动；若不想动服务端，只能在客户端做「读后写 + 冲突兜底」，覆盖窗口更大。
3. **离线是否 v1 必须**：若是，需要并行做 local 后端，工作量翻倍。
4. **移动端是否只做单笔记本**：多笔记本/多 vault 时，AI 面板必须明确当前作用域。
5. **模型/provider 范围**：OpenAI-compatible + DeepSeek 足够，还是必须支持 Anthropic 原生？
6. **AI 写操作是否默认需要确认**：建议删除/重命名/移动默认确认，追加/新建可配置。

---

## 附录 A：FNS 相关代码位置

| 内容 | 位置 |
|---|---|
| REST 路由表 | `fast-note-sync-service/internal/routers/router_api.go` |
| REST 笔记写 + 广播 | `internal/routers/api_router/handler_note.go:230-263` |
| REST 无 baseHash 校验 | `internal/service/note_service.go:359-476` |
| WS 冲突保护 | `internal/routers/websocket_router/ws_note.go:140` |
| MCP 写 + 广播 | `internal/routers/mcp_router/note_tools.go:116-163` |
| 成功码 / 权限 | `pkg/code/common.go:5`、`pkg/app/permission.go` |
| REST 认证 | `internal/middleware/user_auth_token.go:68-132` |
| 客户端 WS 连接 | `app/flowix-fns/src/client.rs` |
| 实时监听 | `app/flowix-desktop/src/fns_sync/listener.rs` |
| 同步落盘 | `app/flowix-fns/src/engine.rs`、`app/flowix-desktop/src/fns_sync/store.rs` |
| self-write 抑制 | `app/flowix-desktop/src/watcher/manager.rs:756`、`flowix-core/src/memo_file/media_resource.rs:241` |
| 冲突策略默认值 | `app/flowix-desktop/src/fns_sync/config.rs:20` |
| 旧内置 agent（可恢复） | `git show 62301a4a^:app/flowix-desktop/src/agent_flowix` |
| 移动端 AI 隐藏 | commit `f82d3b3f` |
| 前端同步协调 | `app/flowix-web/features/document/public/sync-coordination.ts` |

## 附录 B：为什么不是「让 AI 直接写本地文件」

- 需要在客户端重新实现路径、frontmatter、索引、链接、附件语义；
- AI 只能看到本地已同步的子集，无法做全库搜索；
- 未来云端/远端 Agent 无法复用；
- 与「服务端是唯一真源」的多端模型不一致。

本地写只适合作为离线 fallback，而不是主路径。
