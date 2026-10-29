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

## 10. 附：形态 A vs B 深度对比与推荐（2026-10-28 决策讨论）

结论：**产品终局选 B（卡片无界笔记），实现路径走 A**——A 的全部技术成果（文件格式、surface 注册、FNS/agent 链路）是 B 的地基，且 B 包含 A（卡片画布上可叠手绘板），A 不包含 B。

### 10.1 七维对比

| 维度 | A 白板手绘 | B 卡片无界笔记 |
|---|---|---|
| 与核心资产协同 | 弱：画布文字是游离文本，不进索引、无互链 | 强：卡片引用 memo，反向链接补全知识体系 |
| agent 战略价值 | 低：被现有 mermaid 稀释 | 高：「把 10 篇笔记整理成画布」是 agent 独占场景 |
| 使用频率/动线 | 低频（画图时才开） | 高频（整理思路/项目/研究） |
| 差异化 | 近零：Obsidian/Logseq 均已嵌 Excalidraw | 高：本地文件 + agent + 卡片画布组合罕见 |
| 实现成本 | 低（1-2 天 spike，现成组件） | 高（以周/月计，react-flow 骨架 + 卡片渲染自研） |
| 移动端风险 | 低（Excalidraw 触控现成） | 高（WebView 多卡片渲染 + 手势冲突） |
| 数据同步友好度 | 差（elements 含坐标/样式/seed，diff 噪音大） | 好（nodes/edges 极简，agent 可直接生成） |

### 10.2 A 的天花板

1. **内容黑洞**：画进白板的内容困在坐标系统里，搜索不到、互链不上、agent 检索不到。
2. **无独占价值**：画图需求 excalidraw.com 免费直开，嵌 Excalidraw 不构成打开 Flowix 的理由。
3. **agent 价值被 mermaid 稀释**：agent 生成 mermaid 文本更自然（进索引、可 diff），A 剩余价值仅自由草图（低频）。

### 10.3 B 的 Flowix 特有契合点

1. **互链体系补全**：note-link / note-mention / 标签 / FTS 已有，唯独缺空间维度；B 的反向链接（哪些画布引用此笔记）与现有体系是乘法关系。
2. **agent 战略舞台**：`canvas_add_node(memoId)` 批量整理笔记是 mermaid 做不到的独占场景。
3. **本地文件哲学对齐**：JSON Canvas 式极简格式 diff 小、agent 可生成、未来进 FTS 成本远低于 excalidraw elements。

B 的最大代价：**卡内渲染**。画布上几十张卡不得各挂一个 Tiptap 实例（Android WebView 会很难看）。业界共识做法（Heptabase / Obsidian Canvas 同款）：**卡上只渲染只读摘要，点开进正常笔记 surface 编辑**；反向链接用轻量前端扫描（JSON 的 memoId 字段级），不碰 memo_file 的 IsMd 门槛。

### 10.4 格式演进设计（A→B 增量，非迁移）

```jsonc
// MyCanvas.flowix-canvas —— v1 顶层就预留 cards
{
  "type": "flowix/canvas",
  "version": 1,
  "elements": [ /* Phase 1：Excalidraw 兼容手绘层 */ ],
  "cards":   [ /* Phase 2：{ id, x, y, w, h, memoId } 卡片层 */ ]
}
```

- Phase 1（A）：嵌 Excalidraw 交付手绘，实质是验证整条链路（surface / 格式 / FNS / 移动端 / agent 读写），B 100% 复用。
- Phase 2（B）：react-flow 骨架 + 卡片只读摘要 + 反向链接 + agent 结构化工具；Excalidraw 降级为卡片画布上的绘图模式。
- 工期预期：Phase 1 以周计，Phase 2 以月计；桌面先行，移动端只读摘要策略。

一句话：**A 是一个功能，B 是一个平台；Flowix 该要的是平台，而平台的地基恰好就是 A。**

### 10.5 B 的基座选择：不是 Excalidraw 二次开发

B 的卡片层**不能**基于 Excalidraw 二开：其 public API 不支持自定义 element type（元素类型写死，无法注册「note-card 元素」用 React 渲染活卡片），fork 整个白板 = 永久背上上游 rebase 负担，框架外挂 hack（Obsidian 插件式的图片快照嵌入）= 卡片是死的。能力错位：Excalidraw 的强项（手绘平滑、图形工具箱）恰是 B 不太需要的，短板（封闭元素模型）恰是 B 最需要的。技术上最合适的 tldraw（custom shape 一等公民）被商用许可排除。

B 的真实基座是 **react-flow 骨架 + 自研业务层**（吸收 AFFiNE 的架构分层思想，不背 BlockSuite 框架）：

| 层 | 提供方 | 内容 |
|---|---|---|
| 格式层 | 自研 | `.flowix-canvas` schema（cards + elements） |
| 画布骨架 | react-flow（MIT） | 视口/缩放平移、节点拖拽、连线交互、框选、小地图 |
| 卡片节点 | 自研（React 组件） | memo 只读摘要、数据绑定、点开进笔记 surface |
| 知识层 | 自研 | 反向链接扫描、agent canvas_* 工具 |
| 手绘层 | Excalidraw（降级为笔迹供应商） | elements 字段存 excalidraw elements；只读走 exportToSvg，编辑走覆盖层模式 |

react-flow 替我们免写约 60-70% 的通用画布管道工程；纯自研 canvas2d（AFFiNE 式）是 react-flow 撞到硬上限后的最后手段。

## 11. 存储模型决策：独立文件 + 引用，不做 AFFiNE 式笔记画布融合

结论：画布是**独立文件（引用模型）**，卡片通过 memoId 指向笔记，笔记文件零改动；**不采用**「每篇笔记自带/融合一块画布」的 AFFiNE 模型。

### 11.1 AFFiNE 融合模型的前提在 Flowix 不成立

AFFiNE 的「每篇 doc 即画布」（page/edgeless 双模式同数据）依赖其**数据库存储**（每 doc 一个 Yjs 文档存 SQLite，画布元素是 doc 内的 surface block）。「笔记=画布」是存储架构的推论，不可单独移植。Flowix 是 .md 文件 + FNS 文件级同步，融合模型的具体代价：

1. **污染笔记管线**：画布 JSON 进 .md = 进索引 → FTS 坐标噪音、agent note_read 读到垃圾、markdown 可移植性破功。
2. **冲突风险引向笔记**：画布高频编辑每次重写笔记文件 → 笔记通道同步流量与 conflict 风险；独立文件则把冲突爆炸半径隔离在画布文件内。
3. **复现已修的性能坑**：打开笔记需检查/加载画布 surface，即 document-open 延迟修复中「surface 按文档重挂」同类问题。
4. **绝大多数笔记不需要画布**，自动挂载是浪费与 UI 噪音。

### 11.2 引用模型的净收益

多对多严格强于 1:1：一篇笔记可同时出现在多块画布（项目总览/周报/研究图谱），一块画布组织多篇笔记。Heptabase / Obsidian Canvas / tldraw docs 均为引用模型。

### 11.3 用桥接补齐 AFFiNE 的无缝体验（不融合存储）

1. **反向链接入口**：笔记 surface 显示「出现在 N 块画布」→ 跳转（轻量前端扫描 memoId，不碰 memo 索引门槛）。
2. **笔记内画布预览块**：仿 mermaid 模式（lazy + 只读预览），编辑器扩展位。
3. **双向创建流**：笔记「从此笔记创建画布」（首卡即本笔记）；画布「卡片转成新笔记」。

### 11.4 缺口与补救

- **画布无版本历史**：versions.rs 已覆盖非 md 的 `attachments/`，机制未锁死 md——把 `.flowix-canvas` 加入快照范围是定向小改（不动 IsMd 门槛），排入 Phase 2。
- **可发现性**：`DocTreeResourceKind` 加 canvas 分类（改动清单第 7 项），避免显示为 Other。
- 保存位置：画布文件放笔记本目录树用户选择处（与笔记同级），不藏内部目录——必须 FNS 可见。

### 11.5 云端版本历史边界澄清（2026-10-28 对 §11.4 的修正）

§11.4 原表述「画布无版本历史」不准确，实际分层如下：

| 历史层 | 笔记 (.md) | 附件 | 画布（文件通道） |
|---|---|---|---|
| 本地归档（memo_file/versions.rs） | ✅ | ✅（attachments/ 已覆盖） | ❌ 未覆盖；机制未锁死 md，定向小改可加 |
| 云端历史（FNS 服务端） | ✅（~20s 去抖自动落版） | ❌ 服务端本来就没有 | ❌ 同左 |

服务端源码证据（fast-note-sync-service）：`NoteHistoryDelayPush` 仅在 note_service create/update 与 history restore 路径调用；`file_service.go` 无任何 History 引用；历史体系整体笔记键控（note_history 表 + /api/note/* 端点 + go-diff 按正文）。设计稿 VERSION-HISTORY-CLOUD.md 中「附件与非 md 文件入口不出现」即源于此能力边界，非客户端 UI 限制。

推论：**附件云端历史缺失是现有产品的既有缺口**，非画布特有。

补救路径：

1. **推荐：扩服务端**——file_history 表 + file_service 修改路径加延迟落版钩子 + /api/file/history 端点，复用 note_history 的去抖/diff/清理模式；一次工作同时补齐附件与画布的云端历史。
2. 不推荐：画布搭笔记通道便车（如 .agents/mcp.json 特例）——需动客户端 is_markdown 门并连带 memo 索引/FTS 污染，为省服务端工作重新引入 §11.1 的代价。

排期：本地归档扩展（versions.rs）与云端文件历史（服务端）均为 Phase 2 项，云端部分需 fast-note-sync-service 发版配合。

## 12. Phase 0 实施记录（2026-10-28，分支 explore/infinite-canvas）

已按 §5 路线完成 Phase 0，全部为前端改动（存储/同步/agent 零改动，符合 §3 预判）：

- **文件**：`.flowix-canvas`（UTF-8 JSON，`type: "flowix/canvas"`，v1；`cards` 预留恒空）
- **surface**：`file-canvas` 注册双 host，capabilities `fullscreen`；`.flowix-canvas` 后缀在 `resolveWorkspaceFileSurfaceKind` 特殊后缀优先路由（先于 `externalFileViewKind`）
- **模块**：`features/canvas/` —— model（解析/序列化/appState 白名单/位图体积上限：单文件 2MB、总量 8MB、元素 5000）+ 惰性创建 + Excalidraw 视图（800ms 防抖原子写、lifecycle flush、序列化字节不变则跳过写入）
- **创建入口**：文件树右键「新建」→ 画布；复用 `NotebookDocumentCreateDialog`
- **依赖**：`@excalidraw/excalidraw@0.18.1`（已声明支持 React 19，无需 overrides）；CSS 随懒加载 chunk 拆分，启动包预算门禁通过
- **移动端**：同一 bundle 直接可用；`viewModeEnabled` 跟随 host readOnly

已知边界（Phase 1/2 处理）：多端同时编辑同一画布为 last-writer-wins（文件通道无合并）；外部同步修改不触发热重载；画布内图片以 dataURL 存于 `files`（有上限），正式的附件外链方案待定。

## 13. Phase 1 进展（2026-10-29）

- **画布图片外链（A1）**：图片不再以 dataURL 内嵌在画布 JSON 中，而是落盘到笔记本 `attachments/`，文档只存 `{ id, mimeType, storageKey }`（key 为笔记本相对路径，跨端有效）。新增 IPC `save_notebook_asset_content`（内联 base64 → 附件，带窗口授权校验）；打开画布时按 key 解析本机路径并读取为 dataURL 喂给 Excalidraw；新插入图片顺序上传；旧的内嵌 dataURL 画布仍可打开，并在下次编辑时自动迁移。
- **文件树图标（A2）**：`.flowix-canvas` 使用专属 Frame 图标（`content-icon.tsx`），不再显示为通用文档。
- **导出（A4）**：画布左下「导出」菜单支持 `.excalidraw` / SVG / PNG。新增 IPC `write_export_file_bytes`（桌面直接写字节；Android 走 Kotlin `writeBase64ToUri`），文本格式复用 `write_export_file`。
- 已知取舍：删除画布中的图片不会清理 `attachments/` 里的孤立文件；导出尺寸以当前视口/画布内容为准（Excalidraw 默认导出范围）。

## 14. 桌面端图片丢失与排序跳动（2026-10-29，已修复）

现象：桌面端插入图片保存正常、同步到移动端也正常，但桌面「切走再切回」后图片不显示；且打开任一画布后该文件在文件树中跳到首位。

两个独立根因：

1. **图片读取路径与保存路径不一致（嵌套笔记本）**
   `D:\flowix` 与 `D:\flowix\test` 同时注册为笔记本时，保存侧 `resolve_note_owner` 取配置顺序中的**第一个**匹配根（外层 `D:\flowix`），附件因此落在 `D:\flowix\attachments`；而画布视图用自身 scope（画布所在文件夹）拼路径去读 → 路径不存在 → 水合为空。
   修复：新增 IPC `read_notebook_asset_content(storageKey, notePath)`，由 Rust 按保存侧同一套归属规则解析并读取（并在所有注册根间回退），前端不再自行拼路径。归属规则保持与保存一致（首匹配 + 跨根回退），避免破坏已落盘的历史附件。

2. **打开即写盘导致排序跳动**
   序列化无条件刷新 `meta.updatedAt`，加上 Excalidraw 挂载时对元素的规范化，打开画布必触发一次写盘 → mtime 变化 → 按更新时间排序的文件树把该画布顶到首位。
   修复：flush 先用「不改 `meta.updatedAt` 的序列化结果」与磁盘内容比较，仅内容真正变化时才落盘；场景签名（元素版本/背景/文件集合）作为二次护栏，挂载规范化只作为基线。

验证（桌面 dev 实例 + CDP）：切走再切回图片正常渲染；打开画布前后 mtime 不变。

## 14. A3 移动端大画布性能实测（2026-10-29）

环境：Android 模拟器（x86_64，`swiftshader_indirect` 软件渲染，明显慢于真机 GPU）；测法为 CDP 驱动切换画布 + 连续 ctrl+wheel 缩放 2s 采样 rAF。

| 画布 | 元素数 | 打开耗时 | 平均帧间隔 | p95 帧间隔 | 估算 FPS |
|---|---|---|---|---|---|
| Probe（少量图形 + 2 张图） | ~10 | 791 ms | 26.1 ms | 50.0 ms | 38 |
| perf-500 | 500 | 299 ms | 31.5 ms | 66.7 ms | 32 |
| perf-1000 | 1000 | 418 ms | 25.2 ms | 50.0 ms | 40 |
| perf-3000 | 3000 | 586 ms | 37.0 ms | 83.4 ms | 27 |

结论：
- 3000 元素在软件渲染下仍可用；真机 GPU 预期更好。**保持 5000 元素保存上限**作为护栏，不做移动端只读降级。
- 打开耗时随元素数增长平缓（< 0.6s），懒加载 + 单次 `initialData` 渲染没有明显瓶颈。
- 待真机确认：平板（25053RP5CC）上重跑同一组画布，重点看 3000 元素时的捏合缩放手感。

## 15. Phase 2 定稿：卡片无界笔记（2026-10-29，分支 feat/canvas-cards）

产品终局确认为**自由无界笔记 + 卡片**（AFFiNE edgeless 的能力面）：一张画布上手写批注、便签、笔记卡片、图形、图片、连线共存。本节记录对 §10/§11 的落地修订。

### 15.1 修订决策（相对早期讨论）

1. **同扩展名，不另开 `.flowix-board`**。终局是一个画布体系；`.flowix-canvas` 格式顶层预留的 `cards` 字段按原计划启用。渲染路由按内容分流：文件含 `cards` → 统一画布 surface；纯手绘旧文件 → 继续走 Excalidraw surface（零回归）。
2. **Excalidraw 退役计划**。它在 Phase 0/1 的角色是探路车（验证 surface/格式/FNS/移动端/附件链路）+ 保险；终局形态下白板级绘图非必需。P2 起新画布全部走统一 surface，P2.5 提供旧文件一次性转换（freedraw→笔迹、rect/ellipse/diamond→形状、arrow/line→连线、text→便签、image→图片卡，storageKey 直接复用），随后移除依赖（前端包 -1MB+，少一个 React 19 overrides 维护点）。笔迹质量不降级：渲染内核用 `perfect-freehand`（MIT，Excalidraw 同款底层），触屏无压感时 `simulatePressure` 按速度模拟。
3. **卡内不编辑，三层可见阶梯**。卡面常显 = 标题 + 正文前 200 字摘要（去 markdown 噪音）+ 标签 + 相对时间，L 档卡内可滚动渲染至 ~2000 字；速览 = 全局共享单个只读渲染实例，桌面 hover 300ms / 移动端长按触发；双击 = 正常笔记 surface 编辑，返回画布视口保持。理由：50 张卡全量挂 Tiptap ≈ 打开 +0.5~1.5s 且移动端不可行（document-open 重挂教训的放大版）。
4. **卡片身份 = `notebookId + relativePath`**，与 note-link（`flowix://open?notebookId=…&f=…`）同一套约定，复用 `tryMatchPhysicalMemoPath` 式解析；`title` 存快照供 stale 展示与重绑候选。`memos` 主键是 `relative_path`，不自造稳定 id。
5. **摘要数据通路**：`memos.preview` 取的是首条正文行（≈标题），不能当摘要用；新增批量 IPC `read_note_cards(paths[])`，Rust 侧剥 frontmatter/markdown 噪音返回 `{title, excerpt, tags, wordCount, mtime}`。禁止每卡一次 IPC。

### 15.2 格式扩展（.flowix-canvas v1 内增量）

```jsonc
{
  "type": "flowix/canvas", "version": 1,
  "meta": { /* 不变 */ },
  "elements": [ /* 不变：Excalidraw 手绘层（统一 surface 中作只读底图） */ ],
  "cards": [
    { "id": "c_1", "kind": "note",   "x": 0, "y": 0, "w": 320, "h": 220,
      "notebookId": "nb_1", "path": "research/a.md", "title": "快照" },
    { "id": "c_2", "kind": "text",   "x": 0, "y": 260, "w": 240, "h": 150, "text": "…" },
    { "id": "c_3", "kind": "image",  "x": 400, "y": 0, "w": 320, "h": 220, "fileId": "img_01" },
    { "id": "c_4", "kind": "canvas", "x": 800, "y": 0, "w": 320, "h": 220,
      "notebookId": "nb_1", "path": "sketches/b.flowix-canvas", "title": "白板引用" }
  ],
  "shapes": [ { "id": "s_1", "shape": "rect|ellipse|diamond", "x": 0, "y": 0, "w": 200, "h": 120,
                "fill": "blue", "stroke": "solid", "text": "标签" } ],
  "ink":    [ { "id": "k_1", "points": [[0,0],[12,3]], "color": "#e11", "width": 2, "z": "below|above" } ],
  "edges":  [ { "id": "e_1", "from": "c_1", "to": "c_2", "label": null, "kind": "manual" } ],
  "frames": [ { "id": "f_1", "title": "Q4", "x": -40, "y": -40, "w": 900, "h": 700, "color": "blue" } ],
  "files":  { /* 不变 */ },
  "appState": { /* 不变 + viewport */ }
}
```

序列化规则沿用已验证的三条铁律：持久化引用永不丢（§14 的教训）、字节不变跳写、`touchUpdatedAt:false` 比较。

### 15.3 分期

| 阶段 | 内容 | 验收 |
|---|---|---|
| P2.1 | react-flow 骨架、含 cards 文件的 surface 路由、卡片只读渲染、视口持久化；**第一天 react-flow 移动端 spike** | 桌面 100 卡拖拽 60fps；打开 <400ms；重开视口不变、mtime 不变 |
| P2.2 | 编辑交互：便签、文件树拖入、连线、分组框、尺寸档、右键菜单、⌘K 插入 | 全流程键盘可达；Android WebView HTML5 DnD 不可用则改 pointer 自绘拖拽 |
| P2.3 | 笔迹层（perfect-freehand + 橡皮 + 图层顺序）、形状四件套、图形文字、undo/redo、导出 PNG/SVG | 手绘与卡片同坐标系对齐；模式切换时手势仲裁无冲突 |
| P2.4 | 移动端：单指拖卡/空白平移、双指缩放、长按菜单、底部工具条、`onlyRenderVisibleElements` 虚拟化 | 模拟器 + 平板：300 卡可用，A3 同款测法 |
| P2.5 | 知识层：反向链接「出现在 N 块画布」（Rust 扫 resource_catalog + mtime 缓存）、stale 卡重绑、agent `canvas_list/add_card/link`；旧文件转换器 + 移除 Excalidraw | agent 一句话把 10 篇笔记摆成画布 |

### 15.4 v1 不做清单

卡内编辑、笔记内嵌画布块、画布嵌画布（引用卡除外）、跨笔记本卡片、多点拐弯箭头、图形库、富文本图形标签、对齐分布工具。
