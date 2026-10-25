# 移动端 AI 三方案对比与推荐

> 分支 `feat/mobile-ai-fns-draft` · 2026-10-25 · 状态：方案对比，待评审
>
> 前置调研：`docs/MOBILE-AI-FNS-FEASIBILITY.md`（FNS-first 的可行性分析）
>
> **结论更新**：发现 `flowix-cli` 的 memo 操作层后，移动端 v1 推荐 **方案 3（本地简易 Agent + 复用应用自身的 memo 操作层）**；FNS-first 保留为远端/云端 Agent 的后端方案。

## 0. 结论先行

| 方案 | 判断 | 一句话理由 |
|---|---|---|
| 1. 移动端完整 Agent + 自建笔记 CRUD | ❌ 不推荐 | 等于方案 3 重新实现一遍已有的 memo 操作层，工作量大且语义容易漂移 |
| 2. 本地 Agent + FNS MCP 做 CRUD | ⚠️ 备选 | 能跑通，但依赖网络、要重签 `p:mcp` token、丢失 Flowix 富内容语义、REST/MCP 写是 LWW |
| 3. 本地 Agent + 复用应用自身 memo/CLI 操作层 | ✅ 推荐 | 与桌面 DSH 用的 `mcp__flowix__memo` 同一套语义；本地 CAS、离线可用、富内容原生支持、无需改服务端 |

**关键澄清**：方案 3 不是「在 Android 上 spawn `flowix-cli mcp`」——Tauri mobile 不支持 sidecar，Android targetSdk 29+ 也禁止从 app data 执行二进制。正确做法是把 `flowix-cli` 里那套 **transport-neutral 的 memo 操作层抽成库**，注入 App 自己的 `MemoFile`，在进程内调用。MCP/CLI 进程边界保留给桌面和外部 Agent。

---

## 1. 先厘清项目里已有的四套接口

| 接口 | 形态 | 谁在用 | 移动端可用性 |
|---|---|---|---|
| `flowix-cli` 子命令 | 独立进程 / sidecar | 桌面用户、外部 Agent | ❌ 不能 spawn |
| `flowix-cli mcp` | stdio JSON-RPC，单工具 `memo` | 桌面 DSH（`dsh-flowix-memory`） | ❌ 不能 spawn；✅ 代码可复用 |
| `NoteService` + `MemoFile` | Rust 库 | CLI、桌面 Tauri 命令 | ✅ 已是 AppState 的一部分 |
| FNS REST / MCP | HTTP / WS，服务端 | 桌面同步、远端 Agent | ✅ 可用，但语义是 raw Markdown |

其中最重要的是第二行和第三行：

- `flowix-cli/src/operation.rs` 的模块注释写的是 **“Transport-neutral Flowix operations shared by CLI and MCP adapters”**——它本来就是为复用设计的。
- `operation.rs` 覆盖：`list / show / search / create / edit / write / delete`，以及 Flowix 特有的 `callout / toggle / columns / collection / artifact`。
- `flowix-cli/src/mcp.rs` 把这套操作包装成一个 `memo` 工具，schema 在 `dsh-flowix-memory/memo-tool-schema.json`。
- 底层 `NoteService::save` / `delete_checked` / `edit` 都带 **expected content（CAS）**：磁盘内容变了就返回 `Conflict`，不会静默覆盖。

这是方案 3 的地基。

---

## 2. 桌面端现状：为什么不能直接搬到移动端

桌面 AI 的实际形态是外部 CLI Agent：

- Codex / Claude Code / Pi：工作区文件系统 + `AGENTS.md`（`commands/agent/flowix_instructions.rs` 写入 Flowix CLI 用法）；
- DSH：除了工作区，还通过 `dsh-flowix-memory` 注册 `flowix-cli mcp`，拿到 `mcp__flowix__memo` 工具。

移动端的问题是：

1. 不能执行外部二进制（`app/state.rs` 注释、Tauri mobile 无 sidecar）；
2. 因此桌面那套「把 CLI 当 Agent 运行时」的路径完全不可用；
3. `f82d3b3f` 已经把移动端 AI 入口全部隐藏（Sessions/Repositories、创建菜单、偏好页 AI tab、slash menu 的 agent 项）。

但被隐藏的只是「外部 Agent 运行时」，**memo 操作层本身是纯 Rust、无 Tauri 依赖的**，可以在移动端进程内复用。

---

## 3. 三方案逐一分析

### 方案 1：移动端完整 Agent + 自建笔记 CRUD

**做法**：恢复/新写一个内置 Agent，自己实现 note list/read/create/edit/delete/search，再考虑 callout/toggle/columns/collection 等富内容；工具层按移动端能力裁剪。

**优点**

- 完全可控，工具粒度可以按移动端模型调优；
- 不依赖 FNS，也不依赖 CLI。

**缺点**

- 这些 CRUD 语义项目里**已经有一份**：`operation.rs` / `path_store.rs` / 各富内容 store 合计约 1400 行（不含 `NoteService` 本身），覆盖标题推导、默认文件夹、路径校验、CAS、富内容；
- 重新实现会重复踩同样的坑（路径规则、frontmatter、索引刷新、标签、callout/toggle 解析、并发写）；
- 桌面 Agent 与移动 Agent 的笔记语义会分叉，后续修 bug 要改两处；
- 「移动端工具有限」实际上不是问题：笔记 CRUD 是本地文件操作，不需要 shell/exec；真正的限制是**不要给 AI shell 和任意文件系统**，而不是 CRUD 做不了。

**结论**：不推荐。方案 1 的「完整 Agent」部分和方案 3 相同，差异只在工具实现；既然已有工具层，没有理由重写。

---

### 方案 2：本地简易 Agent + FNS MCP 做 CRUD

**做法**：移动端跑一个轻量 LLM 循环，工具调用走 FNS 服务端的 MCP（`/api/mcp`，Streamable HTTP/SSE），笔记写服务端，再靠现有 WS 监听 + 增量同步回本地。

**优点**

- 工具语义在服务端统一，未来云端/远端 Agent 可以直接复用；
- 服务端有全文搜索、历史、附件、回收站；
- 本地不需要理解笔记的存储细节。

**缺点（对移动端 v1 而言）**

1. **网络强依赖**：AI 的每一次读/写都要一次 HTTP；FNS 不可达时笔记操作完全不可用。LLM 本身虽然也要网络，但本地笔记操作没有必要再依赖第二跳。
2. **token scope 不匹配**：Flowix 接入文档要求 `p:rest,ws c:flowix f:*`；MCP 需要 `p:mcp`，现有 token 直接调 MCP 会被 `VerifyPermissions` 拒绝，需要用户重新签发/轮换。
3. **需要实现 MCP 客户端**：项目现在只有「给外部 Agent 写 MCP 配置」的能力（`notebook_agents.rs`、`pi/config.rs`），没有 MCP client + session/transport 实现。这是一个独立的新子系统。
4. **丢失 Flowix 富内容语义**：FNS 只存 raw Markdown。AI 对 callout/toggle/columns/collection 的结构化操作没有对应工具；用全量 write 容易破坏这些结构。移动端用户恰恰最可能在手机上让 AI 改这些内容。
5. **写一致性更弱**：REST/MCP 写是 last-write-wins（`handler_note.go:230-263`、`note_tools.go:142`），没有本地 `NoteService` 的 expected-content CAS。并发编辑只能靠本地 push 的 530 兜底，已经同步的版本可能被覆盖。
6. **回写 UI 有缺口**：同步写入会标记 self-write，watcher 不发光 UI 事件；需要额外补一套 applied-change 事件（见 FNS 调研文档 §2.4）。
7. **延迟更高**：写服务端 → 广播 → 500ms 防抖 → 增量同步 → 落盘，通常 1s+；本地写是毫秒级。

**结论**：可行，但不是移动端 v1 的最优解。**它更适合「云端/远端 Agent」**：Agent 不在手机上跑，只通过 FNS MCP 操作服务端，手机作为查看端。

---

### 方案 3：本地简易 Agent + 复用应用自身 memo/CLI 操作层

**做法**：

1. 把 `flowix-cli` 的 `operation.rs` / `path_store.rs` / 富内容 store 抽成可注入的库（或直接公开这些模块）；
2. 把 `store::open()` 换成注入 App 的 `&MemoFile`（当前只有 6 处 `store::open()`，改造面可控）；
3. 移动端内置 Agent 的工具调用直接落到这套操作层；
4. 本地写入照常被 watcher 看到 → UI 刷新 + FNS 同步推送；
5. 不新增服务端依赖，不需要 MCP/CLI 进程。

**为什么这是最优**

| 维度 | 说明 |
|---|---|
| 与桌面一致 | 和桌面 DSH 的 `mcp__flowix__memo` 是同一套 `operation.rs` 语义，不是"类似" |
| 富内容 | callout / toggle / columns / collection / artifact 全部原生支持 |
| 冲突安全 | `NoteService::save` / `delete_checked` / `edit` 自带 expected-content CAS；比 REST/MCP 的 LWW 强 |
| 离线 | 笔记操作完全本地；LLM 需要网络，但笔记读写不受 FNS 影响 |
| 延迟 | 本地写盘 + watcher 事件，毫秒级 |
| 多设备 | 不变：watcher 已经会 `schedule_notebook_sync`，AI 写入经 FNS 同步到桌面/其他设备 |
| 移动端限制 | 不需要 shell、不需要任意文件系统、不需要外部二进制；只给 memo 工具即可 |
| 服务端改动 | 零 |
| Token/scope | 零；不碰 FNS token |
| 复用成本 | 主要是 6 处 `store::open()` 注入 + 模块可见性调整，约 1–2 天量级 |

**必须先解决的三个工程点**

1. **共享 `MemoFile`，不要开第二个实例。**
   `MemoFile` 内部有进程内 `Mutex` 和 `index_cache`；同进程两个实例会绕过互斥、缓存也可能分叉。必须把 `Arc<RwLock<MemoFile>>` 注入操作层，而不是让操作层再 `MemoFile::new()`。
2. **操作层的路径依赖要解耦。**
   `flowix-cli/src/paths.rs` 依赖 `dirs::home_dir()`，Android 上为 `None`。注入 `MemoFile` 后，操作层不再需要解析 home；CLI 二进制仍保留原逻辑。
3. **打开中的文档要刷新。**
   本地写入会触发 watcher 的 `flowix:path-note-changed`，列表会刷新；但打开的编辑器 buffer 目前不会自动重载（和桌面外部 CLI 编辑的现状一致）。需要加一个小订阅：干净 buffer 读盘刷新，脏 buffer 保留并在保存时走 CAS 冲突。

**结论**：推荐。它不是"重新做一个 Agent"，而是"把桌面已经验证过的工具层接到移动端内置 Agent 上"。

> 注：如果坚持要保留 MCP 协议边界，可以在进程内用 pipe 跑 `mcp::run_mcp`；但这只增加 JSON-RPC 序列化和线程，不会带来任何能力，v1 不建议。

---

## 4. 对比矩阵

评分：✅ 好 / ⚠️ 一般 / ❌ 差

| 维度 | 方案 1 自建 CRUD | 方案 2 FNS MCP | 方案 3 复用 memo 层 |
|---|---|---|---|
| 笔记 CRUD 完整度 | ✅（但重写） | ✅ | ✅ |
| Flowix 富内容（callout/toggle/columns/collection） | ⚠️ 需重写 | ❌ 不支持 | ✅ 原生 |
| 冲突安全 | ⚠️ 需自建 | ❌ LWW | ✅ 自带 CAS |
| 离线可用 | ✅ | ❌ | ✅ |
| 写入→UI 延迟 | ✅ 毫秒 | ❌ ~1s+（需补事件） | ✅ 毫秒（watcher 已有） |
| 多设备同步 | ✅ 走 FNS | ✅ 服务端直写 | ✅ 走 FNS |
| 服务端改动 | 无 | 可能需要 scope/接口配合 | 无 |
| Token/认证 | 无新增 | 需 `p:mcp` | 无新增 |
| 新子系统 | Agent + CRUD | Agent + MCP client + FNS 事件 | Agent + 操作层注入 |
| 与桌面 Agent 一致性 | ❌ 新语义 | ⚠️ 与 FNS 一致，与桌面 memo 工具不一致 | ✅ 同一套 operation 语义 |
| 移动端工具限制 | 需自行裁剪 | 受 MCP 工具集限制 | 正好只需 memo 工具 |
| 实现风险 | 高（重复造轮子） | 中高（网络/协议/一致性） | 中（重构注入 + UI 刷新） |

---

## 5. 推荐架构（方案 3）

```
┌──────────────────────── 手机 App 进程 ────────────────────────┐
│                                                               │
│  移动端 AI 面板（复用会话壳，builtin agent）                   │
│        │                                                      │
│        ▼                                                      │
│  内置 ReAct Agent（恢复 agent_flowix 的 loop / provider /     │
│  stream / persistence；工具裁剪为 memo）                       │
│        │  tool calls                                          │
│        ▼                                                      │
│  memo 工具适配层（note_list/search/read/create/edit/...）      │
│        │                                                      │
│        ▼                                                      │
│  flowix-memo-ops（从 flowix-cli 抽出的 transport-neutral 层）  │
│        │  注入 &MemoFile                                       │
│        ▼                                                      │
│  NoteService / MemoFile（本地文件 + 索引 + CAS）               │
│        │                                                      │
│        ├──▶ watcher ──▶ 列表/编辑器刷新                        │
│        └──▶ watcher ──▶ FNS 同步 push ──▶ 桌面/其他设备        │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### 5.1 一次对话的时序

```
用户: "把今天的会议记录追加到 2026-10-25.md"
  │
  ├─ 1. 前端 flush 打开文档（saveDocumentPath）
  ├─ 2. 可选：若笔记本绑定 FNS，触发一次 focus/增量 pull（超时降级）
  │       —— 保证本地副本是最新；离线则直接用本地，并提示可能不是最新
  │
  ├─ 3. LLM → tool call: note_read("2026-10-25.md")
  │       → operation::show → NoteService::get
  │
  ├─ 4. LLM → tool call: note_edit(地址, old, new)
  │       → operation::edit → NoteService::save(..., expected=当前正文)
  │       → 若磁盘已被用户改过：返回 Conflict，LLM 重新读取后再试
  │
  ├─ 5. MemoFile 写盘 + 索引更新
  │       → watcher 发 flowix:path-note-changed（不是 self-write）
  │       → 列表刷新；打开中的干净文档 reload
  │       → watcher 调度 FNS 同步（本地 → 服务端 → 其他设备）
  │
  └─ 6. 工具结果返回路径/摘要；UI 显示"已更新"
```

### 5.2 工具集（v1）

建议把原来单一大 `memo` 工具拆成细粒度工具，移动端小模型更稳；底层仍调用同一套 operation：

| 工具 | 底层 action | 说明 |
|---|---|---|
| `note_list` | `list` | 当前笔记本笔记列表 |
| `note_search` | `search` | 本地全文搜索 + 标签过滤 |
| `note_read` | `show` | 返回正文、路径、元数据 |
| `note_create` | `create` | 新笔记；返回实际路径 |
| `note_edit` | `edit` | 精确替换（要求恰好一处匹配），优先使用 |
| `note_write` | `write` | 全量覆盖；需用户确认 |
| `note_delete` | `delete` | 删除；必须用户确认 |
| `note_tags` | `tags` | 标签列表 |
| `collection_read` | `collection.read` | 表格/媒体库数据集（可选） |
| `callout_*` / `toggle_*` / `columns_*` | 同名 action | 富内容编辑（v1.1 再放开） |

**不给 LLM 的工具**：shell、任意文件系统、外部二进制、跨笔记本写入、附件二进制上传。

**工具作用域**：

- 默认绑定当前笔记本；地址用 `<notebookId>::<relativePath>` 或当前笔记本内的相对路径，拒绝 `..`、绝对路径、`.flowix/`、隐藏目录；
- 单次工具返回正文有大小上限（超出截断并提示分页/搜索）；
- 单轮最大工具循环数（复用旧 Agent 的 token 预算/卡死熔断）；
- 删除/覆盖默认需要用户确认，可在设置里放开"AI 自动写入"。

---

## 6. 实施拆解

### P0 — 打通工具层（不接 LLM）

1. 抽出 `flowix-memo-ops`（或把 `operation` 模块公开）：
   - `MemoOperation` + `execute(&MemoFile, op)`；
   - 把 6 处 `store::open()` 改成注入 `&MemoFile`；
   - CLI 的 `mcp.rs` 改为持有自己的 `MemoFile` 后调用同一层。
2. 在 `flowix-desktop` 加一个调试 IPC / 单测：用 AppState 的 `MemoFile` 跑 `list → show → create → edit → delete`。
3. 验证：
   - 写入后 watcher 发 `flowix:path-note-changed`，列表刷新；
   - 打开中的干净文档能否 reload（现状大概率不能，需要 P1 补）；
   - FNS 绑定存在时，AI 写入是否被 watcher 调度同步；
   - 并发编辑时 `edit` 是否返回 Conflict。

### P1 — 移动端 AI MVP

1. 恢复内置 Agent 核心（从 `62301a4a^:app/flowix-desktop/src/agent_flowix` 选择性恢复）：
   - provider / stream / wire / persistence / context / state / factory；
   - 加回 `rllm = "1.1"`；
   - 丢弃 filesystem / shell / web_search / sub_agent 工具。
2. 新增 memo 工具适配层（上面的工具表）。
3. 后端 IPC：
   - `agent_builtin_chat_stream` / stop；
   - provider/model/key 配置（复用 `AiModelConfig`，key 进 SecretStore）；
   - 工具作用域（当前笔记本、路径校验、大小/循环上限、删除确认）。
4. 前端：
   - 恢复 `flowix` builtin agent 类型（`types/agent.ts`、`lib/agent-types.ts`，图标 `assets/flowix-agent.svg` 仍在）；
   - 移动端只展示这个 builtin agent，外部 CLI agent 继续隐藏；
   - 重新放开创建菜单/会话入口/slash menu 的 AI 项（仅 builtin）；
   - 对话 UI 复用现有会话壳；工具调用展示复用 tool-display；
   - 打开文档刷新：订阅 `flowix:path-note-changed`，干净 buffer reload，脏 buffer 保留。
5. 验证：
   - 手机上一轮对话完成"搜索 → 读 → 精确编辑 → 新建 → 删除"；
   - 桌面看到同步结果；
   - 与用户并发编辑时，Agent 收到 Conflict 而不是覆盖；
   - 断网时笔记操作仍可用（LLM 不可用则明确报错）。

### P2 — 增强

- callout / toggle / columns / collection 工具；
- 附件相关操作；
- 删除前进版本快照 / 撤销；
- web 搜索等安全的外部工具；
- 可选 `FnsBackend`：同一个工具接口支持远端 Agent / 大库搜索。

---

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 操作层注入重构 | 破坏 CLI/MCP 现有行为 | 保留 CLI 的 `store::open()` 路径；新接口与旧接口并存，先加测试 |
| 同进程双 `MemoFile` | 锁失效 / 索引分叉 | 强制注入 `AppState.memo_file`，禁止 `MemoFile::new()` |
| 打开文档不刷新 | AI 改完编辑器还是旧内容 | 订阅 path 事件；干净 reload，脏 buffer 走 CAS |
| 删除不可恢复 | 用户误删 | 默认确认；可加删除前版本快照 |
| 移动端内存/CPU | 大笔记/长对话卡顿 | 正文截断、工具结果摘要、最大循环数、流式输出 |
| 小模型工具调用不稳 | 动作名/参数错 | 细粒度工具 + 严格 schema + 错误回传让模型重试 |
| Provider key 安全 | 泄露 | SecretStore / 数据库加密，UI 不回显 |
| 与 FNS 同步耦合 | AI 写入触发同步风暴 | watcher 已有防抖；批量操作按 notebook 合并 |
| 语义分叉 | 桌面/移动行为不一致 | 统一走同一 `flowix-memo-ops`，CLI/MCP/移动共用 |

---

## 8. 与 FNS 的关系（回答"为什么不直接用 FNS 做 CRUD"）

FNS 仍然是**同步层**，不是移动端 AI 的 CRUD 层：

- 本地 memo 操作层已经是完整、带 CAS、支持富内容的笔记 API；
- FNS 的价值是把它同步到其他设备，以及未来给远端 Agent 提供入口；
- AI 在本地写入后，watcher 自动调度 FNS push，这条链路不需要改；
- 如果未来做云端 Agent，它可以直接用 FNS MCP/REST，手机只负责展示——届时方案 2 作为**第二个工具后端**接入，而不是替换本地方案。

工具层建议抽象成：

```rust
trait NoteToolBackend {
    async fn search(...);
    async fn read(...);
    async fn create(...);
    async fn edit(...);
    async fn delete(...);
}
```

- v1 实现：`LocalMemoBackend`（方案 3）；
- v2 可选：`FnsBackend`（方案 2），供远端/云端 Agent。

这样当前决策不会堵死未来。

---

## 9. 能力面：移动端内置 Agent 能覆盖多少常见能力

先说结论：**对「笔记助手」这个定位，常见能力大部分覆盖；对「通用电脑 Agent」不覆盖，也不应该覆盖。**

笔记 CRUD 的后端选择（本地 memo vs FNS）只影响「怎么读写笔记」；引用、搜索、附件、联网、流式、工具审批这些能力都是**独立模块**，方案 3 不会砍掉它们。

| 能力 | v1 | 实现方式 |
|---|---|---|
| 笔记增删改查 | ✅ | `flowix-memo-ops` + `NoteService`（CAS） |
| 当前笔记 / 当前标签上下文 | ✅ | 已有首条消息 context block（前 500 字 + 任务标签） |
| `@笔记` / `@文件夹` 引用 | ✅ | 已有 composer token；Agent 侧解析引用并 `note_read` |
| 图片 / 文件附件 | ✅（取决于模型） | `image_paths` / `message_attachments` 已存在；视觉能力看 provider |
| 全文搜索 / 标签过滤 | ✅ | memo `search` / `tags` |
| 反向链接 / 出链 | ⚠️ v1.1 | 本地 core 目前没有链接索引；需本地扫描或借 FNS backlinks |
| 联网搜索（工具式） | ✅ | 恢复旧 `web_search` 工具，或接搜索 API |
| 联网搜索（provider 原生） | ⚠️ 看 provider | 需要 provider-specific 适配，见 §9.2 |
| 来源/引用展示 | ✅ | 工具结果带 path/url；前端渲染 Markdown 链接 |
| 流式输出 / 工具卡片 / 停止 | ✅ | 现有 Agent 事件与 UI |
| 历史 / 持久化 | ✅ | `thread.db` + 旧 Agent persistence |
| 上下文压缩 | ✅ | 现有 `context_compaction` 事件 / token 预算 |
| 危险操作确认 | ✅ | 复用 approval 事件模式 |
| Skills | ⚠️ v1.1 | 旧 `SkillStore`；笔记本 skills |
| Sub-agent | ⚠️ v2 | 旧代码有；移动端 v1 不需要 |
| 远程 MCP（HTTP） | ⚠️ v2 | 需要 MCP client |
| 本地 stdio MCP | ❌ | 不能 spawn 进程 |
| Shell / 任意文件系统 | ❌ | 移动端不可用，也不需要 |

### 9.1 引用文档

「引用」在现有前端已经有两层：

1. **隐式上下文**：首条消息会注入当前笔记前 500 字和当前任务标签（`features/agent/store/context-block.ts`）；
2. **显式引用**：composer 支持 `@笔记` 和 `@文件夹`，序列化成 Markdown 链接（`flowix://open?...` / `flowix://folder/...`），附件也有独立 token。

内置 Agent 需要补的是**解析**，不是 UI：

- 收到用户消息后，扫描 `flowix://open?notebookId=...&relativePath=...` / `flowix://folder/...`，把引用解析成当前笔记本下的路径；
- 对笔记引用调用 `note_read`（或预先注入正文，按 token 预算截断）；
- 对文件夹引用调用 `note_list` 或 `note_search`；
- 回答里用 `<notebookId>::<relativePath>` 或 Markdown 链接回引，前端已有 note-link 渲染。

**边界**：本地 `flowix-core` 目前没有 backlinks/outlinks 索引（grep 无相关实现）；FNS 服务端有。如果「引用文档」包含反链查询，v1.1 需要本地扫描全部 Markdown 或加一个 FNS 工具。

### 9.2 联网搜索

有两条完全不同的路线，不要混为一谈：

**A. 工具式搜索（推荐 v1）**

- 旧内置 Agent 里已有 `web_search`（`agent_flowix/tools/web_search.rs`，DuckDuckGo HTML，无 API key），返回 `title/url/snippet`；
- 任何 LLM 都能用，结果可控、可引用；
- 生产环境建议换成结构化搜索 API：DeepSeek 的 `/v1/tools/search`、Brave / Tavily / Serper 等（用户配置 key）；DuckDuckGo 只做无 key 兜底，并加超时/降级/缓存。
- 搜索结果是普通工具结果，前端只要把 `url/title/snippet` 渲染出来即可形成引用；不需要模型支持 citations 字段。

**B. Provider 原生搜索（看 provider/API）**

- **DeepSeek（2026-10 官方文档）** 已经提供两种 API 形态：
  1. **独立 Search / Fetch API**：`POST https://api.deepseek.com/v1/tools/search`、`/v1/tools/fetch`，Bearer 认证，返回 `title / url / snippet / summary / date / content` 等结构化结果；
  2. **Responses API 的 hosted `web_search` 工具**：带 citations；目前先支持 `deepseek-v4-flash`。
- OpenAI Responses API 的 `web_search`、Anthropic 的 server-side `web_search`、Gemini Grounding 属于同类。
- 当前内置 Agent 走 **OpenAI-compatible Chat Completions**（`rllm`），不会自动获得 hosted search；要用 hosted 形态必须切 Responses API 或加 provider-specific 适配。
- 结论：
  - **v1**：工具式搜索最稳。用户配 DeepSeek 时直接调它的 `/v1/tools/search`（比 DuckDuckGo 抓取可靠，且结果自带摘要/日期）；其他 provider 用 Brave/Tavily 或 DDG 兜底。
  - **v1.1**：为明确支持 hosted `web_search` 的 provider 加 Responses API 适配器，减少一次本地工具往返，并使用 provider 提供的 citations。

### 9.3 其他能力的边界

- **图片/文件**：消息 wire 已支持 `input_image` / `input_file`；能否真正理解取决于模型是否支持视觉/文件输入。PDF/Office 文档在移动端可能需要先本地抽文本。
- **Skills**：旧 Agent 有 `SkillStore`，可以按笔记本加载 skills；v1 不做，避免首版工具面过大。
- **Sub-agent**：旧代码有；移动端 token/CPU 预算有限，v1 不做。
- **MCP**：远程 HTTP MCP 可以作为 v2；本地 stdio MCP 在移动端不可行。
- **Shell / 任意文件系统**：不可行，也不符合移动端笔记助手的安全边界。

**一句话**：这套方案做出的不是「Codex on mobile」，而是「一个能读写、引用、搜索、联网、带引用的笔记助手」；对移动端来说这正是合理的能力边界，而不是能力缺失。

---

## 10. 开放问题

1. **Agent 运行时**：恢复旧 `agent_flowix`，还是用 `rllm` 重写一个更小的循环？推荐先恢复、再裁剪。
2. **工具粒度**：一个 `memo` 工具（与桌面完全一致）还是拆成 8 个细粒度工具？推荐拆，移动端模型更稳。
3. **富内容 v1 是否要**：如果移动端主要用来记文本，callout/toggle/columns 可以放 v1.1；但底层操作层已经支持，放开成本低。
4. **删除确认**：默认每次确认，还是提供"自动写入"开关？
5. **离线 LLM**：v1 是否只支持云模型？如果要做端侧模型，需要额外的模型分发/内存预算。
6. **多笔记本**：AI 是否只能操作当前笔记本？推荐 v1 限制当前笔记本，避免跨库误写。

---

## 附录：关键代码位置

| 内容 | 位置 |
|---|---|
| transport-neutral 操作层 | `app/flowix-cli/src/operation.rs`（模块注释即说明用途） |
| 路径读写 / CAS | `app/flowix-cli/src/path_store.rs` |
| MCP stdio 适配 | `app/flowix-cli/src/mcp.rs`、`dsh-flowix-memory/memo-tool-schema.json` |
| 本地 NoteService / CAS | `app/flowix-core/src/service.rs`（`NoteSaveOutcome::Conflict`、`delete_checked`） |
| MemoFile 锁与索引 | `app/flowix-core/src/memo_file/mod.rs`、`operation_locks.rs` |
| 桌面 DSH 的 memo 工具 | `dsh-flowix-memory/README.md`、`launcher.mjs` |
| 桌面 Agent 指令 | `app/flowix-desktop/src/commands/agent/flowix_instructions.rs` |
| 旧内置 Agent（可恢复） | `git show 62301a4a^:app/flowix-desktop/src/agent_flowix` |
| 移动端 AI 隐藏 | commit `f82d3b3f` |
| FNS 同步写入自写抑制 | `app/flowix-desktop/src/fns_sync/store.rs`、`watcher/manager.rs` |
| 打开文档 reload 协调 | `app/flowix-web/features/document/public/sync-coordination.ts` |
