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

### 15.5 修订：不做旧画布兼容（2026-10-29，commit 8ff3b8ff）

产品决策：只考虑新版画布。§15.1 第 1 条的「纯手绘旧文件继续走 Excalidraw surface」和 15.3 P2.5 的旧文件转换器**作废**——所有 `.flowix-canvas` 文件一律渲染卡片板；旧文件的 `elements` 数据仍在磁盘上（model 透传保留），但不再渲染。Excalidraw surface、lazy loader 与 `@excalidraw/excalidraw` 依赖当日移除（前端包 -1MB+ 提前兑现）。笔迹/形状能力按 §15.3 P2.3 自研计划不变。

P2.1 骨架实测记录（桌面 dev + CDP）：板打开 171ms；打开不写盘（fitView 触发 onMoveEnd 的坑用「载入时 seed 首个 move-end」修复）；卡片拖拽与平移均经字节不变跳写落盘；视口持久化恢复；双击笔记卡经 `openNoteByNotebookPath` 打开；老画布开空板。已知局限：固定 bottom→top 锚点对右上方向连线出现小环，P2.2 换浮动锚点。

### 15.6 P2.3 提前：手绘笔迹层第一版（2026-10-29，commit 79c2e26d）

应产品确认「一张画布上既有卡片又能手绘」提前落地：

- **笔迹层**：`perfect-freehand`（Excalidraw 同款笔迹内核）渲染，`ViewportPortal` 内 SVG 与卡片同坐标系、随缩放平移；z 序在卡片之上（批注语义）。
- **工具条**：选择/画笔/橡皮 + 6 色 + 3 档粗细；笔/橡皮模式禁用 pan 与节点拖拽（双指缩放保留），笔模式下双击卡片不触发打开。
- **存储**：`document.ink = [{id, points, color, width}]`（flow 坐标），护栏 2000 笔 × 4000 点；沿用字节不变跳写。
- **橡皮**：折线段距离采样按笔擦除，一次手势合并一次落盘。
- **WebView2 坑**：1×1 SVG + `overflow: visible` 的溢出绘制技巧在 WebView2 不生效（页内对照实验证实），改为按笔迹包围盒动态定位 SVG + `<g>` 平移映射。
- CDP 实测：画线落盘 `{points,color,width}`、橡皮擦除落盘、三色笔迹随视口变换渲染正确。

### 15.7 卡片正文 / 纯白板背景 / 形状（2026-10-29）

- **卡片正文（commit 3eab930e）**：卡片不再显示「双击打开」占位。新增批量 IPC `read_note_card_summaries(filePaths[])`（上限 500/次），Rust 侧返回 `{title, excerpt, tags, modifiedAt, charCount}`；core 新增 `extract_card_excerpt`（跳过标题行、丢弃 `:::` 指令行、剥掉 `++`/`==` 行内标记，带单元测试）。卡面布局：标题栏 + 正文（5 行截断）+ 标签 chips + 相对时间；空笔记显示「空笔记」。打开画布只发一次 IPC，不在每张卡上各发一次。
- **纯白板背景（同 commit）**：移除点阵网格，画布为纯背景色；新增「适应视图」工具栏按钮，避免还原的视口成为死路。
- **形状（commit 1fd40aeb）**：矩形/圆/菱形 = `document.shapes` 节点，拖拽创建（单击落默认 160×100）、拖动、选中后八向缩放、双击内联文字（Enter 提交 / Esc 取消）、Delete 删除；z 序在卡片之下、笔迹之上。缩放/移动/删除直接回写文档并走字节跳写契约。
- **验证坑**：xyflow 的 `deleteKeyCode` 只响应真实按键，合成的 `KeyboardEvent` 无效 —— CDP 验证要用 `Input.dispatchKeyEvent`；同理文本提交用 `focusout`（React 的 onBlur 挂在 focusout 上），合成 `blur` 不触发。

### 15.8 P2.3 完成：样式面板 / 文字 / 箭头 / 撤销重做 / 导出（2026-10-29）

- **样式面板（commit e8a9204f）**：选中形状后浮动属性条——描边色 6 档、背景色 6 档 + 无填充、线宽 1/2/4、线型 实线/虚线/点线、文字元素额外有字号 14/20/28/36；改动作用于全部选中项。图形重建时恢复选中态（否则面板一应用就消失）。
- **文字工具**：点选后在画布落一个独立文本（`shape: 'text'`，无边框），立即进入编辑，Enter 提交 / Esc 取消，与实际 Excalidraw 手感一致。
- **箭头（commit c5d83d27）**：拖拽从尾到头绘制，箭头大小随线宽，存 `{x,y,x2,y2}`，节点包围盒带 14px padding 便于点选；箭头不显示缩放手柄。
- **撤销/重做**：对序列化文档做线性快照栈（上限 100），所有变更点（创建/移动/缩放/删除/样式/文字/笔迹）都记录；快捷键 ⌘/Ctrl+Z、⇧⌘/Ctrl+Z 或 Ctrl+Y，另有工具栏按钮（含禁用态）。
- **导出**：`board-export.ts` 把分组框/形状/箭头/笔迹/卡片重绘成独立 SVG（PNG 由 SVG 离屏栅格化），文本做了 XML 转义；单测覆盖结构、转义与样式。
- 验证：桌面 dev + CDP（箭头落盘、创建→撤销→重做节点数 6→7→6→7 且文件一致）；单测 96 绿、tsc、生产构建通过。

### 15.9 手绘体 / 多选 / 连线 / 复制粘贴（2026-10-29，commit 3f5aeef6）

- **手绘体**：形状与文字改用 roughjs（Excalidraw 的线条引擎），按 shape id 派生稳定 seed（重渲染不抖动）；文字与图形标签使用手写字体栈（Xiaolai SC / Kaiti SC / KaiTi / Segoe Print / Comic Sans）。拖拽预览画的是**手绘轮廓**而不是虚线矩形（与 Excalidraw 一致）。
- **工具语义**：选择工具 = 框选多选（拖空白拉框、Shift 加点）；新增**手型工具**负责平移画布；箭头仍是连线工具。
- **连线**：用箭头从一个图形拖到另一个图形，端点落在图形上即吸附成正式 edge（写入 `document.edges`），否则落成自由箭头。锚点（Handle）仍在选中节点上显示，作为另一种连接入口。
- **复制粘贴**：Ctrl/Cmd+C、V、D 复制当前选中（卡片 + 形状），新 id + 28px 偏移；双击空白画布直接落一个文本并进入编辑。
- **导出**：SVG 导出复用同一套 roughjs 路径，导出结果与画布一致。
- 验证：复制粘贴 12→13 落盘；箭头从形状拖到卡片生成 edge 并落盘；双击建文本、拖拽预览渲染确认。

### 15.10 透明度 / 工具锁定 / 对齐分布（2026-10-29，commit 696e7c44）

- **元素透明度**：`BoardShape.opacity`（1-100，读取时钳位），样式面板滑杆；滑杆拖动过程只更新不记撤销，松手记一条（`patchSelectedShapes(patch, record)`）。
- **工具锁定**：Excalidraw 语义的锁 = 画完不切回选择工具，工具条末尾锁形按钮切换（`toolLocked`）。
- **对齐分布**：六种对齐（左右/水平居中/顶底/垂直居中）+ 双轴等距分布，面板在多选 ≥2 / ≥3 时出现；数学抽成纯函数 `board-align.ts`（`alignShapes` / `distributeShapes`，原地修改 + 单测覆盖边界情况）。
- 验证：透明度 40 经 CDP 落盘；34 个 canvas 单测 + 生产构建绿。多选本身依赖真实 Shift/框选手势，合成事件验证受限，纯函数已单测覆盖。

### 15.11 工具栏/属性面板分离（2026-10-29，commit f22b703a）

采纳 Excalidraw 布局：顶部条只放工具（宽度恒定），左下角新增带标签的「画笔默认属性」面板（描边/背景/线宽/线型/字号/不透明度，按工具裁剪显示），改的是接下来画什么、不触碰文档；选中元素属性仍在顶部居中面板。新建图形消费这些默认值（fill/strokeStyle/fontSize/opacity）。此前工具条内联属性在形状工具激活时会膨胀到 30+ 按钮，已移除。

### 15.12 缩放/撤销底栏 + 调色板按钮（2026-10-29，commit 817e37b0）

- **左下常驻控制条**（Obsidian Canvas 风格）：缩小 / 实时百分比 / 放大 / 分隔 / 撤销 / 重做。**点百分比一键重置 100%**（保持当前中心点不变），撤销重做从顶部条移入。常驻显示，不随工具切换消失。
- **调色板按钮**：描边/背景色不再平铺色板——每行一个显示当前色的圆形按钮，点击呼出色板网格（含「无填充」）；工具属性面板与选中属性面板统一改用此组件。
- 验证：CDP 实测放大 100%→112%→重置回 100%；104 单测 + 构建绿。

### 15.13 属性统一进左下面板（2026-10-29）

采纳 Obsidian Canvas 的单面板形态：撤掉顶部选中面板，左下一个面板覆盖两种语境——**有选中 = 编辑选中图形**（平铺描边/背景色板、线宽、线型、字号、不透明度滑杆、对齐/分布、图层 置顶/上移/下移/置底、操作 复制/删除），**无选中且画笔激活 = 编辑画笔默认值**。调色板弹层（ColorPopover）移除，色板常驻平铺。图层顺序通过重排 `document.shapes/cards` 数组实现（同 kind 内生效）。

### 15.14 属性面板逐项对齐 Obsidian（2026-10-30，commit 0c8ccfd0）

对照 Obsidian 截图逐项复制：
- **色板**：描边 5 色（黑红绿蓝橙）+ 当前色大块；背景 白/粉/绿/蓝/黄 + 透明；全部方形圆角 swatch。
- **描边宽度**：5 档（1/2/4/8/16）。
- **填充**（填充风格）：hachure 斜线 / solid 实心 / cross-hatch 交叉线，接入 roughjs `fillStyle`。
- **线条风格**：roughness 0/1/2.5（建筑师/艺术家/涂鸦），接入 roughjs。
- **边角**：矩形 直角/圆角（圆角用 path 生成，roughjs 无原生圆角矩形）。
- **压感**（画笔）：模拟压感开/关，关闭的笔迹持久化 `pressure: false`。
- **透明度**：滑杆加 0/100 刻度。
- **图层图标**：ArrowDownToLine/ArrowDown/ArrowUp/ArrowUpToLine（与 Obsidian 一致）。
- **操作第三个按钮 = 链接**：`shape.link` 存储，面板内联输入框编辑，形状右上角渲染 🔗 徽标（`<a target=_blank>`）。
- 34 canvas 单测 / 104 全量 / 构建绿；CDP 截图确认面板行渲染（描边/背景/填充/线宽/线条风格/边角/线型/不透明度/图层/操作）。

### 15.15 修复批次（2026-10-30，commit 5b30dc5c）

1. **线型不生效**：roughjs `toPaths()` 输出不带 `strokeLineDash`（dash 只在 `drawable.options` 上，官方 SVG 渲染器从那里读）。修复 = 从 drawable.options 取 dash 附加到 stroke 路径，并透传到 SVG 导出。
2. **图层不生效**：react-flow 默认 `elevateNodesOnSelect` 把选中节点抬到 z 1000，选中状态下置底永远「看不见」。设为 false。
3. **透明度行**：文案改「透明度」，0/100 刻度独立一行（此前挤成 0100）。
4. **底栏照抄 Obsidian**：`[☰] [⧉ 🗑] [↺ ↻]` + 右侧独立缩放胶囊 `[− 100% +]`；☰ 收起/展开属性面板，选中图形自动展开。

### 15.16 笔迹可选中 + 选中框外扩（2026-10-30，commit 293b8e88）

- **笔迹成为一等节点**：每条笔迹渲染为 `type: 'ink'` 的 react-flow 节点（不再是纯绘制图层）。可点选、拖动（按拖拽起点平移 points）、改描边色/线宽、调整层级、复制粘贴、删除；未完成的笔迹仍走 ViewportPortal 实时绘制。
- **选中框外扩**：形状节点包围盒扩大 `SHAPE_PADDING = 12`，选中框落在图形外侧（Obsidian 行为），拖动/缩放时按 padding 反算回文档坐标；笔迹包围盒内边距 16。
- 实测：3 个 ink 节点可选，选中后面板出现 描边/线宽/图层/操作；形状 path 243×268 落在 257×282 节点盒内（外圈可见）。

### 15.17 文字面板对齐 + 调色盘图标（2026-10-30）

- 文字元素拥有独立属性行（对齐 Obsidian）：描边 / 字体（手写/无衬线/等宽/衬线）/ 字号 XS·S·M·L·XL（12/16/20/28/36）/ 文本对齐 / 透明度 / 图层 / 操作；图形专属行（背景、填充风格、线宽、线型、边角）对文字隐藏。
- `BoardShape` 新增 `fontFamily`、`textAlign`；ShapeNode 按字体栈与对齐渲染，创建文字时消费工具默认值。
- 面板按当前选中类型实时切换（图形 / 文字 / 笔迹三套行）。
- 底栏图标由 ☰ 换成调色盘（Obsidian 的属性面板开关）；三横线菜单本期不实现。

### 15.18 选中态与面板同步修复（2026-10-30，commit 8ea8e56d）

根因：面板内容依赖 `onSelectionChange` 回调 + 本地 state，但画布每次改动都会重建节点图并手动恢复 `selected`，这类程序化选中/清除不触发回调 → state 变旧，面板偶发不弹或显示上一种元素的属性。

修复：
1. 选中镜像改为**从渲染节点派生**（`node.selected`），并在 `nodes` 变化时用 effect 同步；
2. 任何选中都打开面板：卡片只显示 图层/操作，笔迹显示自己的行，文字/图形各自完整行；
3. 绘制工具激活时元素仍可选中（`elementsSelectable` 恒真），且落在节点上的按下不再开始绘制 → 点元素总能切到对应工具盘。

实测：shape/text/ink/card 四种选中分别渲染各自的属性行；矩形工具激活时点文字节点，节点数不变且面板切到文字行。

### 15.19 拖拽缩放修复 + 图片插入（2026-10-30，commit d190af88）

1. **拖拽放大不生效**：roughjs 路径由图形几何生成，`handleShapeResize` 只改文档不重建节点 → 视觉不变。修复 = 缩放结束后重建节点图（`applyGraphRef`），路径随新尺寸重绘。实测 81×81 → 177×153，文档 w/h 同步。
2. **图片插入**三条入口：拖文件到画布（落点插入）、剪贴板粘贴（视口中心）、工具条图片按钮（文件选择器）。字节写入 `attachments/`，画布 JSON 只存 `storageKey`（跨端可解析）；大图缩到 360px 宽，过小图放大到 96px 保证可抓取。
3. 验证：拖入 PNG 生成 image 卡 → 写入 `attachments/drop-test.png` → 重载后仍从附件渲染。

### 15.20 Android 模拟器验证与触控修复（2026-10-30，commit 3c874a72）

APK（x86_64 debug）装到 `Pixel_7` 模拟器后暴露一串只在触控下出现的问题：

1. **手绘"画完不显示"**：笔迹改成节点后，`syncInkToDocument` 只更新文档没重建节点 → 落笔后要重开才看得到。修复 = 重建图。
2. **真机触摸手势进不了绘图处理器**（合成派发可以）：改为在画布元素上挂**原生捕获阶段** pointer 监听，绕开 React 合成事件与 react-flow pane 的拦截。
3. **surface 加 `touch-action: none`**，避免 WebView 把笔画当页面滚动吞掉。
4. **分组框 `pointer-events: none`**，否则框内无法起笔。
5. **绘制工具下永远绘制**（不再抢手势去选中指针下的元素）；切换工具时清空选中，面板只显示该工具自己的行。

实测：点选元素 → 面板显示对应行；在已有内容上两次触控滑动 → 笔迹立即可见（ink 37→40）；画笔面板只剩 描边/线宽/压感。

### 15.21 字体面：内置 Virgil/Liberation/Cascadia + 五格字体行（2026-10-30）

- 从 `@excalidraw/excalidraw` 包中提取单文件 woff2 并随包分发（+193KB）：**Virgil**（Excalidraw 最早的手绘拉丁字体）、**Liberation Sans**（Helvetica 度量）、**Cascadia Code**（等宽）。中文仍走系统回退：手写体槽位用楷体。
- 字体行对齐 Obsidian 五格：手写（笔尖）/ 正常（A）/ 代码（</>）/ 粗体（B，weight 800）/ 衬线（A）；`BoardFontFamily` 增加 `bold`，文字元素按面渲染字重。
- 验证：`document.fonts.check` 三款均 true；"Hello Flowix 手写体" 拉丁部分是 Virgil、中文是楷体；面板显示五格。
- 说明：Excalifont（Obsidian 新默认手写体）在包内是 7 个 hashed 子集且无 unicode-range 清单，无法直接内联；Virgil 是单文件且在 Obsidian 列表里仍可选用，故选它。

### 15.21 补充：触控拖拽收起面板（2026-10-30）

移动端语义对齐 Obsidian：**点选 = 唤起面板；拖拽 = 手势期间收起面板**。实现：`handleNodesChange` 检测 `position + dragging` 且 `pointerType === 'touch'` 时收起；`onNodeDragStop` 复位。附带修复：绘制工具下点选元素的旧逻辑移除（绘制永远优先），切换工具清空选中。

### 15.22 三连修复：缩放回归根因 + 全局图层序 + 字体菜单（2026-10-30）

用户实测反馈三项，逐一修复：

1. **除图片外所有元素拖拽缩放只放大边框**。根因是回归：e7c7fbcc 在合并 ref 同步 effect 时把 `applyGraphRef.current = applyGraph` 的赋值删掉了，此后所有走 ref 的重建（形状/文字缩放、笔迹缩放、图片插入、笔迹实时渲染）都是静默 no-op。图片"看起来正常"只是因为 NodeResizer 拖拽时直接改了节点盒子、`<img>` 填满盒子；文档其实同样没写对。修复 = 在无依赖数组的 ref 同步 effect 里恢复赋值。
2. **图层不生效**（图片置底仍覆盖形状）。两层原因：`moveSelectedLayer` 只对 `selectedShapeIds` 生效（选卡片直接 return）；zIndex 按**类型硬编码**（shape 5 / card 10 / ink 20），跨类型永远 card 压 shape。修复：`z` 成为 shape/card/ink 的持久化字段（v1 格式可选字段，老文件缺省回退类型默认值），图层按钮在**三类元素合并的全局栈**上排序（置顶/上移/下移/置底 + 稠密重编号），新建/粘贴/复制元素取 `nextZ()` 落到最顶层。连线归属判断同步改为按节点类型而非 zIndex 值。
3. **字体行出现两个一样的 A**。对齐 Obsidian：手绘保持 Pencil 直选按钮，第二个 A 改为**菜单按钮**（当前字体渲染的 A + 上箭头），点开上弹菜单列出 手绘/正常/代码/粗体/衬线，每项用各自字体渲染 "A" 并带名称；A 按钮字形随当前字体实时预览。

测试：canvas 36/36（新增 z 读取与序列化往返 2 例）；桌面 dev 与模拟器实机复验缩放/图层/菜单。
4. **（验证中发现）缩放手柄只有节点框外的四分之一可点**。`NodeResizer` 手柄是节点的第一个子节点，而后绘的 `absolute inset-0` 文字层 paint 在上，把手柄与节点框重叠的部分全部挡住——只有露出框外的象限（~4×4px）能响应。桌面端用户恰好点到外露象限所以"时好时坏"。修复：`ResizeBox` 的 handle/line className 加 `!z-10`，整个手柄可抓取。

### 15.23 实时缩放 + 文字字号跟随（2026-10-30）

用户反馈两点：①拖拽缩放必须松手才生效；②文字元素缩放只改边框、字号不变。

1. **实时缩放**：`ResizeBox` 同时接 `onResize`（每帧）与 `onResizeEnd`（松手）。每帧只重绘被拖的那个节点（改 `data` + `width/height` + `style`），不重建整图——重建会和拖拽抢状态、丢选中。松手时才提交文档、记撤销、重建全图。
   - **坑 1**：React Flow 的 `NodeResizeControl` 在 `onResize` 回调之后紧接着发自己的 `dimensions` 变更（写 `node.width/height`），同步 `setNodes` 会被它覆盖。解法：`queueMicrotask` 里更新，保证本帧最后生效。
   - **坑 2**：渲染优先读 `node.width/height` 而非 `style`，两者都要写。
   - **坑 3**：手势起点几何必须快照（`resizeBaseRef`），笔迹/文字的缩放任一帧都基于快照重算；用实时值会指数叠加。
2. **文字等比缩放**：文字元素按"拖拽起点的框"与当前框的几何平均求统一缩放，`fontSize` 同步乘该系数，框以拖拽框中心为锚点等比缩放 —— 长宽比由文字本身决定，字号始终填满框。松手提交的是最后一帧几何（`onResizeEnd` 的 box 是 d3 松手点，与最后一次 move 略有差异，直接重算会"跳一下"）。

3. **移动端属性面板遮挡缩放手柄**：面板容器的 `max-h-[calc(100%-120px)]` 放在自动高度元素上，百分比没有参照 → 实际不生效，面板随行数长到遮盖半个画布，被压住的手柄点不到（用户所述"必须手动隐藏工具栏才能拖动"）。修复：上限移到**定位容器**（`absolute bottom-4` 的父级，百分比相对画布），面板本体改为 `min-h-0 overflow-y-auto`。
4. **验证记录**（桌面 WebView2 + 模拟器）：矩形 rough 路径、笔迹、文字字号都在拖拽过程中实时增长；松手与最后一帧完全一致（无跳变）；文字框长宽比保持不变、字号随框等比变化。

### 15.24 笔记卡片：只读全文 / 标题片段 / 侧栏编辑实时镜像（2026-10-30）

产品对齐 AFFiNE：画布卡片在**三端一致**地只读渲染完整的笔记正文（或按标题选中的片段）；双击在桌面/平板的右侧栏打开笔记编辑，编辑内容实时镜像回左侧卡片；手机窄视口保持整屏跳转。

1. **渲染路线：静态 HTML，不挂 Tiptap 实例**。worker 解析 Markdown（`parseMarkdownInWorker`）→ 用 `getSchema(createMarkdownEditorExtensions())` 构造**只读 schema** → `DOMSerializer` 序列化 → 展示层后处理。实测 2KB 笔记 ~7ms/篇、9.5KB ~11ms/篇；50 个 Tiptap 实例的 0.5~1.5s 成本被绕开。渲染结果挂在 `.markdown-editor > .editor-document-body > .ProseMirror` 外壳里，编辑器样式原样生效（`styles/canvas-board.css` 只修正固定卡高下的文档壳尺寸）。
   - `features/editor/read-only/read-only-schema.ts`：schema 必须用真实 node 定义，parser-only 注册表只有 markdown tokenizer（图片/互链节点缺失，重复追加会丢属性）。
   - `features/editor/read-only/render-note-content.ts`：`sanitizeBlocks` 丢弃 frontmatter/未知节点（未知容器解包保留子节点）、`renderNoteContentHtml` 失败时降级为转义纯文本；表现层补齐 **callout 图标栏**（NodeView 专属）、**附件 URL**（storageKey → 笔记本绝对路径）、**互链芯片**（含 heading）。
   - 已验证渲染：callout（颜色/图标栏）、toggle、表格、任务列表、代码块、引用芯片、图片附件。已知退化：mermaid/Shiki 高亮退化为代码块，agent thread card 为静态占位。
2. **数据模型**：`BoardCard.renderScope?: 'excerpt' | 'full' | 'section'` + `heading?: string`（v1 可选字段，老卡缺省仍是摘要）。只存引用不复制正文，FNS 冲突面不变。标题片段取"该标题到下一个同级/更高级标题"，标题失效时**回退整篇**并保留字段（改名回来自动恢复）。
3. **数据通路**：新增批量 IPC `read_note_card_contents(filePaths)`（单文件 256KB / 单板总计 8MB 上限，超出保留摘要面），内容按 `path+heading` 缓存；插入时只请求新卡对应路径，其它卡命中缓存。
4. **插入入口**：工具栏「笔记」按钮打开插入对话框（搜索笔记 + 整篇/按标题范围）；文件树拖拽复用 `shared/drag-drop/drag-drop-coordinator`，画布注册 drop target（优先级 60），落点即卡片位置。
5. **双击路由**：桌面/平板按**视口宽度**（`useIsMobileViewport`，≤767 为手机）决定——宽屏开 `browser-column`（画布保持可见），窄屏整屏 `main-third`；画布自身在侧栏时反向开在工作栏，避免替换自己的标签页。`CanvasSurfaceViewProps` 新增 `workspaceHost`，渲染器传 `context.host`。
6. **实时镜像**：订阅 `subscribeDocumentBufferChanges`（每次击键更新 buffer，含侧栏隔离 session），250ms 防抖 → 重新切片/解析/序列化 → 只更新缓存并 `applyGraph`；按路径做版本号丢弃乱序的 worker 结果。外部磁盘/FNS 变更走 `subscribeNotebookChanges`（外部编辑归一化为 `query-invalidated`，不能按 `resource-updated` 过滤），400ms 防抖后强制重读。
7. **交互**：未选中的卡面 `pointer-events: none`，让点击/滚轮/拖拽全部归画布；选中后卡体 `overflow-y-auto nodrag nowheel touch-pan-y`——单指上下滑动阅读、滚轮滚内容，不拖动卡片也不缩放画布；移动卡片改从标题栏拖动。内容更新用 `useLayoutEffect` 恢复 `scrollTop`，编辑时卡面不跳。
8. **验证记录**（桌面 dev + CDP）：插入整篇/标题片段落盘正确；片段卡只含该小节；失效标题回退整篇；双击开右侧标签页且画布保留；右侧输入后卡片 ~1s 内更新；外部改文件后卡片刷新；卡内滚动 300px 在内容刷新后保持。

### 15.25 卡片与连线四项修订（2026-10-30）

1. **新建元素沿用上次样式**：`patchSelectedShapes` / `patchSelectedInk` 在修改选中元素的同时同步工具默认值（描边/填充/填充风格/线型/线宽/字号/字体/对齐/透明度/粗糙度/边角），下次新建同类元素直接继承；此前选中元素改样式只改元素本身，新建会回到旧默认值。
2. **卡片标题与属性**：卡片头部标题改用卡片自带的笔记标题快照（`card.title`），不再使用批量摘要的 `summary.title`（它是正文首行派生，正文以 H1 开头时头部会重复该 H1）；卡片底部不再显示标签等笔记属性，只保留修改时间。
3. **四向连接点**：`CardHandles` 由「上(target)+下(source)」扩为四向各一对（`src-top/right/bottom/left`、`tgt-...`），target 常驻透明命中区、source 在选中时显示圆点。连线在 `buildBoardGraph` 里按两节点包围盒几何选择相对的两侧并显式写入 `sourceHandle`/`targetHandle`，节点移动后自动换边；source handle 必须常驻（不能只在选中时挂载），否则取消选中后非默认边的锚点会消失。
4. **连线样式**：原来 55% 透明度 1.5px 的细线在正常缩放下看起来像淡虚线。改为实线 `var(--muted-foreground)`、2px、0.85 不透明度，并加 `MarkerType.ArrowClosed` 箭头。

另外：`BoardCard` 新增 `notebookName` 快照。notebook id 是设备本地的，画布经 FNS 同步到另一台设备后 id 对不上；`absolutePathOf` 现在按「id → name → 唯一笔记本」依次解析，跨端卡片仍能找到笔记。

5. **移动端双击**：触摸事件在 `touch-action:none` 的画布里不会合成 `dblclick`，`onNodeDoubleClick` 在安卓上永远不触发。新增 `onNodeClick` 的触摸双击检测（同一节点 350ms 内两次 tap，`lastPointerTypeRef === 'touch'` 才启用），桌面仍走 `dblclick`，不会重复打开。桌面 CDP 触摸模拟验证：两次 touch 后画布卸载、笔记在主栏打开。
6. **跨端验证**：Android 模拟器（x86_64）安装后打开 `笔记卡片演示.flowix-canvas`，全文卡/片段卡渲染正确（callout 颜色+图标、任务列表、表格），连线为实线+箭头；真触摸选中卡片后单指滑动 `scrollTop 0→333`，卡片 transform 不变；三端一致。

7. **连线可删除**：此前只有 `onNodesDelete`，React Flow 的边删除没有落点。新增 `onEdgesDelete` + 显式边选中态（`onEdgeClick`/`onPaneClick` + `selectedEdgeId`，选中为品牌色 2.5px），工具栏出现「删除连线」按钮（移动端可点），Delete/Backspace 快捷键同样生效。选中边时节点选择被清空，避免一次删除两类元素。
8. **实时镜像缓存键**：`absolutePathOf` 之前返回混合斜杠路径（`D:\flowix/test/x.md`），而实时 buffer 用 `canonicalPath`（`D:/flowix/test/x.md`）写入 `contentHtmlRef`，两者键不一致——实时渲染写进去的内容卡片读不到，只有保存后的磁盘刷新看起来"更新"。修复：`absolutePathOf`/`cardContentKey` 一律 canonical，磁盘刷新遇到比文件 mtime 更新的实时 buffer 时优先用 buffer（防自动保存把卡面回退到旧内容）。

### 15.26 移动端卡片拖动（2026-10-30）

现象：第一次拖动正常，第二次拖不动。根因：触摸拖动会让节点进入选中态，而选中的笔记卡体是只读滚动区（`nodrag nowheel`），第二次从卡体起手就被滚动层吞掉；卡头只有 26px，缩放后很难点中。

修复：触摸拖拽结束时（`handleNodeDragStop` + `touchDraggingRef`）清空选中（节点选中/面板/`selectedIdsRef`），卡片回到"可拖动"状态。交互模型固定为：**未选中/刚拖完 = 可拖动；轻点选中 = 阅读模式，单指上下滚动；选中时拖标题栏仍可移动**。桌面鼠标拖拽不受影响（按 pointerType 门控）。

补充：React Flow 对**轻点**也会触发 `onNodeDragStart/Stop`，直接按 dragStop 取消选中会把"点选卡片阅读"一起打掉。改为在 dragStart 记录几何、dragStop 比较位移（>3 flow 单位才视为拖动）后再取消选中；轻点保持选中。验证：连续两次触摸拖动位置均变化且每次拖后 `selected=false`；轻点后 `selected=true`。
