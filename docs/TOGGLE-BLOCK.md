# 折叠块（Toggle）

> 状态：已实现（编辑器 + Markdown 往返 + Slash 菜单 + CLI / MCP）。

## 目标与边界

参考 Flowus 的折叠块：首行是标题，点击左侧箭头收起 / 展开下方缩进的内容区，收起状态随笔记持久化。

范围内：

- `/` 命令菜单插入「折叠块」。
- 首行作为标题；按 Enter 生成正文首块。
- 点击箭头收起 / 展开，状态写入 Markdown。
- 空标题显示「折叠列表」占位；空容器点击箭头会创建正文首块。
- 容器整体支持行背景色（拖拽手柄菜单的背景色，与段落共用 9 色）。
- 容器内可放任意块：段落、列表、引用、代码块、分栏、着重块、嵌套折叠块。
- 标题行首按 Backspace 解包容器（内容保留）。
- 折叠状态下光标被移入隐藏区域时自动展开。

不在范围：

- Word / HTML 导出识别 `:::`（与着重块、分栏现状一致）。
- 把外部块直接拖进折叠块正文（与着重块现状一致）。
- 临时展开（不写文档属性）模式；自动展开会持久化为展开状态。

## 数据模型

```ts
toggle: {
  group: 'block',
  content: 'block+',   // 至少一个块；第一个子块是标题行
  isolating: true,     // 选区不跨容器边界
  selectable: false,
  draggable: false,
  attrs: {
    open: true,        // false = 收起
  },
}
```

- 标题行约定：只有在「光标位于容器的**直接第一个子块**且该子块是 textblock」时，Backspace 才按标题语义解包。
- `setToggle` 只把段落 / 标题放到标题槽；列表、表格、分栏等着重块会成为正文，并在前面补一个空标题段落。
- 光标已经在某个折叠块的标题行时，再次执行 `setToggle` 会被拒绝，避免把容器嵌进自己的标题。

## Markdown 持久化

```markdown
::: toggle

标题行

正文第一段

- 正文列表

:::
```

收起状态：

```markdown
::: toggle collapsed bg="yellow"

标题行

正文

:::
```

规则：

- 复用 `fenced-div.ts` 的围栏长度栈：关闭行冒号数 ≥ 打开行冒号数才关闭；``` / ~~~ 代码围栏内的 `:::` 不参与匹配。
- `collapsed` 标记顺序不敏感，未知标记忽略；展开状态不写任何标记。
- `bg="yellow"` 表示容器整体背景色，取值与行背景色相同（9 色）；非法值忽略。
- 标题与正文之间始终有空行。`breaks: true` 下缺空行会把两段合并成一段。
- 空标题在还有正文时输出 `&nbsp;` 占位；空标题且无正文时输出短形式 `::: toggle` + `:::`。
- 正文首块是列表 / 表格 / 代码块时，解析端补一个空标题，避免正文首块被错误提升为标题。
- 围栏未闭合时 `scanToggle` 返回 null，整段交回普通段落解析，不丢内容。

### 两套 registry 必须同步

| Registry | 文件 | 注册的节点 |
|---|---|---|
| 编辑器 | `features/editor/markdown-editor-extensions.ts` | `ToggleEditorNode`（NodeView / 键盘 / 插件） |
| Worker 解析 | `features/editor/markdown-parser-extensions.ts` | `ToggleNode`（纯节点 + markdown spec） |

`toggle.ts` / `toggle-markdown.ts` 不得 import NodeView、React 或 store。

## 交互

### 折叠与展开

- 箭头点击：`setNodeMarkup(pos, { open: !open })`，事务带 `addToHistory: false`，折叠本身不占用一次撤销。
- 收起时若光标在正文内，先移到标题内容末尾；同时清空多块选择，避免用户按 Delete 删除看不见的块。
- 隐藏方式：`toggle-editor.ts` 给收起容器的第 2..n 个子块加 `is-toggle-collapsed-content` 装饰；CSS 规则位于 `@media screen` 下，打印 / PDF 自动恢复全部内容。
- 光标进入隐藏区域（键盘导航、`setTextSelection`、Undo 后的 selection、搜索结果跳转）时，`appendTransaction` 自动把容器改为展开；`AllSelection`（Ctrl+A）与只读模式不会触发，避免一次全选改写整篇笔记。
- 只有标题、没有正文的容器箭头仍然可见；点击它会创建正文首块并把光标放进去（Flowus 空折叠块的行为）。

### 编辑

- Enter 在标题末尾：在容器内生成正文首块（与 Flowus / Notion 一致）。
- Enter 在标题中间：右半部分成为正文首块。
- Backspace 在标题行首：解包容器，子块保留。
- 正文第一块、列表项、引用、分栏内部的行首不触发解包。
- Slash 插入时会先清空 `/query`，新容器只有一个空标题。

### 拖拽与块菜单

| 悬停位置 | 抓手目标 |
|---|---|
| 箭头 | 整个折叠块 |
| 标题行 | 整个折叠块 |
| 正文行 | 该内部块 |
| 正文左侧缩进 / 内边距 | 按 Y 坐标映射到正文行（跳过已收起的行） |

- 容器菜单保留「删除」「背景色」与分栏动作（着重块没有背景色，因为自带底色）。
- 背景色通过 `flowixBg` 属性作用在 **toggle 节点本身**：拖拽手柄菜单会把整个容器上色，内部行不再单独换色；伪元素绘制整块背景，与段落行背景使用同一套 `--flowix-block-bg-*` 变量。
- 删除容器会连同收起的正文一起删除。
- `block-drag` 的 `fillEmptyContainers()` 兜底零子节点的 `toggle`。

## 已知边界

| 场景 | 处理 |
|---|---|
| 正文出现单独的 `:::` 行 | 会被当作关闭围栏（与 callout / columns 相同），建议用代码块包裹 |
| 折叠块跨容器拖入 / 拖出 | 不支持；容器内重排可用 |
| HTML / Word 导出 | `lib/export.ts` 不识别 fenced div，会输出字面量（与 callout / columns 相同） |
| 搜索替换命中收起正文 | 匹配不可见；调用 `revealToggleAtPos` / `revealToggleAtDomElement` 可先展开（目前尚未接入搜索流程） |
| 只读模式 | 箭头隐藏，文档保持原状 |

## CLI / MCP

### CLI

```bash
flowix toggle list <id> --json
flowix toggle add <id> [--at <line>] [--title <markdown>] \
  [--content <text> | --file <utf8.md> | --stdin] \
  [--collapsed] [--bg <color>] --json
flowix toggle set <id> --block <n> [--title <markdown>] \
  [--content <text> | --file <utf8.md> | --stdin] \
  [--open | --collapsed] [--bg <color> | --clear-bg] --json
flowix toggle remove <id> --block <n> [--delete-content] --json
```

- `add` 默认展开（`--collapsed` 收起），不传内容时创建空折叠块。
- `set` 至少提供 `--title` / `--content` / `--file` / `--stdin` / `--open` / `--collapsed` / `--bg` / `--clear-bg` 之一。
- `remove` 默认保留标题与正文（解包）；`--delete-content` 才连同内容删除。
- 背景色：`red / orange / yellow / green / cyan / blue / purple / pink / gray`。
- 列表输出每个块的 `start_line`、`end_line`、`open`、`bg`、`title`、`body`、`content`。

### MCP

`memo` 工具的 structured actions：

| action | 参数 |
|---|---|
| `toggle.list` | `address` |
| `toggle.add` | `address`, `title?`, `content?`（正文）, `open?`（默认 true）, `bg?`, `at?` |
| `toggle.set` | `address`, `block`, `title?`, `content?`, `open?`, `bg?`, `clearBg?` |
| `toggle.remove` | `address`, `block`, `keepContent?`（默认 true） |

`keepContent: false` 与 CLI 的 `--delete-content` 等价；`clearBg: true` 与 `--clear-bg` 等价。

## 测试

```bash
npx vitest run app/flowix-web/features/editor/extensions/toggle \
  app/flowix-web/features/editor/components/drag-context-menu/toggle-target.test.ts \
  app/flowix-web/features/editor/markdown-parser-regressions.test.ts \
  app/flowix-web/features/editor/extensions/paste-rules/paste-rules.test.ts

cd app
cargo test -p flowix-core toggle::tests
cargo test -p flowix-cli --test toggle_e2e
cargo test -p flowix-cli --test mcp_e2e structured_toggle
```

- `toggle-markdown.test.ts`：展开 / 收起、未知标记、空块、多段 + 列表、嵌套结构、代码围栏、未闭合围栏。
- `toggle-commands.test.ts`：包裹、解包、列内包裹、列表包裹补空标题、撤销、标题起点判定。
- `toggle-node-view.test.ts`：箭头切换、装饰类、光标移出正文、自动展开、无正文时不可折叠。
- `toggle-target.test.ts`：箭头 / 标题 / 正文 / 嵌套着重块的拖拽目标与光标目标。
