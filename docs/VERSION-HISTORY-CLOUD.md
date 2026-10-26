# 云端历史版本设计（历史版本入口拆分）

> 状态：设计稿（2026-10-26）
> 关联仓库：`fast-note-sync-service`（服务端，下称 FNS）
> 本地实测环境：`http://192.168.21.15:9000`，vault `测试`

## 1. 背景与产品决策

Flowix 目前文档右上角 `...` 菜单只有一个「历史版本」入口，读的是**本地归档**（`<notebook>/.flowix/archives/`）。FNS 服务端已有完整的笔记历史体系（`note_history` 表 + 3 条 REST API），Flowix 完全没有消费。

已拍板的产品决策：

1. **两个入口并存**：菜单拆分为「本地历史版本」和「云端历史版本」两项，各自独立子菜单。
2. **本地入口任何时候都不隐藏/关闭**——不因绑定了云端同步而裁撤（故障域互补：本地不依赖网络/服务器/账号；云端覆盖所有设备的每次同步变更且卸载重装后仍在）。
3. 两者数据集互不为超集（本地=本机保存事件完整快照；云端=全部设备的同步变更 diff），不是重复功能。

为什么云端值得做（补充动机）：

- 本地归档**不参与 FNS 同步**（`flowix-fns/src/fs_store.rs` `SKIPPED_DIRS` 含 `.flowix`），是纯设备本地的——桌面与移动端归档列表天然不同，云端历史是唯一的跨设备共享时间线。
- 移动端归档在 app 私有目录，卸载/清数据即失；云端历史是移动端的灾难恢复层。
- 云端每条记录带 `clientName/clientType/clientVersion`，能回答「这条改动是哪台设备改的」。
- FNS 每笔记默认保留 100 版（`HistoryKeepVersions`，0=无限），比本地 20 版上限多。

## 2. 现状盘点

### 2.1 本地体系（不动）

| 项 | 现状 |
|---|---|
| 存储 | `<notebook>/.flowix/archives/<sha256(path)>/{manifest.json, v_<ts>_<nanoid6>.md}` |
| 入口 | `document-titlebar-actions.tsx` → `VersionHistorySubmenu` |
| IPC | `list_path_versions` / `create_path_version` / `restore_path_version` |
| 来源 | `auto`（1h 节流）/ `manual`（保存归档）/ `restore_backup`（恢复自保）/ `cloud_conflict` |
| 上限 | 20 版，`cloud_conflict` 豁免清理 |

### 2.2 FNS 服务端能力（已对本地 9000 部署实测）

| 端点 | 说明 |
|---|---|
| `GET /api/note/histories?vault=&path=&page=&pageSize=` | 按路径列版本，分页，**无 content** |
| `GET /api/note/history?id=` | 单条详情：`content`（修改前快照）+ `diffs` + client 信息 |
| `PUT /api/note/history/restore` | 服务端直改 + WebSocket 广播 `NoteSyncModify`。**v1 不使用**（见 §3 决策 D2） |

版本生成：笔记每次同步修改后，服务端去抖 ~20s（`HistorySaveDelay`，随机 1~10s 抖动）自动落一条历史，`ProcessDelay` 计算 dmp diff patch 入库；连续编辑合并为一条。恢复 = `content + patch 应用` 得到**该版本修改后**的完整内容。

### 2.3 实测接口契约（写代码以此为准，勿凭 swagger 猜）

响应包络：`{"code":1,"status":true,"message":"Success","data":...}`，业务错误用非 1 的 `code`（如 313 UA 限制、315 范围限制、笔记不存在等，见 `pkg/code/msg_en.go`）。

列表 `GET /api/note/histories`：

```json
{"code":1,"status":true,"data":{
  "list":[{
    "id":98,"noteId":18,"vaultId":1,"path":"Kimi K3.1 Pro 模型介绍.md",
    "clientName":"Flowix","clientType":"flowix","clientVersion":"1.5.11",
    "version":4,"createdAt":"2026-10-25 23:20:06"}],
  "pager":{"page":1,"pageSize":10,"totalRows":4}}}
```

详情 `GET /api/note/history?id=96`（节选）：

```json
{"code":1,"status":true,"data":{
  "id":96,"noteId":18,"path":"...","content":"<修改前快照>",
  "diffs":[{"Type":0,"Text":"..."},{"Type":1,"Text":"..."}],
  "clientName":"Flowix","clientType":"flowix","clientVersion":"1.5.11",
  "version":3,"createdAt":"2026-10-25 23:18:28"}}
```

四个实测确认的坑：

1. **`diffs` 的键是大写 `Type`/`Text`**（go-diff 默认序列化，无 json tag）。`Type`：`0`=EQUAL、`1`=INSERT、`-1`=DELETE。
2. **该版本修改后的内容 = 按序拼接所有 `Type != -1` 的 `Text`**。不需要 dmp 库，也不需要 `content` 字段参与。
3. **`createdAt` 是服务器本地时区的格式化字符串** `"2006-01-02 15:04:05"`，不是时间戳。Rust 侧必须解析为 epoch ms 再传前端，禁止把字符串直接丢给前端 `new Date()`。
4. **认证三件套**：`Authorization: Bearer <jwt>` + `X-Client` 头必须与 token 的 `ClientType` 通配匹配（`IssueType=1` 的 token 强制校验，Flowix token 为 `flowix`）+ token 若绑定了 `UserAgent`/`BoundIP` 则请求必须匹配。**Flowix 侧统一发 `X-Client: flowix`，不设 User-Agent。**

权限模型（`internal/middleware/user_auth_token.go`）：`/api/note/*` 的 GET 映射为 `note_r`、写映射为 `note_w`，走 token 的 Scope 矩阵校验；`vault` 参数受 token 的 vault 白名单约束。云端历史需要 token 具备 `note_r`（列表+详情）权限；恢复走本地写路径，不需要 `note_w`。

## 3. 核心设计决策

### D1：两个入口，两个子菜单，不做统一时间线

用户心智里的「历史版本」先按存储域区分（本机有的 / 云上有的），字段也不同（本地有 `source` 徽标，云端有设备徽标）。拆分实现直接、语义清楚；统一时间线（合并排序、跨源去重、跨设备时钟偏差）留作后续演进，不在 v1。

### D2：云端恢复 = 拉内容 + 走既有本地恢复管线；**v1 不调用服务端 `PUT /history/restore`**

单一写路径原则：**文件是事实源**。

```
选中云端版本 → 拉取并重建该版内容（Rust 侧）
  → 保存当前文档 buffer
  → 复用本地恢复管线写文件：
       expectedContent 悲观校验 → 当前内容自保为 restore_backup → 原子覆写
       → mark_self_write（watcher 免事件回环）→ 刷新索引
  → 编辑器即时应用新内容（applyLoadedDocumentContent）
  → FNS 正常同步上行 → 其他设备经普通同步拉到
```

不直推的理由：

1. 服务端直推会产生「服务端写 + 本地未保存 buffer 稍后上行」的双写竞态，需要额外仲裁逻辑；
2. 直推后本机要等同步回包才能看到内容（编辑器反馈慢、离线完全不可用）；
3. 本地管线的安全机制（自保快照、内容校验、self-write、索引刷新）已存在且经过验证，直接复用；
4. 直推的唯一优势（无需先拉内容）被「详情接口本来就返回可重建的内容」抵消。

服务端直推留作 P2，适用于「本机 vault 已丢失，从云端重建」或 webgui 场景。

### D4：不提供「手动云端快照」，「保存本地归档」不拆分

FNS 云端历史的唯一生成入口是 `ProcessDelay`（同步修改后 ~20s 去抖触发，且 `note.Content == ContentLastSnapshot` 时直接跳过——内容无变化不落版本），**没有任何手动创建 API**（服务端仅 list/get/restore 三条路由）。因此：

- 「保存本地归档」保持纯本地动作（`create_path_version` source=manual），不做云端对应项；
- 用户改内容并同步后，~20s 自动出现在云端列表，v1 接受这条间接路径；
- 「标记重要云端版本」的真实诉求属于**版本备注/星标**（P2，需 FNS 加字段），不属于手动触发；
- 手动触发同内容版本只会制造噪音，明确不做。

### D3：内容重建放 Rust 侧，前端不碰 REST

token 与服务器 URL 只存在于 Rust 侧（`FnsConfig` + 各 notebook 的 `.flowix/sync-state.json`），前端 IPC 只拿到元数据列表和正文文本。前端永远接触不到凭据。

## 4. UI 设计

### 4.1 菜单拆分

`document-titlebar-actions.tsx` 中原「保存归档 + 历史版本」区块变为：

```
⏱ 保存本地归档        （原「保存归档」，仅本地动作，文案加「本地」消歧）
🕐 本地历史版本  ›     （现有 VersionHistorySubmenu，行为不变）
☁️ 云端历史版本  ›     （新增 CloudHistorySubmenu）
```

> 「保存本地归档」不拆出云端对应项：FNS 没有手动创建历史的 API，云端版本只能由服务端在同步修改后自动生成（见 §3 D4）。

门控条件：

| 入口 | 条件 |
|---|---|
| 保存归档 / 本地历史版本 | 现状不变：`versionHistory` 能力 + `notebookId` + `relativePath` |
| 云端历史版本 | 上述条件 + 该 notebook 已绑定 FNS（`fns_get_notebook_state(notebookId)` 返回 bound 且 vault 非空）+ 文档为 markdown |

绑定状态在打开 `...` 菜单时异步查询一次（复用/扩展 sync-status 的缓存即可），未绑定则云端项整个不渲染——不给一个点了才报错的死入口。附件与非 md 文件两个入口都按现状不出现。

### 4.2 云端子菜单（CloudHistorySubmenu）

结构与本地子菜单一致（300px 浮层、hover 展开），列表项字段：

```
[时间]                    [设备徽标: Flowix · 1.5.11]
[路径（截断）]            [v4 / 共 N 条]
```

- 时间格式沿用 `formatVersionTime`
- 设备徽标用 `clientName + clientVersion`（这是云端独有的信息，回答「谁改的」）
- 底部「加载更多」：`pageSize=20`（与本地上限对齐），按 `pager.totalRows` 判断是否还有
- 空态区分两种：`未同步过`（服务端查无此笔记）与「云端暂无历史版本」（同步过但还没落历史）；加载失败 toast 并收起浮层（与本地子菜单行为一致）

v1 不做 diff 对比视图。详情接口已返回 `diffs`，后续做预览面板时数据是现成的。

### 4.3 移动端形态：历史版本选择弹窗化

**问题**：子菜单向左弹 300px（`absolute right-full`），锚在右上角 `...` 菜单上，手机窄视口被左边缘裁剪；且开合靠 `onMouseEnter`/`onFocus`，触屏只能靠 tap 兜底，交互别扭。

**方案**：移动端弹窗化，桌面不动。

- 判断：`isMobileDevice()`（仓库既有惯例）。
- 桌面：hover 子菜单保留。
- 移动端：菜单项 `onClick` 直接开 Dialog；bottom-sheet 形态（全宽贴底、max-h ~70vh、顶边圆角），复用 `@shared/ui/dialog` 改定位，不引新依赖。
- **结构**：列表加载/渲染抽成共享 hook + 内容组件（`listVersions`、requestSeq 竞态、`refreshKey`、行渲染复用），`VersionHistorySubmenu`（桌面）与 `VersionHistoryDialog`（移动）为薄壳；云端历史的 `CloudHistorySubmenu` / `CloudHistoryDialog` 同构复用——移动端裁剪问题在云端入口上不复发。

**集成点（必须处理）**：

1. **Android 返回键链**（`use-mobile-back-button.ts`）：现优先级为 抽屉 → 文档 → 退出，不感知弹层；弹窗开着按返回会「人先回列表」。插入弹窗状态：抽屉 → **历史弹窗** → **恢复确认弹窗** → 文档 → 退出。恢复确认 Dialog 是存量组件，此隐患一并修复。
2. 移动端分支不渲染子菜单，`onFocus` 开浮层的 hover 兜底逻辑随之移除；桌面路径不受影响。

已排除的风险：弹窗不挂 `closeMenu`（软键盘 resize 误关不涉及）；列表为常规 `overflow-y` 滚动，无 contenteditable 手势冲突。

## 5. IPC 与后端设计

### 5.1 新增 Tauri 命令

放在 `flowix-desktop/src/fns_sync/` 下新文件 `history.rs`（凭据解析、服务器 URL、token 读取都依赖 fns_sync 现有模块）：

```rust
/// 云端版本列表。not_synced 单独成态，前端区分「没同步过」与出错。
fns_note_history_list(notebook_id, relative_path, page, page_size)
    -> Result<FnsCloudHistoryPage, FnsHistoryError>
// FnsCloudHistoryPage { items: Vec<FnsCloudVersionMeta>, total: u64, has_more: bool }
// FnsCloudVersionMeta { history_id, version, created_at_ms, client_name, client_type, client_version, path }
// FnsHistoryError::NotSynced | Transport(..) | Auth(..) | Server(code, message)

/// 拉取并重建某版本修改后的完整正文。
fns_note_history_content(notebook_id, relative_path, history_id) -> Result<String, FnsHistoryError>
```

### 5.2 本地恢复管线重构（`commands/memo/versions.rs`）

从 `restore_path_version` 抽出共享写侧函数，新增一个薄命令：

```rust
/// 用任意正文执行恢复（云端版本走这里）。语义与 restore_path_version 完全一致：
/// expectedContent 校验 → RestoreBackup 自保 → 原子写 → self-write 标记 → 索引刷新
restore_path_content(notebook_id, relative_path, content, expected_content) -> Option<String>
```

`restore_path_version` 改为「读归档版本 + 调共享函数」，行为零变化（现有测试护航）。

### 5.3 FNS REST 客户端

- HTTP 客户端：新增 `reqwest`（`rustls-tls`）。**TLS roots 按 target 分段**：桌面 `rustls-native-certs`，Android `rustls-webpki-roots`（Android 系统证书读取不到是已踩过的坑，与 flowix-fns 现有 TLS 策略保持一致）。
- 请求头：`Authorization: Bearer <token>`、`X-Client: flowix`、`X-Client-Name: Flowix`、`X-Client-Version: <app 版本>`。不设置 `User-Agent`（Flowix 签发的 token 不绑 UA；用户手工建了绑 UA 的 token 会得到 313，错误信息需友好提示）。
- 超时：连接+响应合计 10s；不自动重试，失败直接暴露给 UI（用户手动重试）。同步通道有连接管理，历史查询是低频一次性请求，不值得复用连接池。
- token 解析：`notebook_id → sync-state(token_id, vault) → FnsConfig.tokens` 沿用 fns_bind 时建立的映射；server URL 来自 `FnsConfig`。
- `relative_path` 直接作为 FNS 的 `path`（同步协议即用笔记本相对路径），`\` 归一为 `/`，URL 编码交给 HTTP 客户端。

### 5.4 内容重建（Rust 实现）

```rust
#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]   // 实测键为 "Type"/"Text"
struct FnsDiff { r#type: i32, text: String }

// after = diffs.iter().filter(|d| d.r#type != -1).map(|d| d.text.as_str()).collect()
```

防御：`diffs` 缺失或解析失败 → 返回 `FnsHistoryError::Server`，UI 报「云端版本内容解析失败」，不落半还原内容。`createdAt` 字符串按 `%Y-%m-%d %H:%M:%S` 解析为服务器本地时区时间转 epoch ms——若 FNS 部署时区与用户预期不符，显示的就是服务器时钟，v1 接受此语义（FNS 全线接口都如此，非本设计引入）。

### 5.5 前端状态与复用

- `CloudHistorySubmenu`（`document/components/document-cloud-history-menu.tsx`）复制本地子菜单骨架：hover 开合、requestSeq 防竞态、`refreshKey`（恢复成功后 +1 刷新两个列表）。
- 确认弹窗与恢复执行完全复用 `use-document-titlebar-actions` 现有 `confirmVersion/restoringVersionId` 状态机，仅数据源不同：新增 `pendingCloudVersion` 分支，恢复时先 `fns_note_history_content` 再 `restore_path_content`。
- i18n：`document.version.cloud.menuLabel / empty / notSynced / loadFailed / restored / confirmDescription` 等键，中英双份。

## 5.6 Agent / CLI / MCP 接入（P0 已实现）

三端共用同一份实现，避免各写一套 REST 与恢复逻辑：

| 层 | 位置 | 说明 |
|---|---|---|
| 共享核心 | `flowix-core/src/fns_history.rs` | 阻塞式 REST 客户端 + go-diff 重建 + 类型; TLS roots 按 target 分段（桌面 native-roots / Android webpki） |
| 凭据单源 | `flowix-core/src/fns_config.rs` | 由 `fns_sync/config.rs` 下沉而来（CLI 与内置 Agent 读同一份 `boot/fns-sync.json`），桌面侧仅 re-export + 策略枚举映射 |
| 恢复写侧 | `MemoFile::write_restored_content` / `resolve_notebook_md_path` | 从桌面命令下沉到 core，三端共用 restore_backup 自保 + 原子覆写 |
| 桌面壳 | `flowix-desktop/src/fns_sync/history.rs` | 解析 app 内绑定，`spawn_blocking` 包装 core 阻塞调用 |
| CLI | `flowix-cli/src/cloud.rs` | `flowix cloud-versions <path> [-b notebook] [--page N] [--json]`、`flowix cloud-restore <path> --history <id>` |
| MCP | `memo` 工具两个结构化 action | `cloud.versions`（`path`, 可选 `notebook`/`page`）、`cloud.restore`（`path`, `historyId` 必填）；`memo-tool-schema.json` 同步扩 enum 与 allOf |
| 移动端内置 Agent | `agent_builtin/tools.rs` | 工具 `cloud_versions` / `cloud_restore`；`ToolScope` 新增 `config_dir` 以读取 FNS 凭据 |

CLI / Agent 无前端 buffer，恢复不做 expectedContent 校验（`write_restored_content(..., None)`），与桌面「先保存 buffer 再比对」的区别只在并发保护层。

## 6. 边界与错误处理

| 场景 | 行为 |
|---|---|
| notebook 未绑定 FNS | 云端入口不渲染 |
| 笔记从未同步到云端 | 空态「未同步过」，不报错 |
| 离线 / 超时 | toast「云端版本加载失败」，浮层保持 |
| token 失效 / 313 / 314 / 315 | toast 区分：凭据失效→提示到设置里重新绑定；权限/UA 受限→显示服务端 message |
| 拉详情成功但本地文档已改（expectedContent 不匹配） | 拒绝恢复 + toast（与本地恢复同语义） |
| 锁定的笔记 | 恢复前拦截（与本地恢复同语义） |
| 笔记被重命名 | FNS 侧历史随 noteId 迁移（服务端 rename 已处理），新路径可查全史；与本地 `move_path_archive` 语义对齐 |
| 云端版本比本地新（他设备改的） | 允许恢复——这正是跨设备恢复场景；expectedContent 只防「打开期间的未保存并发编辑」 |
| 刚保存但服务端历史未落库（20s 去抖窗口） | 列表少最新一条，可接受；子菜单不做自动轮询 |

## 7. 安全与隐私

- token / server URL 不出 Rust 进程；前端 IPC 返回值只有元数据与正文。
- 云端查询是**只读**（`note_r`），不给 token 扩权需求；v1 不调用任何服务端写接口。
- 历史正文经 IPC 明文进前端内存，与「打开笔记」同等暴露面，无新增风险。
- 不新增遥测/日志记录历史内容；tracing 只记 notebook_id / path / history_id / 耗时。

## 8. 分期

| 期 | 内容 |
|---|---|
| **P0（本设计范围）** | REST 客户端 + 3 个 IPC 命令 + 菜单拆分 + 云端子菜单 + 拉内容走本地恢复 |
| P1 | diff 预览面板（`diffs` 数据现成，渲染层工作）；云端列表虚拟滚动（超长列表） |
| P2 | 服务端直推恢复 `PUT /history/restore`（定位：vault 丢失后的云端重建、webgui 场景）；与直推的写路径仲裁 |
| P2（FNS 仓库） | 可选增强：`GET /api/note/history/content?id=` 直接返回重建后正文，客户端不再耦合 go-diff 序列化格式；`createdAt` 改毫秒时间戳输出 |

## 9. 测试要点

- 单测（Rust）：diffs→content 重建（用本文 §2.3 实测样本做 fixture，含大写键、`-1` 删除段）；`restore_path_content` 与 `restore_path_version` 共享逻辑回归；`createdAt` 字符串解析。
- 单测（前端）：CloudHistorySubmenu 加载/空态/分页/竞态（requestSeq）；未绑定不渲染。
- 手工联调：本地 9000 实测全链路——列表 → 选版本 → 恢复 → 编辑器内容变化 → FNS 上行 → 另一设备（或 webgui）看到恢复后内容；恢复后本地列表多一条 `restore_backup`。
- 故障注入：断网、错 token（313/315）、删服务端笔记后查询。

## 10. 开放问题

1. **服务器时区**：`createdAt` 按 FNS 服务器本地时区显示。自部署场景用户可控时区，但值得在 P2 推动服务端改毫秒时间戳。
2. **移动端**：同一套 IPC/UI 直接可用（Tauri Android 同构），P0 验收时顺带在 Android 跑一遍列表+恢复即可，无需单独设计。
