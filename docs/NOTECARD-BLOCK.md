# 块级笔记卡片（Note Card）

> 状态：已实现（编辑器 + Markdown 往返 + CLI / MCP / 移动端内置 Agent）。
> 编辑器侧（`/` 菜单「笔记卡片」、多布局、悬浮预览、`::notecard{json}` 序列化）见
> `app/flowix-web/features/editor/extensions/note-block/`；本文记录 CLI / MCP /
> 内置 Agent 三侧对同一数据格式的读写支持。

## 数据格式

块级笔记卡片持久化为**单行指令 + JSON payload**：

```markdown
::notecard{"notebookId":"work","relativePath":"Notes/A.md","notebookName":"Work","title":"A","originalPath":null,"linkStyle":"flowix","linkTarget":null,"heading":null,"stale":false,"layout":"card","color":"","customText":""}
```

- 三种布局：`line`（单行：图标+标题+摘要）/ `card`（小卡片，默认）/ `cardLarge`（大卡片：封面横幅+标题+摘要）。
- `color` 为卡片填充色（`NOTE_COLORS`：`red/orange/yellow/green/cyan/blue/gray`；空串 = 不填充）。
- `customText` 覆盖卡片摘要（笔记首行；空串 = 用摘要）。
- `title` 是展示快照，编辑器挂载后会按笔记索引刷新；CLI / Agent 插入时按与
  `extract_title_and_preview` 一致的规则派生。
- payload 解析失败时编辑器仍渲染一张默认卡片；Rust 侧保持同样的块计数，保证
  `list/set/remove` 的序号与编辑器一致。
- 未知 payload 键在 `set` 时原样保留，新编辑器的属性不会被旧 CLI 冲掉。

解析器：`app/flowix-core/src/memo_file/notecard.rs`。大括号按字符串感知计数，
标题里含 `}` 不截断；` ``` ` 代码围栏内的 `::notecard` 不参与解析；允许缩进与
跨行 payload（跨行 payload 在 `set` 后会归一化为单行）。

## CLI

```bash
flowix notecard list <id> --json
flowix notecard add <id> --note <note|canvas 地址> [--at <line>] [--layout line|card|cardLarge] \
  [--color <color>] [--text <自定义文字>] [--title <标题快照>] --json
flowix notecard set <id> --block <n> [--layout L] [--title T] [--color C | --clear-color] \
  [--text T | --clear-text] --json
flowix notecard remove <id> --block <n> --json
```

- `add` 默认 `card` 布局、无填充、无自定义文字；`--note` 必填，接受笔记地址
  （`<notebook>::<路径>` / 绝对路径 / 当前笔记本相对路径）或画布地址
  （`.flowix-canvas`，标题取文件名主干，仅做存在性检查）。
- 标题快照与画布笔记卡片一致：先取 `extract_title_and_preview`，回落笔记索引
  标题；`--title` 显式覆盖。
- `set` 需至少提供一个字段；`--color` 与 `--clear-color`、`--text` 与
  `--clear-text` 互斥。
- 颜色：`red / orange / yellow / green / cyan / blue / gray`（大小写不敏感）。

## MCP

`memo` 工具 structured actions（schema 见 `dsh-flowix-memory/memo-tool-schema.json`）：

| action | 参数 |
|---|---|
| `notecard.list` | `address` |
| `notecard.add` | `address`, `note`, `at?`, `layout?`, `color?`, `text?`, `title?` |
| `notecard.set` | `address`, `block`, `layout?`, `title?`, `color?`/`clearColor?`, `text?`/`clearText?` |
| `notecard.remove` | `address`, `block` |

`address` 是被编辑的笔记，`note` 是被引用的目标笔记/画布。

## 移动端内置 Agent

工具名 `notecard`（`app/flowix-desktop/src/agent_builtin/`，与 callout/toggle/columns/background
并列）：

- `list` / `set` / `remove` 语义与 CLI 相同；`add` 用 `notePath`（当前笔记本内
  相对路径）定位目标，内置 Agent 沙箱在当前笔记本内，画布目标按
  `resolve_canvas_path` 做存在性检查。
- 工具描述与系统提示都要求"不要手写 `::notecard` 语法"，统一走工具保证
  结构合法与 CAS 保护。

## 摘要派生

`::notecard{...}` 已登记进 `flowix-core` 的 `BLOCK_NODE_FILTERS`（单点配置），
笔记标题 / 摘要派生时会剔除该行，避免以卡片开头的笔记把 JSON 当标题。

## 测试

```bash
cd app
cargo test -p flowix-core notecard                                  # 解析器单测
cargo test -p flowix-core derivation                                # 摘要过滤回归
cargo test -p flowix-cli --test notecard_e2e                        # CLI 端到端
cargo test -p flowix-cli --test mcp_e2e structured_notecard         # MCP 端到端
cargo test -p flowix-desktop --lib agent_builtin::rich_content      # 内置 Agent
```
