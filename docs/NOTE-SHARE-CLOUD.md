# 笔记分享（FNS 服务端分享模块接入）

> 状态：设计稿 + Phase 1 实现中（2026-10-28）
> 关联仓库：`fast-note-sync-service`（服务端，下称 FNS）、`fast-note-sync-webgui`（服务端 WebGUI/分享页前端）
> 服务端分支基线：master `38c52c34`；WebGUI 基线：master `a989648`

## 1. 背景与产品决策

FNS 服务端已有完整的分享模块（`user_share` 表 + REST API + 公开分享页 `/share/:id/:token`），
Flowix 客户端完全没有消费。本设计把「分享笔记」接入 Flowix 桌面/移动端，复用服务端能力，
不引入新服务端功能。

已拍板的决策：

1. **优先客户端接入**（本设计 Phase 1），服务端分享页对 Flowix 自有语法的渲染兼容放
   Phase 2（见 §6）——Phase 1 分享出去的页面：基础 Markdown 完整可用，Flowix 特有语法
   降级显示（详见 §5），不阻塞分享功能上线。
2. **v1 只分享 `.md` 正文**。canvas / collection / 附件直链不在范围内（附件已由服务端
   在创建分享时自动解析进 `resources` 并重写链接，无需客户端参与）。
3. **REST 调用放 Rust 侧**（`flowix-core::fns_share`，阻塞 reqwest），前端只走 IPC——
   与 `fns_history`（docs/VERSION-HISTORY-CLOUD.md §5.3）同一架构分层。
4. **入口**：文档右上角 `...` 菜单新增「分享」项，门控与云端历史一致
   （notebook 已绑定 FNS 且凭据齐备）。v1 不做笔记列表右键批量分享、不做 WebGUI 式分享管理页。

## 2. 服务端能力盘点（源码确认，`share_service.go` / `handler_share.go`）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/share` | POST | 创建分享（幂等：同资源已有 active 分享先撤销再建）。body `{vault, path, pathHash, password, expireAt}` |
| `/api/share` | GET | 按路径查询当前分享（重新签发 token）。无 active 分享 → code 455 |
| `/api/share` | DELETE | 取消分享。body `{vault, path, pathHash}`（id 可选） |
| `/api/share/password` | POST | 更新密码/过期时间 |
| `/api/share/short_link` | POST | 生成短链（v1 不用，响应里已带 shortLink） |
| `/api/shares` | GET | 分享列表（WebGUI 管理页用，v1 不用） |
| `/api/notes/share-paths?vault=` | GET | vault 内所有 active 分享的笔记路径 `string[]`（列表打标用，v1 预留） |
| `/api/share/note`、`/api/share/file` | GET | 匿名只读（Share-Token 头/参数鉴权），分享页自身消费 |

关键行为：

- **pathHash 是主键**：服务端用 `note.path_hash` 查笔记，客户端必须用与同步引擎一致的
  JS 兼容 32 位哈希（`flowix-fns::hash::encode_hash32`）。`flowix-core` 不依赖
  `flowix-fns`（依赖方向不允许），在 `fns_share.rs` 内镜像实现 + 相同测试向量（`"abc" → "96354"`）。
- **path 约定**：notebook 相对路径、正斜杠（同 fns_history 的 `path.replace('\\', "/")`）。
- **token 不入库**：每次创建/查询用 SID 方案现签，客户端不要持久化 token，只拼 URL。
- **分享 URL**：`{baseUrl}/share/{id}/{token}`（`baseUrl` 服务端响应直接给出，取自
  `ShareBaseUrl` 配置 > `ExtApiUrl` > 请求 Host 动态构造，客户端不要自己拼域名）。
- **错误码**：430 笔记不存在（未同步过）、455 文件/分享不存在（Query 无 active 分享）、
  480~484 分享相关（不存在/过期/已撤销/密码缺失/密码错误）。
- **WSS**：创建/取消分享会向该用户广播 `ShareSyncRefresh` 事件（多端刷新用，v1 客户端不监听）。
- **密码**：服务端 bcrypt 存储，客户端明文传输（HTTPS 由部署保证），支持空密码=无密码分享。
- **expireAt**：unix 秒，`0`/缺省 = 永久。

## 3. 接口契约（写代码以此为准）

包络同 FNS 全局：`{"code":1,"status":true,"message":"Success","data":...}`。

创建/查询响应 `data`（`ShareCreateResponse`）：

```json
{
  "id": 129,                // 笔记（或文件）表 ID
  "type": "note",           // note | file
  "token": "CNmkmQlq0s-4elT3NuZG2w",
  "isPassword": false,
  "expiresAt": "0001-01-01T00:00:00Z",  // Go time.Time RFC3339；零值=永久
  "shortLink": "",
  "baseUrl": "https://fns.example.com"
}
```

分享页 URL = `{baseUrl}/share/{id}/{token}`。`expiresAt` 客户端只透传展示，不解析回时间戳。

## 4. 客户端设计（Phase 1，本仓库 `feat/note-share`）

### 4.1 分层（完全对齐 fns_history 模式）

```
flowix-core/src/fns_share.rs        # REST 客户端（阻塞 reqwest）+ path_hash 镜像实现
flowix-desktop/src/fns_sync/
  binding.rs                        # 从 history.rs 抽出 resolve_binding / validate_relative_path / api_error
  share.rs                          # spawn_blocking 适配 + 视图类型
  commands.rs                       # 新增 Tauri 命令
app/bootstrap.rs                    # 注册命令
flowix-web/platform/tauri/client/fns.ts   # 类型 + fns.shareCreate/... 方法
flowix-web/features/document/components/document-share-dialog.tsx  # 分享弹窗
document-titlebar-actions.tsx       # 菜单入口
```

### 4.2 Tauri 命令

| 命令 | 签名 | 语义 |
|---|---|---|
| `fns_share_available` | `(notebookId) -> bool` | 门控：等价 `fns_cloud_history_available`（同一绑定解析） |
| `fns_share_create` | `(notebookId, relativePath, password?, expireAtSec?) -> FnsShareView` | 创建（幂等），返回含完整 URL |
| `fns_share_query` | `(notebookId, relativePath) -> FnsShareView \| null` | 无 active 分享（455）返回 `null` 而非报错 |
| `fns_share_cancel` | `(notebookId, relativePath) -> void` | 撤销 |
| `fns_share_password` | `(notebookId, relativePath, password?, expireAtSec?) -> void` | 改密码/有效期 |
| `fns_share_paths` | `(notebookId) -> string[]` | 预留给列表打标 |

`FnsShareView`（camelCase serde）：`{ id, shareType, token, isPassword, expiresAt, shortLink, baseUrl, shareUrl }`，
`shareUrl` 由 Rust 侧拼好（`format!("{}/share/{}/{}", base.trim_end_matches('/'), id, token)`），
前端不碰 URL 组装规则。

### 4.3 UI（`document-share-dialog.tsx`）

- 桌面/移动统一用 `Dialog`（对齐 `VersionHistoryDialog` 的移动端形态），`useMobileBackInterceptor` 接管返回键。
- 打开即 `shareQuery`：
  - 无分享 → 「创建分享链接」+ 可选密码输入 + 有效期选择（永久 / 1 天 / 7 天 / 30 天）。
  - 已有分享 → 展示链接（只读输入框 + 复制按钮）、密码状态、有效期、浏览次数（Query 不返回浏览数，v1 不展示）、
    「更新密码」「取消分享」两个操作。取消分享需二次确认（不可逆且外部链接立即失效）。
- 创建/改密码成功后 toast + 重新 `shareQuery` 回显。
- i18n：`share.*` 命名空间，en-US / zh-CN 双份。

## 5. 分享页渲染兼容性现状（Phase 2 的问题清单）

分享页渲染器在 WebGUI 仓库 `src/components/note/markdown-editor.tsx`：
react-markdown + remark-gfm/math/breaks + rehype-katex/highlight/raw/sanitize + `transformObsidianSyntax`。

| Flowix 功能 | 存储语法 | 分享页现状 |
|---|---|---|
| 多栏布局 | `::: columns` / `:::: column` fenced div | ❌ 围栏行裸文本直接显示 |
| 折叠块 toggle | `::: toggle [collapsed]` fenced div | ❌ 同上，正文平铺不可折叠 |
| Flowix callout | `::: callout icon="…"` fenced div | ❌ 同上（分享页只认 Obsidian blockquote callout） |
| 行背景色 | 块尾行内 `<!-- flowix:block-bg {…} -->` | ⚠️ 注释被剥离，颜色丢失、文本正常 |
| 文字颜色 | `==text==<!-- flowix:text {…} -->` | ⚠️ `<mark>` 保留、颜色丢失 |
| 笔记互链 | `[label](flowix://open?…)` | ⚠️ sanitize 协议白名单拒绝，链接失效 |
| Web card | `::webcard {json}` | ❌ 裸文本 |
| 数学/Mermaid/表格/任务列表/附件/`==高亮==`/`#tag` | 标准 + Obsidian 语法 | ✅ 正常（附件图片已被服务端重写为 share file URL） |

Phase 2 方向（WebGUI 仓库，先不动）：在 `transformObsidianSyntax` 内新增 Flowix 预转换——
fenced div 扫描直接移植 `flowix-web/features/editor/extensions/fenced-div.ts` 的 CommonMark
围栏平衡规则（放在代码块占位符提取之后），映射为 `div/details+summary` + sanitize 白名单；
注释类语法 v1 剥离即可。

## 6. 里程碑

- **Phase 1（本仓库）**：REST 客户端 + IPC + 分享弹窗 + 菜单入口。✅ 已实现（2026-10-28，随本设计稿提交）：
  `flowix-core/src/fns_share.rs`（含 path_hash 镜像测试向量）、`fns_sync/{binding,share}.rs`
  （binding 从 history.rs 抽出共用）、6 条 Tauri 命令、`fns.ts` 客户端、`document-share-dialog.tsx`
  + 组件测试、菜单入口、i18n 双语言。
- **Phase 2（WebGUI 仓库 `feat/flowix-syntax-share`）**：分享页 Flowix 语法兼容层，产物回灌服务端 `frontend/`。
- **Phase 3（可选）**：笔记列表「已分享」角标（`fns_share_paths` + WSS `ShareSyncRefresh`）、分享管理页、短链。
