# 附件存储键（跨端可移植性约定）

- 状态：已实现（2026-10-28，分支 `fix/fns-attachment-sync`）
- 相关：FNS 文件通道、编辑器 attachment-link、笔记缩略图

## 1. 问题

附件节点把**设备绝对路径**当作 `storageKey` 写入 markdown：

```markdown
![133864360343560357.jpg](asset://localhost/D%3A%5Cflowix%5Cattachments%5C133864360343560357.jpg)
```

FNS 按原样同步内容，附件文件本身则按**笔记本相对路径**（`attachments/<name>`）到达另一端。移动端拿到桌面路径后 `asset://localhost/D%3A...` 无法解析，图片全部不可访问。

## 2. 约定

**笔记内容只持久化笔记本相对 key（正斜杠分隔）**，绝对路径只用于本机即时使用：

```markdown
![photo.jpg](asset://localhost/attachments%2Fphoto.jpg)
```

- 同一份内容在任何设备上都指向“该设备自己的笔记本根 + key”。
- 与 frontmatter 图片属性、媒体库 record（`relative_path`）既有约定一致。

## 3. 写入端

| 位置 | 行为 |
|---|---|
| `commands/dialog.rs` `save_notebook_asset` | 返回 `{ path, key, created }`，`key` 相对笔记本根 |
| `commands/dialog/attachments.rs` `save_locked` | 三处返回点统一经 `notebook_relative_key()` 计算 key |
| `upload_sessions.rs` `finish_attachment_upload` | 同结构，自动带上 key |
| 前端 `upload/storage.ts` | `storageKey = saved.key`；`url` 用绝对 `path`，仅作插入时的预览 |

## 4. 读取端

`attachment-link/utils.ts`：

```ts
resolveAttachmentStorageKey(key, notebookPath) -> absolute path
```

规则：

1. 相对 key → `notebookPath/key`
2. 绝对路径已在本机某笔记本根内 → 原样使用
3. 绝对路径来自其他设备（不在本机笔记本根内）且形如 `.../attachments/<name>` → 重定位为 `<本机笔记本根>/attachments/<name>`
4. 无法判断 → 原样返回（行为与修复前相同）

笔记本根由 `AttachmentLink` 的 `getNotebookPath` 提供（`document-container` 按当前文档解析笔记本）。编辑器节点视图、笔记卡片缩略图、笔记引用预览、多维表图库缩略图均走该解析器。

## 5. 已知待办

- **docx 导入**（`commands/file.rs` `docx_asset_markdown_url`）仍写入绝对路径。需先区分笔记本与外部目录（仅笔记本空间可安全写相对 key）。
- 旧笔记内容中的绝对路径**不会自动改写**，只在渲染时重定位；用户下次编辑保存后依然保持绝对形式。若需彻底收敛，可在打开时做一次内容迁移（需评估 dirty 状态与同步冲突成本）。
- `renderHTML` 等静态序列化路径无法访问编辑器上下文，仍输出基于未解析 key 的 URL；仅影响 HTML 复制/导出，NodeView 渲染不受影响。
