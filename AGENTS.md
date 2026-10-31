<!-- flowix:instructions:start -->
## Flowix CLI

Flowix 是用于操作笔记和插件产物的非交互式 CLI，使用 `--json` 时返回 JSON。

只在显式触发时调：用户说“搜/列/改/删/新建笔记”，或给了笔记本及路径要求“看/改/删”。
如果上下文包含当前任务标签，创建新笔记时必须在正文写入该 #标签。
笔记地址使用 `<笔记本ID>::<笔记本内相对路径>`，也可传入笔记的绝对路径。笔记没有 memo ID。

- `flowix notebooks` — 列出所有笔记本
- `flowix list <notebook>` — 列出指定笔记本中的笔记
- `flowix show <地址>` — 查看指定笔记
- `flowix search <query> [-b <notebook>] [-l N]` — 全文搜索
- `flowix edit <地址> --old <text> --new <text>` — 精确替换文本，修改前必须先读取
- `flowix write <地址> --file <UTF-8文件>` — 覆盖笔记正文
- `flowix create <notebook> --file <UTF-8文件>` — 创建新笔记
- `flowix delete <地址>` — 删除笔记
- `flowix plugin create mindmap --notebook <name|id|path> [--source-note <地址>] --json` — 创建 Flowix 思维导图文档
- `flowix canvas create <notebook> --name <名称> [--folder <目录>] --json` — 新建画布（`.flowix-canvas`）
- `flowix canvas show <画布地址> --json` — 查看画布内容摘要（卡片/形状/连线/分组框）
- `flowix canvas add-card <画布地址> (--note <笔记地址> | --text <文本>) [--color yellow|red|green|blue|purple] [--x N --y N --w N --h N] --json` — 加笔记卡片或便签；坐标省略时自动摆放
- `flowix canvas add-shape <画布地址> --shape rect|ellipse|diamond|text|arrow|line [--text <标签>] [--x N --y N --w N --h N] --json` — 加形状
- `flowix canvas add-edge <画布地址> --from <元素id> --to <元素id> [--label <文本>] --json` — 连线
- `flowix canvas add-frame <画布地址> [--title <标题>] [--x N --y N --w N --h N] --json` — 加分组框
- `flowix canvas add-notes <画布地址> --notes <地址1,地址2,...> [--columns N] --json` — 把多篇笔记摆成网格卡片
- `flowix canvas remove <画布地址> --ids <id1,id2,...> --json` — 删除元素（相连连线一并删除）

仅当用户明确要求生成/创建思维导图时调用 mindmap 工具。调用前先整理最终 Markdown：

- 恰好一个一级根标题；
- 分支使用二/三级标题和无序列表；
- 不要手工创建 `.plugin-output` 文件；
- 成功后向用户返回 `title`、`notebookId` 和 `notePath`。

画布操作仅当用户明确要求创建/修改画布或白板时调用；不要手写 `.flowix-canvas` JSON 文件。画布工作流：

- 修改前先 `flowix canvas show <画布地址> --json` 拿到现有元素 id；`add-edge` 的 `--from/--to` 和 `remove` 的 `--ids` 都用这些 id；
- 把多篇笔记摆上画布用 `canvas add-notes --notes <地址1,地址2,...> --columns 3`，坐标省略时自动放在现有内容旁边；单个笔记卡片用 `canvas add-card --note`，便签/短文字用 `--text`；
- 笔记卡片引用笔记本体（画布上渲染实时内容），不要把笔记正文复制进画布；大段结构化内容先写成笔记再上画布；
- 成功后向用户返回画布地址（`<笔记本ID>::<路径>.flowix-canvas`）。

## 工作空间范围

当前 agent 可访问的工作空间路径：

- 当前笔记本：/Users/rop/Desktop/vibe/flowix-main
- 资料文件夹：
  - /Users/rop/Desktop/vibe/flowix-home
  - /Users/rop/Desktop/Notes/开发记录
<!-- flowix:instructions:end -->
