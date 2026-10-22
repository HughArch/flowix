# 多栏文档布局（最多 5 栏）

状态：待实施。本文是实施前的设计基线；实现完成后应回写「实施状态」并同步更新
`docs/WORKSPACE-SURFACE-ARCHITECTURE.md` 中关于 Browser host 的表述。

## 目标与边界

文档区支持最多 5 个并排的文档栏：主栏（`main-third`）计为第 1 栏，另可再开最多 4 个次要栏。
每栏独立显示内容，可有自己的 tab 列表；栏宽可拖拽，栏数／栏内 tab／宽度／焦点跨重启恢复。
笔记列表列与 Agent 面板不计入上限。

新增栏的入口：笔记卡片右键「在新栏打开」、把笔记拖到文档区某栏的左右边缘、文档标题栏
「拆分到右侧」、快捷键 `Mod+\`。

不在本次范围：

- 主栏不引入 tab 栏，仍是单一导航目标 + 历史前进/后退。
- 不改变 Agent 上下文取「主栏当前文档」的既有行为。
- 不做栏内上下分屏、浮动窗口、跨窗口拖栏。

## 现状

- 布局为单棵 flex 树：`features/shell/main-layout.tsx`。左列表 → 分隔条 →
  `data-document-columns-layout="split"` 容器内固定两块：主栏与可选 `BrowserColumn`。
- 宽度由纯函数 `features/shell/hooks/browser-column-layout.ts` 计算，用窗口宽度减去列表宽度后
  按 `splitRatio` 分割；只有 `features/workspace/store/browser-column-store.ts` 里的
  `splitRatio` 被持久化，列表宽度是组件内状态。
- `browser-column-store` 是单栏结构：`{ visible, splitRatio, tabs, activeTabId, webRuntimes }`，
  localStorage key `flowix-browser-column-storage`，`version: 5`。
- `WorkspaceSurfaceHost = 'main-third' | 'browser-column'` 同时承担「容器类型」与「实例身份」：
  焦点 store、编辑器模式、文档 capture、`SurfaceViewContext` 都以它作 key。
  `DocumentContainer` 依据 `focusedHostId !== hostId` 把非焦点栏设为只读。
- 已支持两个编辑器实例同时挂载：次要栏使用 `documentSessionMode: 'isolated'`，同文档共享
  buffer，capture 按 host 注册，只读由焦点决定，关闭/切换前有 flush barrier。
- 拖拽已有统一基础设施：`app/flowix-web/shared/drag-drop/drag-drop-coordinator.ts`，由
  `features/memo/public/drag-resource-api.ts` 定义笔记/文件/文件夹拖拽资源；文件树通过
  `use-notebook-tree-drag-controller.ts` 发起会话，表格通过 `registerDropTarget` 接收。

## 设计

### 1. 容器类型与实例身份分离

`WorkspaceSurfaceHost` 保持两值，只用于 surface registry 的能力判定（`workspaceSurfaceSupportsHost`）。
新增列实例身份：

```ts
// features/workspace/model/workspace-column.ts
export const PRIMARY_COLUMN_ID = 'main-third';
export const LEGACY_SECONDARY_COLUMN_ID = 'browser-column';
export const MAX_WORKSPACE_COLUMNS = 5;          // 含主栏
export const MAX_SECONDARY_COLUMNS = MAX_WORKSPACE_COLUMNS - 1;  // 派生，避免两处不同步
export const SECONDARY_COLUMN_MIN_WIDTH = 360;
export const SECONDARY_COLUMN_DEFAULT_WIDTH = 480;
export const SECONDARY_COLUMN_MAX_WIDTH = 1600;

export type SecondaryWorkspaceColumnId = 'browser-column' | `column:${string}`;
export type WorkspaceColumnId = 'main-third' | SecondaryWorkspaceColumnId;
```

`workspaceColumnSurfaceHost(columnId)` 把列映射回容器类型：主栏 → `main-third`，其余 →
`browser-column`。焦点、编辑器模式、文档 capture、`SurfaceViewContext.column` 一律使用列 id；
surface 能力判断仍用容器类型。首个次要栏沿用 `browser-column` 以原地迁移 v5 数据，后续栏 id 为
`column:<uuid>`。

实现约束：

- **`DocumentContainer` 的列 id 必须必传，不能沿用现有 fallback。** 当前
  `document-container.tsx` 用 `workspaceHost ?? (documentSessionMode === 'isolated' ? 'browser-column'
  : 'main-third')` 兜底；多栏下任何漏传都会让全部次栏塌缩到同一个 `'browser-column'`，导致
  editor mode / capture / flush 互串。Phase 1 起，次栏路径必须显式传 `workspaceColumnId`，
  旧 `workspaceHost` 只保留给主栏与过渡调用，并在 dev 环境对「isolated 且未传列 id」加断言。
- **lifecycle store 的两层 key 都要改。** `registerWorkspaceSurfaceLifecycle` 按 `viewId` 隔离
  （Browser 当前是 `tab:${tabId}`，已全局唯一，保持不变）；`registerWorkspaceSurfaceHostView` /
  `getWorkspaceHostSurfaceLifecycle` 的 `Map<WorkspaceSurfaceHost, …>` 是单槽，后注册覆盖先注册，
  必须改为按列 id。调用方（`browser-column.tsx` 与后续多栏渲染）一并改为传列 id。
- **列 id 命名易混**：`LEGACY_SECONDARY_COLUMN_ID` 与容器类型同名 `'browser-column'`。
  所有 `focusedColumnId === 'browser-column'` 形式的比较都要逐个 review，确认比较的是列而不是容器。
- **`SurfaceViewContext` 的 `host` 与 `column` 分工**：`host` 保留给能力判定与既有 renderer 分支，
  `column` 用于实例隔离。renderer 里凡是拿 `host` 判断 readOnly、生命周期归属或 presentation
  隔离的地方，都要改用 `column`；仅用 `host` 决定「支持哪些能力」的地方保持不动。

### 2. tab id 全局唯一

跨栏插入已存在的 tab id 时追加 `:${uuid}`。这样 `commitTab / closeTab / updateFileBrowserContext /
webRuntimes` 等所有按 tabId 的 action、lifecycle 注册与 flush 注册都无需复合 key；需要列信息时
用 `findColumnIdForTab(tabId)` 反查。公开结果类型 `WorkspaceContentLocation`、
`BrowserColumnNavigationResult` 保持 `{ host, tabId }` 不变。

**去重范围必须同步收窄到目标栏。** 现有链路有两处是全局查重的，多栏下会劫持“在指定栏打开”：

- `openBrowserColumnTarget` 在 `disposition !== 'replace-active'` 时先做全局
  `findWorkspaceContentLocations(...)` 并 `commitTab`（`browser-column-navigation.ts:93`）。带
  `columnId` 时，existing 查询必须限定在该栏；未带 `columnId` 时保持全局查找，并按
  「聚焦次栏 → activeColumnId → 第一栏」选落点。
- `openTab` / `openTabInColumn` 的 existing 查询目前遍历 `state.tabs`（`browser-column-store.ts:469`），
  改为只遍历目标栏的 `tabs`。
- `findWorkspaceContentLocations`（`workspace-content-activation.ts:123`）返回单个 `browserColumn`。
  同一 identity 现在可以同时存在于多栏，必须定义返回优先级：聚焦次栏 → activeColumnId → 第一栏，
  并让 `activateExistingWorkspaceContent(Async)` 复用同一规则。这是 Phase 2/4 的必要改动，
  不属于机械适配。

### 3. 列状态

`browser-column-store` 泛化为次要栏集合（文件名沿用，Phase 6 再重命名）：

```ts
interface BrowserColumnState {
  columns: {
    id: SecondaryWorkspaceColumnId;
    width: number;                 // 持久化像素宽度
    tabs: BrowserColumnTab[];
    activeTabId: string | null;
  }[];
  activeColumnId: SecondaryWorkspaceColumnId | null;
  webRuntimes: Record<string, BrowserColumnWebRuntime>;  // tabId → runtime，永不持久化

  createColumn(options?: { afterColumnId?: WorkspaceColumnId; width?: number }): SecondaryWorkspaceColumnId | null;
  closeColumn(columnId: SecondaryWorkspaceColumnId): SecondaryWorkspaceColumnId | null;
  setColumnWidth(columnId: SecondaryWorkspaceColumnId, width: number): void;
  openTabInColumn(columnId: SecondaryWorkspaceColumnId, tab: BrowserColumnTab, disposition?): string | null;
  openTab(tab: BrowserColumnTab, disposition?): string;  // 兼容：聚焦/最后一栏，无栏则建 browser-column
}
```

不变量：`columns.length <= MAX_SECONDARY_COLUMNS`；tab id 全局唯一；同一 target 只在单栏内去重，
因此同一笔记可以同时出现在两栏。关闭栏内最后一个 tab 时移除该栏，焦点回落 `右邻 → 左邻 → 主栏`。

**空栏是瞬时态。** `createColumn` 先建空栏、再由 use-case 填入内容；开栏失败时回收空栏。空栏
不写回持久化（`partialize` 过滤 `tabs.length === 0` 的栏），刷新后自然消失——否则会与迁移规则
「丢弃空栏」产生不一致。

**默认落点。** `openTab(tab, disposition)` 的目标栏按「聚焦的次要栏 → `activeColumnId` →
最后一栏 → 新建 `browser-column`」选择；焦点在主栏时不会凭空新建栏。store 层返回
`tabId | null`（`null` = 未写入，例如栏不存在或已达上限）；失败原因由 use-case 在预检阶段判定，
用协议层的 `column-limit` / `unsupported-surface` / `navigation-cancelled` 表达，不要让调用方
从 `null` 猜原因。

**焦点归属由 use-case 决定，不由 store 直接改。** 现有 store 在 `setVisible / openTab / closeTab`
里直接调 `focusHost`，多栏下会让 store 需要知道「右邻左邻」和主栏回退，测试也会被焦点副作用污染。
建议 `closeColumn` 只返回「下一个应聚焦的列」（`SecondaryWorkspaceColumnId | null`，`null` = 主栏），
由 `closeWorkspaceColumn` use-case 统一写 `focusedColumnId`。

关闭栏的语义是「关闭该栏及其 tab」（先过 flush barrier，有未保存改动走既有确认）。现状
`hideBrowserColumn` 是「隐藏但保留 tab」；多栏下隐藏栏会让栏数与上限语义混乱，这是一次有意的
行为变更，需在更新日志注明。受影响入口有两处：`work-column-titlebar-shell.tsx` 的右键「关闭此列」
与 `browser-column.tsx` 的 `onCloseColumn`。

### 4. 宽度

宽度以像素持久化（默认 480，最小 360，最大 1600）。渲染宽度由纯函数按视口计算：

```ts
// features/shell/hooks/workspace-columns-layout.ts
resolveWorkspaceColumnsLayout({
  viewportWidth, noteNavigationWidth, memoListWidth, memoListVisible, dividerCount, secondaryColumns,
}) // → { primaryWidth, secondaryColumns: { id, width, persistedWidth, clamped }[], contentWidth, overflow }
```

`dividerCount` 由调用方计算：`(memoListVisible ? 1 : 0) + secondaryColumns.length`（列表分隔条
各 1px，每栏之间 1px）。`noteNavigationWidth` 当前恒为 0，保留参数以对齐 `useResizablePanels`。

算法按固定顺序执行，避免「主栏吸收」与「次栏压缩」互相矛盾：

```text
1. available = max(0, viewportWidth − noteNavigationWidth − memoListWidth − dividerCount)
2. preferred[i] = clamp(persistedWidth[i], 360, 1600)
3. 如果 available − Σpreferred ≥ 360
     → 主栏 = available − Σpreferred（吸收全部剩余），次要栏 = preferred，overflow = false
4. 否则（可用宽度不足以让主栏保持 360）
     → 把 available − 360 按 preferred 比例分给次要栏，每栏 clamp 到 ≥ 360
     → 主栏 = available − Σwidth
5. 如果主栏 < 360（即每栏都到 360 仍放不下）
     → 主栏 = 360，次要栏 = 各自的 360，overflow = true，容器横向滚动
```

即：**放大时主栏先吸收剩余宽度，缩小时先压缩次要栏、主栏最后才动**，与「边界与风险」表一致。
拖拽写 `persistedWidth`；窗口缩放只影响渲染宽度，不回写持久化值。`clamped` 标记该栏渲染宽是否
低于其持久化值，供 UI（例如宽度指示器）区分。

旧实现有 `canSplit = availableDocumentWidth >= 720`，放不下时拒绝分栏。新算法取消该门槛：
宽度不足时允许开栏并横向滚动，因此分栏入口不再按宽度禁用，只按栏数上限禁用。这是一次行为
变化，需在更新日志一并注明。

布局形态：主栏 `flex: 0 0 ${primaryWidth}px` + `minWidth: 360px`，次要栏固定像素宽；每栏
`min-w-0`，容器保持 `overflow-x-auto`。每栏新增 `data-workspace-column-id` 供焦点、拖放与测试定位。

### 5. 协调器

`browser-column-coordinator.ts` 的单槽 `activeFlushRegistration` 改为 `Map<tabId, registration>`；
`flushBrowserColumnTab(tabId)` / `flushColumnActiveDocument(columnId)` / `enqueueBrowserColumnNavigation(op, { columnId })`
在关闭、切换、替换前只 flush 目标栏。保留单一 `navigationChain` 串行化所有列的可替换操作。

`activateBrowserColumnTab` / `closeBrowserColumnTab` 等按 tabId 工作的入口用 `findColumnIdForTab`
反查列；`flushActiveBrowserColumnDocument` 不能再读全局 `activeTabId`，调用方必须显式给出列 id。
`registerBrowserColumnDocumentFlush` 的注销逻辑同步改为按 `Map.delete(tabId)`，不要保留「当前单槽
是否同一 tabId」的旧判断。

### 6. 打开协议

`openWorkspaceSurface` 的 Browser 分支增加：

```ts
options: {
  browserDisposition?: BrowserSurfaceOpenDisposition;
  columnId?: SecondaryWorkspaceColumnId;       // 指定目标栏
  placement?: 'column' | 'new-column';         // 复用目标栏或新建一栏
  afterColumnId?: WorkspaceColumnId;           // 新栏插入锚点
}
```

**`placement` 取代而不是叠加 `'open-in-column'`。** 现有 `BrowserSurfaceOpenDisposition` 已有
`'open-in-column'`（7 处调用），但在 Browser host 内部它与 `'focus-existing'` 行为完全一致：
`openBrowserColumnTarget` 只排除 `replace-active` 做 existing 复用（`browser-column-navigation.ts:93`），
`openTab` 也只特判 `replace-active`。它表达的是「目标在 Browser 而不是 Work」，不是「新建一栏」。
Phase 4 应把它标为 deprecated 别名（内部映射到 `focus-existing`），新代码只用 `columnId` /
`placement`；不要为它补一套「新栏」语义，否则会出现三套并存的表达。

取消原因扩展 `'column-limit' | 'unsupported-surface'`。不传 `columnId` 时使用聚焦的次要栏，
没有则创建第一栏，保持现有「在右栏打开」行为。开栏前用
`workspaceSurfaceSupportsHost(kind, 'browser-column')` 预检，失败不建栏并提示。

新增 `features/workspace/use-cases/workspace-columns.ts`：

```ts
openInNewWorkspaceColumn(target: BrowserColumnTarget, afterColumnId?: WorkspaceColumnId)
  : Promise<OpenWorkspaceColumnResult>;
splitFocusedColumnToRight(): Promise<OpenWorkspaceColumnResult>;
closeWorkspaceColumn(columnId: SecondaryWorkspaceColumnId, options?: { discardChanges?: boolean })
  : Promise<boolean | null>;

type OpenWorkspaceColumnResult =
  | { status: 'opened'; columnId: SecondaryWorkspaceColumnId; tabId: string }
  | { status: 'cancelled'; reason: 'column-limit' | 'unsupported-surface' | 'navigation-cancelled' };
```

`target` 统一为 `BrowserColumnTarget`。`splitFocusedColumnToRight` 内部按焦点取 target：焦点在
次栏时直接取该栏 `activeTab.target`；焦点在主栏时复用现有 `WorkColumnTarget → BrowserColumnTarget`
转换（`openWorkColumnTargetInBrowserColumn` 已有该逻辑），并对 `plugin-workbench` 等仅 Work 支持的
目标返回 `unsupported-surface`。开栏失败时仅在新建栏仍为空的情况下回收。

### 7. 拖拽

复用现有 coordinator，不新增 MIME 或 HTML5 dataTransfer：

- 笔记卡片作为拖拽源，沿用 `NotebookNoteDragResource`，通过 `beginDragSession / moveDragSession /
  endDragSession` 发起会话（参考 `use-notebook-tree-drag-controller.ts`）。
- 文档栏注册一个 `registerDropTarget`：`hitTest` 返回 `{ columnId, edge: 'left' | 'center' | 'right' }`
  （边缘阈值 `min(96px, 20% 栏宽)`），`evaluate` 只接受能在 Browser host 打开的笔记/文件资源，
  `onPreview` 渲染插入线或整栏高亮，`onDrop` 调 `openInNewWorkspaceColumn`（边缘）或在**该栏内**
  打开并激活（中心）。
- 中心语义是「打开/激活到该栏」，不是「替换该栏当前 active tab」（后者仍是 `replace-active`
  disposition，只由显式命令使用）。因此中心 drop 必须调用带 `columnId` 的打开路径，走**栏内**
  去重，不能经过 `openBrowserColumnTarget` 的全局 existing 查询，否则目标内容已在另一栏时会被
  跳走。入口表里的「中心替换该栏内容」统一改为「中心在该栏打开」。
- OS 文件拖拽继续走 `use-external-file-drop`，按 `data-workspace-column-id` 路由到具体栏。

### 8. 入口

| 入口 | 位置 | 行为 |
| --- | --- | --- |
| 笔记卡片右键 | 复用 `memo.action.openInSplit` 菜单项与 `handleOpenMemoWindow` | 改为调用 `openInNewWorkspaceColumn` |
| 文档标题栏 | `work-column-titlebar-shell.tsx` 的右键菜单 | 新增「拆分到右侧」，禁用条件：目标为空、`plugin-workbench`、已达 5 栏 |
| 次要栏头部 | `browser-column-header.tsx` | 新增「拆分到右侧」；「关闭当前栏」改为异步关闭命令 |
| 快捷键 | `features/shortcuts/actions.ts` | `workspace.column.splitRight`，`Mod+\`，scope `window` |
| 拖拽 | 文档栏 drop target | 边缘插入新栏，中心在该栏打开 |

**与现有「在右栏打开」入口去重。** `work-column-titlebar-shell.tsx:54` 的
`workColumn.context.alsoOpenInBrowserColumn` 走 `openWorkColumnTargetInBrowserColumn`，效果就是
把主栏当前内容在次栏再开一份，多栏后与「拆分到右侧」几乎同义。两者保留一个：
推荐把该菜单项改为「在新建栏打开」（调用 `openInNewWorkspaceColumn`），删除独立的新菜单项，
或保留两项但明确区分「打开到最近次栏」与「新建一栏」。不要同时提供两个默认行为相同的入口。

`Mod+1..4` / `Mod+0` 已被 editor scope 的标题快捷键占用，但它们只在编辑器聚焦时生效，
`workspace.column.splitRight` 的 `window` scope 不冲突；需要在实现时跑一遍 registry 的 scope
优先级测试。

**Windows 控件预留**：`main-layout.tsx` 现在用 `reserveWindowsControls: !browserColumnVisible`，
多栏下语义失效。改为「主栏右侧不存在任何文档栏」时保留控件区，否则由最右一栏负责。

上限提示：达到 5 栏时入口禁用，并 toast「最多只能打开 5 个文档栏」；协议侧返回
`cancelled / column-limit`，不静默失败。

## 持久化迁移（v5 → v6）

沿用 key `flowix-browser-column-storage`，`version: 6`，只持久化
`{ columns, activeColumnId, focusedColumnId }`。`focusedColumnId` 是实际焦点（可能是主栏
`main-third`），与「最后活跃次栏」`activeColumnId` 语义不同——恢复默认落点时读后者，恢复焦点
时读前者。两者都不存在或指向已消失的栏时回落主栏。

`merge`：

1. 有 `columns` 数组：最多保留 `MAX_SECONDARY_COLUMNS` 栏；id 合法且不重复（`browser-column` 或
   `/^column:[0-9a-f-]{36}$/`）；宽度 clamp 到 `[360, 1600]`（缺省 480）；
   tab id 全局去重（冲突追加 `:uuid`）；单栏内按 `browserColumnTargetKey` 去重；丢弃空栏；
   `activeColumnId` 不合法则取最后一栏；`focusedColumnId` 不合法或指向被丢弃的栏则取
   `main-third`。
2. 旧 v5（`visible / splitRatio / tabs / activeTabId`）：有 tab 则迁移为单栏
   `{ id: 'browser-column', width: clamp(round(ratio * 960)), tabs, activeTabId }`；无 tab 则
   `columns: []`，`focusedColumnId` 取 `main-third`。**tab 始终保留**，`visible: false` 只影响
   迁移后的可见性（迁移后可见，一次性行为变化），不能据此丢弃 tab。
   `960` 是 v5 比例的参考可用宽度（默认 480 / 0.5），仅用于把比例换算成初始像素；ratio 0.3
   会得到 288 → clamp 到 360。
3. `webRuntimes` 始终重置为空，web 运行时从 tab URL 重建。
4. 空栏不写回持久化：`partialize` 过滤 `tabs.length === 0` 的栏，与迁移规则保持一致。
5. 旧常量 `BROWSER_COLUMN_MIN_WIDTH` / `BROWSER_COLUMN_DEFAULT_SPLIT_RATIO` 保留为 deprecated 别名。

**迁移不可逆。** v6 写入后，旧版本代码读不到 `columns`，降级会丢失栏布局。Phase 2 一旦随公开
版本发布，就不要再用「回滚到旧版本」作为兜底；开发期需要回滚时手动清理该 localStorage key。
`migrate` 本身保持 identity，清洗与 v5 兼容都放在 `merge`（与现有实现一致）。

## 实施阶段

每个阶段独立可提交并通过 `npm test`。阶段 1–3 不暴露新入口，UI 行为保持等价，可增量合入：
但 Phase 2 起持久化结构已变为 v6 且不可逆，合入公开版本前要确认发布节奏（见「持久化迁移」）。

1. **身份拆分（行为不变）**：新增 `workspace-column.ts`；`SurfaceViewContext` 增加 `column`；
   焦点 store 改为 `focusedColumnId / focusColumn`；`DocumentContainer` 增加必传的
   `workspaceColumnId` 并用于焦点、编辑器模式、capture（dev 断言拦住漏传的 isolated 会话）；
   `registerWorkspaceSurfaceHostView` / `getWorkspaceHostSurfaceLifecycle` 的 host 单槽改为按列 id。
2. **store 泛化 + v6 迁移**：重写 `browser-column-store.ts`（含 `focusedColumnId` 持久化与空栏
   `partialize` 过滤）；`browser-column-api.ts` 按栏取视图；`workspace-content-activation.ts`
   的 `findWorkspaceContentLocations` 与 `activateExistingWorkspaceContent(Async)` 改为
   「聚焦次栏 → activeColumnId → 第一栏」优先级；`shell-api.ts` 暴露
   `secondaryColumns / activeColumnId / setColumnWidth / focusedColumnId`。
3. **布局与渲染**：新增 `workspace-columns-layout.ts`（纯函数 + 单测）；`main-layout.tsx` 映射多栏
   并修正 Windows 控件预留；`browser-column.tsx` 接收 `columnId`；coordinator 改为按 tab 的 Map。
4. **打开流程**：`openBrowserColumnTarget(target, disposition, columnId?)`，有 `columnId` 时
   existing 查询收窄到该栏；`openTab` / `openTabInColumn` 的 existing 查询同样收窄；
   `openWorkspaceSurface` 的 `columnId / placement / afterColumnId`；`'open-in-column'` 标为
   deprecated 并映射到 `focus-existing`；新增 `workspace-columns.ts` 三条命令。
5. **入口与文案**：标题栏、次要栏头部、右键菜单、快捷键；与 `openInBrowserColumn` 入口去重；
   `messages.zh-CN.ts / en-US.ts`。
6. **拖拽**：笔记卡片拖拽源 + 文档栏 drop target；中心落点走栏内打开；OS 文件拖拽按栏路由。
7. **命名清理（可选，最后做）**：`browser-column-store.ts → document-columns-store.ts`、
   `useBrowserColumnStore → useDocumentColumnsStore`、`browser-column.tsx → document-column.tsx`。

## 边界与风险

| 场景 | 行为 |
| --- | --- |
| 同一文档出现在两栏 | 共享 buffer，仅聚焦栏可编辑；单栏内重复 tab 仍只读（`activePathHasDuplicateTab` 语义不变） |
| 主栏 + 次要栏同一文档 | 沿用 `isolated` session，capture 按列 id 隔离；打开前仍走 `prepareActiveWorkColumnDocumentLeave` flush 共享 buffer |
| 不支持的 surface | 开栏前预检（`mindmap` / `plugin-artifact` / `plugin-workbench` / `file-browser` 限制沿用），失败提示且不建栏 |
| 视口过窄 | 每栏下限 360，容器横向滚动，不自动关栏 |
| 窗口缩放 | 放大时主栏先吸收剩余宽度；缩小时先按比例压缩次要栏（下限 360），主栏最后才动；持久化宽度不变 |
| 关闭栏 | 先 flush 目标栏；失败则不关；成功后焦点回落右邻 → 左邻 → 主栏 |
| 开栏失败 | 仅在新建栏仍为空时回收 |
| 空栏重启 | 空栏是瞬时态，不写回持久化，刷新后消失 |
| 焦点恢复 | 持久化 `focusedColumnId`；目标列已不存在时回落主栏，不强制聚焦 `activeColumnId` |
| 上限竞态 | `createColumn` 在同一 `set` 内检查并写入 |
| 弹窗单例 | slash / suggestion / link 弹窗仍是全局单例，不同栏切换编辑时会关闭旧弹窗，可接受 |
| frontmatter 属性事件 | `flowix:add-property` 为 window 全局、仅按 `propertyTargetId` 过滤；同一文档双栏时两栏都会响应，需补充 `view.hasFocus()` 或列 id 过滤 |

风险与缓解：

- **容器类型与实例身份混用**：`host` 只用于能力判定，焦点/模式/capture 只用 `column`；逐个 review
  `focusedColumnId === 'browser-column'` 形式的比较。
- **runtime 冲突**：tab id 全局唯一由 `openTabInColumn` 单点保证，并加开发期断言。
- **关栏丢内容**：flush 按 tabId 精确定位，只 flush 目标栏；保留 discard 确认。
- **迁移丢数据**：清洗而非抛错；`merge` 在内存中完成转换，首次 `set` 才用 v6 覆盖同一 key。
  写回后旧结构不可恢复，因此迁移单测要覆盖 v5 fixture，且 Phase 2 不在开发期之外依赖版本回滚。
- **5 栏性能**：最多 5 个 Tiptap / CodeMirror / WebView 实例同时挂载，现有实现只验证过 2 个。
  每栏只挂载 active tab，但这仍是新的资源上限；验收时补一条 5 个大 Markdown 文档的内存与
  首帧基线，必要时对非聚焦栏延迟挂载（idle 后再挂）或降低渲染优先级。
- **层边界**：列 id/常量放 `features/workspace/model`，布局解析放 `features/shell/hooks`；
  跑 `npm run check:layers`。注意 `features/workspace/*` 不得直接 import `@features/shell/*`
  的非 public 路径（`check-layer-boundaries.mjs` Rule C）。

## 测试与验收

新增：

- `workspace-columns-layout.test.ts`：1/2/5 栏、最小宽、比例压缩、溢出、隐藏列表、放大恢复；
  明确覆盖「放大时主栏吸收、缩小时次栏先压缩」两个方向。
- store 迁移测试：v5 fixture → 单栏像素宽（含 ratio 0.3 被 clamp 到 360）；`visible: false` 的 tab
  保留；v6 5 栏 → 截断为 4；非法列 id 被丢弃；重复 tab id 加后缀；`webRuntimes` 重置；
  空栏不写回持久化；`focusedColumnId` 指向消失栏时回落主栏。
- `workspace-columns.test.ts`：主栏拆分、次栏拆分、上限、不支持的 surface、失败回收空栏、
  关闭与焦点回落；断言 `cancelled` 的具体 `reason`，而不只是 `null`。
- 栏内去重测试：同一 target 已在另一栏时，`openTabInColumn` / 中心 drop 仍在目标栏新建并激活，
  不会被全局 existing 查询跳到另一栏。
- `workspace-content-activation.test.ts` 新增（不属于机械适配）：同一 identity 存在于多栏时，
  按「聚焦次栏 → activeColumnId → 第一栏」选择；焦点在主栏时不聚焦次栏。
- 拖放 target 的 `hitTest / evaluate / onDrop` 单测（复用 coordinator 测试写法）。

手动性能基线：5 栏各打开一个较大 Markdown 文档，记录内存占用与切换首帧；与现有 2 栏基线对比。

需机械适配：`browser-column-store.test.ts`、`browser-column-coordinator.test.ts`、
`browser-column-navigation.test.ts`、`browser-column-collections.test.ts`、`surface-opening.test.ts`、
`workspace-host-focus.test.tsx`、`workspace-content-activation.test.ts`（除新增用例外）、
`browser-column.editing.test.tsx`、`browser-column-header.test.tsx`、`document-editor-view-store.test.ts`、
`browser-column-registry.test.ts`、`use-external-file-drop.test.ts`、
`main-window-notebook-events.rename.integration.test.ts` 等。

命令与手工验收：

1. `npm run test`
2. `npm run check:layers`、`npm run check:frontend-debt`、`npm run check:web-bundle`
3. `npm run build`
4. `npm run tauri:dev`：五种开栏方式；上限提示；拖宽、关闭栏、焦点回落；两栏打开同一笔记的编辑权限；
   重启后栏数/tabs/宽度/焦点恢复（含焦点在主栏 vs 次栏两种）；空栏状态下重启后消失；
   旧 v5 数据迁移；隐藏列表与窗口缩放；Windows 下最右一栏的标题栏控件预留；
   原有 `open-in-column` 调用点（文件树、外部拖放、表格、Agent 卡片）行为不回归。

## 文档同步

实现完成时需同步：

- 本文「状态」改为已实施，并回写与实现不一致的细节。
- `docs/WORKSPACE-SURFACE-ARCHITECTURE.md`：Browser 由单 host 实例改为「Browser 类型的多个文档栏」，
  说明 host 只决定能力、列 id 决定实例；README/更新日志注明关闭栏语义变化。
