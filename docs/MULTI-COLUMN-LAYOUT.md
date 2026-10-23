# 文章内容分栏（Columns，最多 5 栏）

状态：Phase 1–5 代码实现完成，手工验收待进行（`npm run tauri:dev`）。本文替代此前「多个文档面板并排」的方案——那个方向作废，本文只描述
**单篇文档内部的 Notion 式内容分栏**。

## 目标与边界

在同一篇 Markdown 文档内，把 block 并排成 2–5 列：

- 列宽可拖拽调整，总和始终等于页面内容宽度；**不产生横向滚动**，列内内容自动换行。
- 两种创建方式：块拖拽到目标块/列的左右边缘；块拖拽手柄的右键菜单「分栏」。
- 列内内容仍是普通 block（段落、标题、列表、代码块、表格、图片等），可继续编辑、继续拖拽。
- 列宽、列结构随文档保存到 `.md` 文件，重新打开后保持。

不在本次范围：

- 多个文档/多个 tab 并排（旧方案，作废）。
- 嵌套分栏（columns 内再放 columns）。解析到嵌套结构时拍平。
- 列内横向滚动、固定像素列宽、独立滚动区。
- 窄屏自动堆叠为单列（第一版保持并排；后续可加断点）。
- 从 Notion/网页粘贴 HTML 分栏结构时自动识别为 columns。

## 现状

- 编辑器为 Tiptap 3.23.4 + `@tiptap/markdown`。**存在两套扩展注册**，新增节点必须同步：
  - 交互编辑器：`markdown-editor-extensions.ts` → `createMarkdownEditorExtensions`
  - Worker / 后台解析：`markdown-parser-extensions.ts` → `createMarkdownParserExtensions`
- 块拖拽 `extensions/block-drag.ts`：
  - 支持单块与多块（`BlockDragState.ranges`）。
  - 落点是**一维**的：`findInsertPos` 按 `clientY` 找插入位，`side: 'before' | 'after'`，
    drop indicator 是水平线（`flowix-block-drop-indicator`）。
  - 列表有独立的嵌套/拆分/合并逻辑（list-structure、findSplitListTarget 等）。
- 多块选择 `extensions/block-selection.ts`：拖拽手柄上的 Mod-click / Shift-click 维护
  `ranges`，位置随 transaction 映射。
- 右键菜单 `components/drag-context-menu/`：`items.tsx` 是 data-driven 菜单项，
  `actions.ts` 负责分发；新增菜单项需要扩展 `BlockMenuItem` union。
- 自定义节点的 Markdown 先例：`MathBlock` / `WebCard` / `FlowixTable` 都实现了
  `parseMarkdown` / `renderMarkdown` / `markdownTokenizer`，columns 沿用同一套机制。
- 当前没有任何 columns 节点，也没有横向落点逻辑。

## 1. 数据模型

```ts
// features/editor/extensions/columns/
columns: Node
  group: 'block'
  content: 'column{2,5}'       // 2–5 列，schema 层强制上限
  isolating: true
  selectable: true
  draggable: false             // 容器本身不作为块被拖走
  attrs: { gap?: number }      // 预留；第一版固定 24px

column: Node
  content: 'block+'            // 非空，schema 保证
  isolating: true
  attrs: { width: number }     // 比例权重，默认 WIDTH_UNIT
```

### 列宽

- 使用**相对权重**而不是像素：`width` 存正整数（如 1–1000），渲染时
  `flexGrow: width / min(widths)`，配合 `flexBasis: 0`、`minWidth: 0`。
- 默认等分：每列 `width = WIDTH_UNIT`（定义 `WIDTH_UNIT = 100`，便于拖拽时整数化）。
- 拖拽只调整**相邻两列**的权重，两者之和保持不变，因此页面总宽不变、不会出现横向滚动。
- 拖拽步长按容器像素宽度换算：`deltaWeight = round(deltaPx / containerWidth * totalWeight)`；
  任一列权重下限 `MIN_COLUMN_WEIGHT = 25`（约等于 1/4 总宽，避免拖没）。
- 双击列分隔手柄恢复等分。

布局 CSS（`styles/editor.css`）：

```css
.flowix-columns {
  display: flex;
  align-items: flex-start;   /* 各列自然高度，不拉伸 */
  gap: 24px;
  min-width: 0;
}
.flowix-column {
  min-width: 0;              /* 关键：允许收缩 */
  flex-basis: 0;
  overflow-wrap: anywhere;   /* 长 URL / 长单词自动换行 */
}
```

列内不再嵌套滚动容器；内容超出高度时随页面纵向滚动。

### 约束

- 最多 5 列。`content: 'column{2,5}'` 让 ProseMirror 直接拒绝第 6 列。
- 禁止嵌套：`createColumns` / 拖拽落点在检测到祖先已有 `columns` 时拒绝；Markdown 解析到
  嵌套 fenced div 时拍平为同级列。
- 空列：schema 要求 `block+`，新建列时插入一个空 `paragraph`；用户删除列内最后一个 block
  时，编辑器自动补空段落（与 Notion 一致），不自动删除列。
- 删除列后若只剩 1 列：自动解散 `columns`，把剩余列内容提升到原位置。
- `columns` 不出现在 slash 菜单里；第一版只通过拖拽与右键菜单创建。

## 2. Markdown 持久化（核心）

标准 Markdown 没有分栏语法。采用 **fenced div**（Pandoc 风格），因为它同时满足：

- 列内内容仍是普通 Markdown（列表、代码块、表格都能正常 round-trip）；
- Git diff 稳定，外部编辑器可读；
- 不依赖 HTML block（CommonMark 规定 HTML block 内部不解析 Markdown，会导致内容退化成 HTML）。

格式：

```markdown
::: columns
:::: column width=100
第一列内容

- 列表项
::::

:::: column width=100
第二列内容
::::
:::
```

规则：

- `::: columns` 开启容器，闭合为 `:::`；`:::: column` 开启列，闭合为 `::::`。
  嵌套层数用冒号数量区分，外层较短、内层较长（与 Pandoc 一致）。
- `width=100` 可选，缺省为 `WIDTH_UNIT`；非法值回落到 100。
- 只有 `columns` / `column` 关键字被识别为容器；其他 `:::` 行按普通段落文本处理，
  避免误伤正文。
- fenced code block 内部的 `:::` 不参与识别。
- 未闭合的容器：从开启行到文档末尾按普通段落降级，不抛错。
- 嵌套 columns：解析时拍平——内层列被提升为外层 `columns` 的同级列，超过 5 列的部分
  按顺序降级为普通块（避免丢内容）。

实现：

- `markdownTokenizer`（block level，`start: ':::'`）线性扫描行，维护冒号栈；参考
  `markdown-list-tokenizer.ts` 的线性解析写法，禁止每次从文档头重新扫描。
- `parseMarkdown` 用 `helpers.parseChildren` 解析列内 tokens；列宽从 token attrs 读取。
- `renderMarkdown` 输出上述格式；列内内容用 `h.renderChildren`，闭合冒号数量按当前深度生成。
- 新扩展同时注册进 `createMarkdownEditorExtensions` 与 `createMarkdownParserExtensions`。
  只注册编辑器会导致 worker 解析丢结构（参见 `FlowixTable` 在 parser registry 的注释）。
- `serializeEditorMarkdown` 无需特殊处理，走节点的 `renderMarkdown`。

## 3. 渲染

- `columns` 用 NodeView 渲染 `div.flowix-columns`，`column` 渲染 `div.flowix-column`，
  内容用 `contentDOM`，不手写子内容。
- 列内 block 使用现有 renderer；列上下文通过 NodeView 的 DOM 类传递即可，不改文档属性的
  解析逻辑。
- 列分隔手柄：每列右侧 8px 命中区（`contenteditable=false`），拖动调整相邻两列权重；
  hover 时显示；双击恢复等分。
- 列悬浮控件（hover 时显示，`contenteditable=false`）：
  - 列右上角：删除列；
  - columns 容器右侧：添加列（未达 5 列时可用）。
- 空列显示 "拖入内容或输入 /" 占位（用现有 Placeholder 机制或 NodeView 内占位，不写入文档）。
- 打印 / 导出 HTML / PDF：保留 flex 布局；导出 Markdown 输出 fenced div。
- 窄容器：列始终并排，内容在列内换行；不出现横向滚动条。

## 4. 拖拽

### 4.1 二维落点

扩展现有 `BlockDropTarget`，新增列相关落点，而不是改写列表逻辑：

```ts
type BlockDropTarget =
  | { kind: 'vertical'; ...现有字段 }
  | { kind: 'new-column'; side: 'left' | 'right'; anchorPos: number; anchorColumnPos: number }
  | { kind: 'into-column'; columnPos: number; insertPos: number };
```

`getValidDropTarget` 的判定顺序：

1. 指针在编辑器外 48px 以上 → 空（沿用现有逻辑）。
2. 找到指针下最内层 block 的 DOM 矩形。
3. 若指针落在该 block 的**左/右边缘带**（宽度 `min(96px, 30% block 宽度)`）且当前未达
   5 列 → `new-column`（把拖拽块放进新列，原块留在当前列）。
4. 否则沿用现有 `findInsertPos` → `vertical`。若目标 block 位于 `column` 内，插入位置自然
   落在该列内容中。

边界行为：

- 拖到 columns 容器左右外侧 → 在首列左侧 / 末列右侧新建列。
- 拖到两列之间的 gap → 在相邻两列之间插入新列（未达 5 列时）。
- 已达 5 列：不显示新列指示器，边缘带退化为普通垂直落点。
- 拖出 columns 容器 48px 以外 → 按普通垂直落点移出分栏。
- 多块拖拽（`ranges.length > 1`）：全部进入同一个目标列/新列，保持文档顺序；不会“每块一列”。

### 4.2 指示器

现有 indicator 是水平线。`new-column` 时给目标 block/列加
`flowix-column-drop-left/right`（朝内 4px 的 `box-shadow` 竖线 + 目标块高亮），
不再渲染水平插入线。

### 4.3 跨列移动

- 源块在 A 列、目标在 B 列：从 A 删除、插入 B；若 A 变空保留空列（用户可手动删除）。
- 若移动后 `columns` 只剩 1 列：解散容器，内容提升。
- 列表跨列不合并：`list-structure` 的合并只在同一 `parentStart` 内生效（现有逻辑天然满足）。

### 4.4 与多块选择

- 沿用 `block-selection.ts` 的 ranges；拖拽开始前若目标块在选区内，整组移动。
- 一次拖拽的 ranges 必须来自同一父容器；跨容器时沿用现有 `needsRootDragContext` 提升到
  root 的规则，不做跨列多选批量移动（第一版）。

## 5. 右键菜单分栏

接入点：块拖拽手柄的菜单 / 编辑器内右键菜单（`drag-context-menu/`），扩展
`BlockMenuAction` 与 `useBlockMenuActions` 分发。分栏相关项单独成组「布局」。

菜单项（分组「布局」）：

| 菜单项 | 行为 | 禁用条件 |
| --- | --- | --- |
| 「在左侧插入分栏」 | 在当前块/列左侧新增空列，原内容留在原处；顶层块包装成两列 | 当前组已有 5 列 |
| 「在右侧插入分栏」 | 同上，右侧 | 当前组已有 5 列 |
| 「两列分栏」 | 当前块放进第一列，另建 1 个空列；后续块留在分栏下方 | 目标已在列内（不支持嵌套） |
| 「三列分栏」 | 同上，共 3 列 | 同上 |
| 「四列分栏」 | 同上，共 4 列 | 同上 |
| 「五列分栏」 | 同上，共 5 列 | 同上 |
| 「删除此列」 | 内容提升到 columns 之后的同级位置，再删除该列；若剩 1 列则解散 | 不在 column 内 |

「N 列分栏」只把当前块放进第一列，其余列保持空列；它不会把后续兄弟块搬进新列。

实现要求：

- 所有命令走单个 ProseMirror transaction，Cmd+Z 一次撤销。
- 创建 `columns` 时先保证每个 `column` 至少有一个 block（空列插入空 paragraph）。
- 若目标块在 list 内，先 lift 出 list 再进入列。
- 菜单文案进 `messages.zh-CN.ts / en-US.ts`。

## 6. 与现有系统的交互

| 系统 | 处理 |
| --- | --- |
| `resolveBlockContainer` | `column` 是普通父容器，返回其 `parentStart / parentTypeName`，现有逻辑可直接复用 |
| 列表移动/拆分/合并 | 只在同一列内生效；`parentStart` 不同即不合并，无需改 list 算法 |
| 粘贴 | 外部 `:::` 文本按 Markdown 解析；HTML columns 第一版按普通块粘贴 |
| 搜索 / 索引 | worker parser 注册新节点后，文本提取需递归进入 columns（确认现有搜索遍历是否已递归子节点，否则补） |
| 导出 | Markdown 走 `renderMarkdown`；HTML/PDF 保留 flex |
| 撤销/重做 | ProseMirror transaction 原生支持 |
| 滚动 | 列内不新增滚动容器；文档主体仍是唯一纵向滚动区 |

### CLI / MCP

CLI 通过 `flowix columns` 暴露同一套解析器：

```bash
flowix columns list <note> --json
flowix columns add <note> --columns 3 [--at <line>] --json
flowix columns remove <note> --block 1 --column 2 --json
flowix columns width <note> --block 1 --widths 50,150 --json
```

块/列索引均为 1-based；`--at` 是插入分栏前的行号，缺省追加到文末；删除一列后若只剩 1 列，自动解散分栏并提升内容。

MCP 的 `memo` 工具新增结构化 action：`columns.list`、`columns.add`、`columns.remove`、`columns.width`，对应参数为 `address`、`count`/`at`、`block`/`column`、`block`/`widths`。旧的 `command` 形式也可直接使用 `columns ...`。

### CLI / MCP：行背景色

行背景写在块末尾的 HTML 注释里（编辑器负责渲染）：

```markdown
这一行有淡黄色背景<!-- flowix:block-bg {"bg":"yellow"} -->
```

```bash
flowix background list <note> --json
flowix background set <note> --line 3 --color yellow --json
flowix background clear <note> --line 3 --json
```

`--line` 是 1-based 的 Markdown 行号，落在哪个文本块上就作用于整块（多行段落、标题、列表项、列内段落）；空行、围栏、表格行与 `:::` 结构行不可上色。可用颜色：`red orange yellow green cyan blue purple pink gray`。

MCP 对应 action：`background.list`（`address`）、`background.set`（`address`/`line`/`color`）、`background.clear`（`address`/`line`）。

## 7. 边界与风险

| 场景 | 行为 |
| --- | --- |
| 空列 | 保留，显示占位；用户手动删除 |
| 只剩 1 列 | 自动解散 columns，内容提升 |
| 达到 5 列 | 新建列入口禁用，拖拽不显示新列指示器 |
| 嵌套分栏 | 禁止创建；解析时拍平，超出 5 列的内容降级为普通块 |
| 长单词 / 长 URL | `min-width:0` + `overflow-wrap:anywhere`，列内换行，不横向滚动 |
| 窄窗口 | 列始终并排、内容换行；第一版不堆叠 |
| 拖拽到容器外 | 按普通垂直落点移出分栏 |
| 多块拖拽 | 全部进入同一目标列，保持顺序 |
| 外部 Markdown | 非 `columns`/`column` 的 `:::` 行按普通段落处理 |
| 未闭合 fenced div | 从开启行起降级为普通段落，不抛错 |

风险与缓解：

- **Markdown round-trip**：两套 registry 必须同步；必做 fixture 测试（2–5 列、列表、代码块、
  表格、未闭合、非法 width、嵌套拍平）。解析器要线性扫描，避免大文档卡顿。
- **拖拽落点冲突**：边缘带与垂直落点用明确阈值；顺序固定为先横向后纵向；覆盖 1–5 列单测。
- **列表逻辑回归**：`block-drag.ts` 的列表嵌套逻辑复杂，新增分支只在 `column` 上下文生效，
  不改现有 `findInsertPos` 与 list target 的默认路径。
- **空列合法性**：schema `block+`；所有创建列的命令统一走 `createEmptyColumn`，避免出现
  非法空列导致 transaction 失败。
- **性能**：columns 只是 flex 容器，无独立滚动/虚拟化；NodeView 避免每次 selection 变化
  重排整棵 columns。

## 8. 实施阶段

每个阶段可独立提交并通过 `npm test`。

1. **Schema + Markdown round-trip**：新增 `columns` / `column` 节点；fenced div tokenizer /
   renderer；两套 registry 注册；fixture 测试。此阶段不接 UI，先保证打开/保存不丢结构。
2. **渲染与列操作**：NodeView、flex 布局 CSS、列宽拖拽、添加/删除列、空列占位、解散规则、
   i18n；右键菜单先接「在右侧分栏」。
3. **右键菜单完整分栏**：2–5 列分栏、左右插入分栏、删除列、禁用条件。
4. **拖拽横向落点**：二维 drop target、竖向指示器、边缘阈值、5 栏限制、跨列移动、多块拖拽、
   拖出容器。
5. **适配与验收**：列表/多块/粘贴/导出/搜索回归；性能与手工验收。

## 9. 测试与验收

新增：

- `columns-markdown.test.ts`：2–5 列 round-trip；列表、代码块、表格、图片在列内；
  非法 width 回落；未闭合降级；嵌套拍平；`:::` 普通文本不误伤；fenced code 内的 `:::` 忽略。
- `columns-commands.test.ts`：创建/插入/删除/解散；5 栏上限；空列补段落；单次撤销。
- `columns-drag.test.ts`：左/右边缘新建列；两列间 gap；5 栏时无新列；跨列移动；多块整组；
  拖出容器；列表在列内的垂直移动。
- 回归：`block-drag.test.ts`、`block-selection.test.ts`、`markdown-parser*.test.ts`。

手工验收：

1. 拖拽单块到另一块右边缘 → 生成 2 列；继续拖 → 3、4、5 列；第 6 列被拒绝。
2. 右键菜单三种分栏方式；删除列；剩 1 列自动解散。
3. 列宽拖拽与双击等分；窗口缩放后列宽按比例收缩，无横向滚动。
4. 列内编辑列表、表格、代码块；跨列拖动；多块整体拖入列。
5. 保存 → 关闭 → 重开，结构与列宽保持；用外部编辑器查看 `.md` 仍可读。
6. 导出 Markdown / HTML / PDF。
7. 撤销/重做一次完成。
8. `npm run test`、`npm run check:layers`、`npm run check:frontend-debt`、`npm run build`。

## 10. 后续可选

- 窄屏断点自动堆叠为单列。
- 从 Notion/网页粘贴时识别 HTML columns。
- 列内嵌套分栏（限制深度 1）。
- 列宽预设（等分 / 1:2 / 2:1）。
- 拖拽时按列高亮整列、支持拖动列头调整列顺序。
