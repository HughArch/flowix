# 着重块（Callout）

> 状态：已实现（编辑器 + Markdown 往返 + CLI / MCP）。

## 目标与边界

参考 Flowus 的「着重块」：一个带图标、整块背景色、内部可放任意块内容的强调容器。

范围内的能力：

- `/` 命令菜单插入「着重块」。
- 空段落行首输入 `!!` + 空格快捷创建。
- 点击左侧图标弹出面板，更换 emoji 与 9 种背景色。
- 容器内支持多段落、列表、引用、分栏、嵌套着重块。
- Markdown fenced div 持久化，纯文本可读且可往返。
- 光标在首块行首按 Backspace 解包容器。
- CLI / MCP 可列出、插入、修改和移除着重块。

不在范围：

- 上传图片 / 图标 URL 作为图标（当前仅支持 Unicode emoji）。
- 肤色变体与区域指示符字母（不作为独立图标提供）。
- 外部块拖入 / 拖出着重块（容器内重排仍然可用）。
- 全角 `！！` 快捷输入。

## 数据模型

```ts
callout: {
  group: 'block',
  content: 'block+',   // 必须至少有一个块
  isolating: true,     // 选区不跨容器边界
  selectable: false,
  draggable: false,
  attrs: {
    icon: '💡',        // emoji 字符
    color: 'gray',     // FlowixTextColor
  },
}
```

`isolating` 与 `columns` 一致：光标属于内部块，避免一次删除半截容器。
拖拽菜单命中的是内部块（`getTargetBlockDepth` 不识别容器），容器本身通过内部块的菜单操作。

## Markdown 持久化

```markdown
::: callout icon="💡" color="yellow"

内容第一段

- 列表也可以

:::
```

规则：

- 默认属性（`💡` / `gray`）省略，写成 `::: callout`。
- 属性顺序任意，未知属性忽略；非法 `color` 回落 `gray`，缺失 `icon` 回落 `💡`。
- 图标用 `JSON.stringify` 输出，引号与反斜杠不会破坏围栏行。
- 空内容解析为一个空段落，保证 `block+` 合法；序列化时该空段落输出 `&nbsp;`（与 `PreservedParagraph` 一致）。
- 围栏按**长度栈**匹配：关闭行冒号数 ≥ 打开行冒号数才关闭；``` / ~~~ 代码围栏内的 `:::` 不参与匹配。
- 嵌套容器（callout 套 columns、columns 套 callout、callout 套 callout）全部由长度栈平衡。

### 两套 registry 必须同步

| Registry | 文件 | 注册的节点 |
|---|---|---|
| 编辑器 | `features/editor/markdown-editor-extensions.ts` | `CalloutEditorNode`（含 NodeView / 快捷键 / 插件） |
| Worker 解析 | `features/editor/markdown-parser-extensions.ts` | `CalloutNode`（纯节点 + markdown spec） |

`callout.ts` / `callout-markdown.ts` 不得 import NodeView、React 或 store，否则 worker bundle 会被污染。

## 交互

### 创建

- Slash 菜单：`/callout`、`/zzk`、`/着重块`。
- 输入 `!!` + 空格（仅在半角、空段落、无 mark 时触发）。
- **新建默认场景**：💡 + 橙色背景（`DEFAULT_CALLOUT_PRESET`）。
- 两者都会把「选区所在的最近块」包进着重块：
  - 普通文档 → 包裹顶层段落；
  - 分栏 / 引用 / 列表项内 → 包裹该内部块，不会误包整个 `columns` 容器；
  - 光标在列表项**首个段落**时，段落是 `listItem` 的必需首块，不能直接替换：Slash 命令改为包裹整个列表；`!!` 快捷输入在该位置保持惰性（不转换）。

### 场景预设

图标浮层顶部提供四个一键场景（同时设置图标与背景色）：

| 场景 | 图标 | 背景 |
|---|---|---|
| 提示（默认） | 💡 | orange |
| 成功 | ✅ | green |
| 警示 | ⚠️ | yellow |
| 错误 | ❌ | red |

> 兼容性：Markdown 中没有 `color` 属性的旧着重块仍解析为 gray，不会因为默认场景改为橙色而变色；只有通过 Slash / `!!` 新建的着重块会显式写入 `color="orange"`。

### 图标与颜色

点击左侧图标打开浮层：

- **常用**：首屏 40 个高频 emoji，立即渲染，不等待数据加载。
- **完整目录**：9 个 Unicode 分类（表情、动作、动物、食物、旅行、活动、物品、符号、旗帜），共 1898 个可显示表情；不含肤色组件与区域指示符。
- 25 个 Emoji 16+ 新表情（如 🫫、🫩、🫪）当前既没有系统字形、也没有 Twemoji 资源，暂时从目录中隐藏，避免显示方框；数据源跟上后会自动恢复。
- 分类名使用精简标签（例如原「笑脸与情感」显示为「表情」），完整名称仍保留在数据里。
- 网格使用**虚拟滚动**、事件委托与滑动窗口缓存：只渲染视口附近的约 90 个按钮，切换分类不会重建整类 DOM。
- ZWJ 组合表情（家庭、职业等）会自动缩小字号，避免在网格中与相邻表情重叠。
- **搜索**：支持中英文名称与关键词，空格分隔的多个词按 AND 匹配；搜索跨全部分类，结果上限 300。
- **旗帜使用本地 SVG**：Windows 的系统 emoji 字体不包含国家队旗帜，因此旗帜分类改用 Twemoji SVG（本地资源、按需加载），保证跨平台显示一致。资源见 `callout/flag-assets/`，许可与署名见 `callout/FLAG-ASSETS.md`（CC-BY 4.0）。
- 9 色背景（复用 `FLOWIX_TEXT_COLORS` / `--flowix-text-*`）。

数据通过动态 `import()` 懒加载（约 212 KB / 75 KB gzip 的独立 chunk），不进入启动包；首次打开浮层时加载。修改走一次 `setNodeMarkup`，一步撤销。浮层全局单例，点击外部 / Escape / 滚动会关闭。

数据来源与再生成：

- 源：`emojibase-data`（MIT），由 Unicode CLDR 注释生成，含中英文标签与关键词。
- 生成：`npm run emoji:catalog` → `app/flowix-web/features/editor/extensions/callout/emoji-catalog.ts`。
- 旗帜图片：`npm run emoji:flags` → `callout/flag-assets/`（Twemoji，CC-BY 4.0）。
- 升级 `emojibase-data` / `@twemoji/svg` 后重新执行对应脚本并提交生成文件。

### 双层抓手

着重块同时支持「整体」与「块内元素」两种抓手，按鼠标悬停位置切换：

| 悬停位置 | 抓手目标 |
|---|---|
| 左侧图标栏 | 整个着重块 |
| 内容区上方 / 下方的垂直内边距 | 整个着重块 |
| 内容区的任意一行（含左侧水平内边距） | 该行对应的内部块 |

- 判定按**垂直行**而不是左右区域：只要指针的 Y 落在内容区的某一行，无论从左侧还是右侧进入，都会得到该内部块的抓手。
- 整体抓手：拖拽、删除、拆分为分栏都以整块为单位；块菜单只保留「删除」与分栏操作。
- 块内元素抓手：按原有块规则工作，可单独拖动、删除、转换；列表项优先于其内部段落，表格优先于其单元格。
- 光标（selection）位于内部时，手柄默认指向光标所在的内部块；要选整体，请把鼠标移到图标栏或内容区上下的内边距。
- 从内部块横向移向左侧手柄时，只要仍在该行的垂直范围内，目标会保持为内部块，不会在中途切换成整体。
- 嵌套着重块：悬停内层图标得到内层整体，悬停外层图标得到外层整体。
- 行背景色仍可通过选区浮动面板设置。

### 删除与解包

- 光标在着重块**首个直接文本块**（段落 / 标题）的行首按 Backspace：解包为普通块，内容保留。
- 列表项、引用、分栏等嵌套结构内部的行首不触发解包，由这些结构自己处理（例如删除有序列表序号、减少缩进），避免误删整个着重块。
- 拖拽菜单的「删除」作用于内部块；容器最后一个子块被删除时，ProseMirror 会补一个空段落，容器保持合法。
- `block-drag` 的 `fillEmptyContainers()` 兜底 `column` 与 `callout` 的零子节点状态。

## CLI / MCP

### CLI

```bash
flowix callout list <id> --json
flowix callout add <id> [--at <line>] [--icon <emoji>] [--color <color>] \
  [--content <text> | --file <utf8.md> | --stdin] --json
flowix callout set <id> --block <n> [--icon <emoji>] [--color <color>] --json
flowix callout remove <id> --block <n> [--delete-content] --json
```

- `add` 默认 `💡 + orange`；内容来源三选一（`--content` / `--file` / `--stdin`），可省略。
- `set` 至少提供 `--icon` 或 `--color`。
- `remove` 默认保留内容（解包）；`--delete-content` 才连同内容删除。
- 颜色：`red / orange / yellow / green / cyan / blue / purple / pink / gray`。

### MCP

`memo` 工具的 structured actions：

| action | 参数 |
|---|---|
| `callout.list` | `address` |
| `callout.add` | `address`, `content?`, `icon?`, `color?`, `at?` |
| `callout.set` | `address`, `block`, `icon?`, `color?` |
| `callout.remove` | `address`, `block`, `keepContent?`（默认 true） |

`keepContent: false` 与 CLI 的 `--delete-content` 等价。

> CLI/MCP 的 `list` / `set` / `remove` 以**顶层**着重块为单位；嵌套在另一个着重块内部的着重块会作为父块内容保留，暂不单独索引。

## 与现有系统的交互

| 系统 | 行为 |
|---|---|
| 行背景色 | 内部段落仍可单独设置行背景，与着重块背景叠加 |
| 分栏 | 两者互相嵌套，扫描器按围栏长度平衡 |
| 拖拽手柄 | 位置按编辑区左栏计算，不覆盖图标 |
| 复制 / 粘贴 | `renderHTML` 输出 `div[data-flowix-callout]` + `data-icon/data-color` |
| Placeholder | 空段落沿用全局 Placeholder |

## 边界与风险

| 场景 | 处理 |
|---|---|
| 围栏未闭合 | `scanCallout` 返回 null，交回普通段落解析，不丢笔记 |
| 正文出现单独的 `:::` 行 | 会被当作关闭围栏（与 columns 相同），建议用代码块包裹 |
| 光标在首块行首以外 | Backspace 不触发解包 |
| Enter 在末尾 | 默认在容器内新建段落（与 Notion 一致）；点击下方块退出 |
| 将外部块拖入着重块 | 暂不支持；容器内重排可用 |

## 测试

- `extensions/callout/callout-markdown.test.ts`：属性、往返、空内容、嵌套、代码围栏、worker registry。
- `extensions/callout/callout-commands.test.ts`：包裹/解包、列内包裹、光标映射、合法删除、撤销、`!!` 条件。
- `extensions/columns/columns-markdown.test.ts`：列内着重块回归。
- `markdown-parser-regressions.test.ts`：worker 解析含着重块的文档。
- Rust：`memo_file::callout` 单元测试、`callout_e2e.rs`、`mcp_e2e.rs` 的 structured callout 用例。

```bash
npx vitest run app/flowix-web/features/editor/extensions/callout \
  app/flowix-web/features/editor/extensions/columns/columns-markdown.test.ts \
  app/flowix-web/features/editor/markdown-parser-regressions.test.ts

cd app
cargo test -p flowix-core callout::tests
cargo test -p flowix-cli --test callout_e2e
cargo test -p flowix-cli --test mcp_e2e structured_callout
```
