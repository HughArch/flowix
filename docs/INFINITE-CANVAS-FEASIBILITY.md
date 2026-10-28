# 无界笔记（无限画布）接入可行性

- 状态：可行性研究（未立项）
- 分支：`explore/infinite-canvas`
- 日期：2026-10-28
- 结论先行：**可行性高**。存储/同步/agent 三层基础设施已具备，主要工作量集中在前端 surface 注册与画布组件本身；推荐 Phase 1 直接嵌入 Excalidraw 验证，Phase 2 再按产品形态决定是否为「卡片式无界笔记」自研渲染层。

## 1. 结论

| 维度 | 现状 | 结论 |
|---|---|---|
| 存储层 | 底层 IO 扩展名无关（`file_io.rs` 的 `create_file_for_notebook` / `write_file_for_notebook` 收任意路径+bytes） | 存 `.flowix-canvas` JSON 零改动 |
| 同步层（FNS） | 非 .md 文件自动走文件/附件通道（只排除隐藏目录与临时文件） | **同步零改动** |
| agent 工具层 | `file_create/read/write` 明确支持任意非 md 扩展名 | agent 现在就能读写画布 JSON |
| 视图层 | 已有「自定义扩展名 → 专属 surface 视图」完整先例（`.table.yaml` / `.lib.yaml` / `.workdocs.yaml`） | 照抄注册流程即可 |
| 笔记索引体系 | `.md` 硬编码（注册/重建/搜索/版本历史全部只认 .md） | 画布文件**不进索引**：无 FTS、无标签、无版本历史——本方案最大的体系性代价 |

## 2. 先想清楚：两种产品形态

「无界笔记」在实际产品里有两种形态，技术路线不同，需要先做产品决策：

- **形态 A：白板手绘**（Excalidraw / tldraw 式）——自由绘制图形、箭头、手写笔迹，画布上主要是「画」。
- **形态 B：卡片无界笔记**（AFFiNE edgeless / Heptabase / Obsidian Canvas 式）——把已有笔记卡片放到无限画布上，连线组织关系，画布上主要是「引用与组织」。

两者不互斥（AFFiNE 两者都有）。若 Flowix 的核心诉求是形态 B，价值点在「笔记卡片引用 memo + 反向链接」，Excalidraw 手绘只是补充；若先要形态 A，Excalidraw 嵌入是最快路径。

## 3. 代码库地基（已逐一验证）

### 3.1 视图层路由：有完整同构先例 ✅

- `app/flowix-web/features/workspace/surface-registry.ts:86-104` — `resolveWorkspaceFileSurfaceKind` 对**特殊后缀优先路由**：`.lib.yaml` → media-library、`.workdocs.yaml` → work-documents、`.table.yaml` → table。`.flowix-canvas` 完全同构。
- `surface-registry.ts:40-60` — registry 声明每个 kind 的 hosts / capabilities（如 `file-image` 带 `fullscreen`/`zoom`）。注意已有 `mindmap` kind（rendererId `plugin-document`，带 fullscreen/fit/zoom）——画布类 surface 已有占位先例。
- `app/flowix-web/features/surface/workspace-surface-renderers.tsx:73-119` — 渲染器 **lazy 注册表**，新 surface 组件可按需加载（bundle 不进主包）。
- 结构参照物：`features/multidimensional-table/`（model + create-file + surface View），画布目录照抄此结构。

### 3.2 存储层：IO 无障碍，索引有门槛 ⚠️

- `app/flowix-core/src/memo_file/file_io.rs:113/119` — 任意扩展名写入。
- 索引门槛根在 `app/flowix-core/src/memo_file/ops.rs:123-138`（`IsMd` trait），扩散到 `ops/registration.rs:55`、`ops/reconcile.rs`（5 处）、`note_index.rs:134-140/305-315`。画布文件进笔记索引（获得 FTS/标签/版本）需要动这套门槛，**成本最高，不建议 v1 做**。
- `app/flowix-core/src/memo_file/versions.rs:138/197` — 版本历史只覆盖 `.md` + `attachments/`，画布文件无版本快照。

### 3.3 同步层：零改动 ✅

`app/flowix-desktop/src/fns_sync/store.rs`：

- 笔记通道（`list_notes` :99）只收 `.md`（`is_markdown` :312）+ 特例 `.agents/mcp.json`，且要求 UTF-8。
- **文件/附件通道（`list_files` :381）收 notebook 根下所有非 markdown 文件**（`should_skip_attachment_entry` :332-350 只排除隐藏目录、node_modules、`.tmp/.swp/.bak/.lock` 等）。`.flowix-canvas` / `.canvas`（文件名不以 `.` 开头即可）自动被覆盖。
- 限制：走文件通道 = 文件级同步语义（无笔记级冲突自愈，仅 conflict 副本），受 `max_attachment_bytes` 上限约束（`fns_sync/service.rs:671`）→ 画布 JSON 必须控制体积。

### 3.4 附件体系 ✅

图片应存 `attachments/` 目录（`commands/dialog/attachments.rs:191`），编辑器内以 `/notebook/attachments/xxx` 存储键引用（`features/editor/extensions/attachment-link/upload/storage.ts:111`）。画布内图片**外链到 attachments，不内嵌 dataURL**（否则 JSON 膨胀、撞同步上限）。

### 3.5 agent 工具层：已经能用 ✅

`app/flowix-desktop/src/agent_builtin/tools.rs`：

- `file_create/read/write`（定义 :190-232，执行 :789-866）支持任意非 md 扩展名（`resolve_writable_file_path` :869-898：1-16 位字母数字扩展名、拒 md 防绕过索引、拒隐藏目录）。
- 要加结构化画布工具（`canvas_add_node` 等）在 `tool_definitions`(:62) + `execute_inner`(:613) 加分支。v1 可先靠 file_write 全量重写。

### 3.6 窗口 / 移动端

- 独立画布窗口机制现成：仿 `commands/window.rs:63-146`（preferences 窗口）+ `capabilities/default.json` 加 label + `window_shutdown.rs:289` 注册生命周期。`tab-host-*` 通配是预留的多窗口设计。但移动端单窗口，v1 建议就跑在主窗口 surface 里，别过早桌面特化。
- 桌面/移动共享同一前端 bundle（唯一入口 `entrypoints/desktop.tsx`，`vite.config.ts:132` alias）。画布组件必须过 Android WebView 触控/性能验证（调试平板可用，测法参照性能审计流程：生产包 + CDP 采样）。

### 3.7 编辑器内参照

- Tiptap 主编辑器 `features/editor/markdown-editor.tsx`，扩展装配 `markdown-editor-extensions.ts`。若未来做「笔记内嵌画布块」（AFFiNE 式），参照 `codeblock-shiki/mermaid-renderer.ts` 的动态 import + 双模式（编辑/预览）模式，零常驻成本。

## 4. 外部方案对比

| 方案 | 许可证 | 集成成本 | 数据格式 | 手绘 | 笔记卡片 | 判定 |
|---|---|---|---|---|---|---|
| **Excalidraw** `@excalidraw/excalidraw` | MIT ✅ | 低（lazy 嵌 React 组件） | 自有 JSON（elements 数组），可与 excalidraw.com 互导 | ✅ | 弱（仅文本卡） | **Phase 1 首选** |
| tldraw | 商用需付费 license，无 license 带水印 ❌ | — | — | — | — | **排除** |
| BlockSuite（AFFiNE 内核） | MIT ✅ | 高（框架级依赖 + Yjs 数据模型，与文件同步模型错位） | Yjs doc 快照 | ✅ | ✅ | **作参考架构，不作依赖** |
| JSON Canvas 规范 + react-flow | 均为 MIT ✅ | 中（react-flow 擅长节点-连线，自由手绘需另配） | `.canvas` 开放规范（Obsidian 主导） | ❌ | ✅ | 形态 B 的格式候选 |
| 纯自研（参考 AFFiNE） | 自有代码 | 很高（pan/zoom/命中测试/选框/笔迹/性能全自担） | 自定义 JSON | 自定 | 自定 | 仅在产品形态确认为 B 且长期投入时 |

关键外部事实：

- Excalidraw 官方 React 组件对 **React 19 未声明 peer dep**（excalidraw/excalidraw#9253），运行时实际可用，需 `package.json` overrides 解决安装冲突。
- Obsidian Excalidraw 插件证明了「本地文件型笔记应用 + 嵌入 Excalidraw」是成熟路线；它默认把画布数据存在 `.excalidraw.md` 里以换取搜索/链接——Flowix 不需要这么做（文件通道天然同步独立 JSON）。
- `.excalidraw` 文件可直接拖进 excalidraw.com 打开，互操作性是白送的。
- BlockSuite 虽可独立使用（`@blocksuite/presets`），但其 Yjs 数据模型与 Flowix「纯文件 + FNS 文件同步」哲学根本错位（Yjs 增量 update 与整文件同步互斥），引入即背上协作框架；其价值在于**架构参考**：surface 元素模型 + canvas2d 分层渲染（视口裁剪）+ DOM overlay 文本编辑。
- JSON Canvas（jsoncanvas.org，MIT）是 Obsidian 开放的画布文件规范，node/edge 模型覆盖「卡片+连线」，是形态 B 下最值得兼容的互操作格式；不覆盖自由手绘。

## 5. 推荐路线（分阶段）

### Phase 0 — 可行性 spike（预计 1-2 天）

前端 7 处改动 + 一个组件，全部有同构先例：

1. `features/content/model/content-kind.ts:64-104` — 加 `.flowix-canvas` 识别
2. `features/editor/code-file.ts:28-43` — `ExternalFileViewKind` 加 `canvas` 分支（或走 surface-registry 特殊后缀路径，二选一）
3. `features/workspace/surface-registry.ts` — 注册 `file-canvas`（capabilities 含 fullscreen/zoom）
4. `features/surface/workspace-surface-renderers.tsx` — lazy 注册 CanvasSurfaceView
5. `features/surface/resolver.ts:39-88` — kind → surface 分支
6. 新建 `features/canvas/`（结构照抄 `features/multidimensional-table/`）
7. 桌面 `commands/file.rs:143` `DocTreeResourceKind` 加 canvas 分类（可选，不加重则显示为 Other）

组件本体：lazy `import('@excalidraw/excalidraw')`，`initialData` 读文件、`onChange` 防抖落盘（走现有 save-queue）。

### Phase 1 — MVP

- 图片外链 `attachments/`（上传复用现有 attachment upload 通道）
- 全屏 capability、导出 `.excalidraw` / PNG / SVG
- 移动端 Android WebView 真机触控验证
- 落盘策略：只持久化 `elements` + 裁剪过的 `appState`（丢弃 UI 瞬态）+ files 引用表；save-queue 防抖，避免编辑期间高频全文件同步

### Phase 2 — 无界笔记层（形态 B）

- 笔记卡片节点：element 引用 memo id，双击打开笔记；反向链接「哪些画布引用了此笔记」（需要一层轻量索引，可在 FNS 之外前端扫描）
- agent 结构化工具：`canvas_add_node` / `canvas_list` 等（`tools.rs` 加分支），让 agent 能生成/整理画布

### Phase 3 — 可选：自研渲染层

仅当产品形态确认为 B 且 Excalidraw 的手绘优先交互不符合需求时启动。参考 BlockSuite 架构自研：JSON 数据模型 + canvas2d 分层渲染（视口裁剪）+ DOM overlay 文本编辑。此时 Excalidraw 降级为画布内的一种绘图模式。

## 6. 文件格式草案

```jsonc
// MyCanvas.flowix-canvas（UTF-8 JSON，元素层兼容 Excalidraw schema）
{
  "type": "flowix/canvas",
  "version": 1,
  "elements": [ /* Excalidraw elements 原样存放；扩展自定义 element type 时加非冲突字段 */ ],
  "appState": { /* 裁剪后的持久态：viewBackgroundColor 等；丢弃 scroll/zoom 等会话态 */ },
  "files": {
    "img_01": { "storageKey": "/notebook/attachments/xxx.png" } // 外链，不内嵌 dataURL
  }
}
```

取舍：v1 采用 Excalidraw 兼容 elements（最快拿到全部手绘能力 + excalidraw.com 互导）；JSON Canvas 导出器作为 Phase 2 的互操作补充。不直接采用 `.excalidraw` 裸格式，因为 `files` 内嵌 dataURL 与同步体积目标冲突。

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| FNS 文件级同步：JSON 每次编辑全文件重传，多端并发编辑产生 conflict 副本（项目历史上 conflict 风暴曾致卡顿） | 同步流量 + 冲突噪音 | 落盘防抖 + 只存裁剪态；文档注明多端同时编辑同一画布的行为预期（conflict 副本可恢复） |
| 画布文件不进笔记索引：无 FTS / 标签 / 版本历史 | 功能缺口 | v1 产品层接受；未来如需，动 `memo_file` 的 IsMd 门槛（成本最高项，单独立项） |
| Excalidraw bundle 体积（~1MB+） | 启动性能 | 渲染器走 lazy 注册表（现有机制）；注意 document 打开延迟的历史教训——**lazy 边界要稳定，勿按文档重挂** |
| React 19 peer dep 冲突 | 安装失败 | `package.json` overrides，锁定 excalidraw 版本升级节奏 |
| Android WebView 触控/性能 | 移动端体验 | Phase 1 真机验证（调试平板）；必要时降级为只读预览 + 桌面编辑 |
| `max_attachment_bytes` 上限 | 大画布同步失败 | 图片外链已规避主因；超限时报错提示（走文件通道现有错误路径） |

## 8. 开放问题（需产品决策）

1. 形态 A（白板手绘）与形态 B（卡片无界笔记）哪个是 v1 主诉求？——直接决定 Phase 2 是否启动与格式演进方向。
2. 画布文件在文件树中的呈现：归 Other 还是加专属分类/图标（`DocTreeResourceKind`）？
3. 是否需要「在笔记中嵌入画布块」（AFFiNE 式混排）？v1 不做，留作 mermaid 模式的扩展位。
4. 独立画布窗口是否要（桌面机制现成，但会拉大双端差异，建议缓）。

## 9. 参考资料

- Excalidraw npm 包与嵌入文档：https://npmjs.com/package/@excalidraw/excalidraw
- React 19 peer dep issue：https://github.com/excalidraw/excalidraw/issues/9253
- JSON Canvas 规范：https://jsoncanvas.org/
- BlockSuite（AFFiNE 编辑器框架）：https://github.com/toeverything/blocksuite
- tldraw license（水印/商用）：https://tldraw.dev/license
- Obsidian Excalidraw 插件（.excalidraw.md 存储先例）：https://github.com/zsviczian/obsidian-excalidraw-plugin
- react-flow（xyflow，MIT）：https://reactflow.dev
