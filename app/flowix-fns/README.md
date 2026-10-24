# flowix-fns

Flowix 侧的 Fast Note Sync Service（FNS）客户端。纯 Rust，无 Tauri 依赖，桌面、CLI 与未来的移动端可共用。

## 协议要点

服务端（`haierkeys/fast-note-sync-service`）使用 WebSocket，帧格式为 `Action|JSON`。

### 握手

```
GET /api/user/sync?client=<clientType>&clientName=<name>&clientVersion=<version>
→ Authorization|<raw token>        // 裸 token，不是 JSON 字符串
← Authorization|{...}
→ ClientInfo|{"name":...,"version":...,"type":...}
← ClientInfo|{...}
```

`?client=` 必须与 token 的 `c:` 维度匹配，否则返回 `315 Auth token Scope restricted`。Obsidian 插件签发的 token 使用 `obsidianPlugin`。

### 哈希

服务端用 JavaScript 风格的 32 位字符串哈希：

```
hash = (hash << 5) - hash + char   // 按 UTF-16 code unit，i32 自然溢出
```

客户端必须逐位一致，否则每次同步都会被判定为内容变化。二进制附件使用同样的递推算字节，超过 10 MiB 时只算前 5 MiB 和后 5 MiB。

> 服务端文档里写的 "FNV-1a" 是错误的，以 `pkg/util/hash.go` 的实现为准。

### 拉取

```
→ NoteSync|{context, vault, lastTime, batchIndex, totalBatches, notes, delNotes, missingNotes}
← NoteSyncEnd|{lastTime, needUploadCount, needModifyCount, needSyncMtimeCount, needDeleteCount}
→ NoteSyncPageAck|{context, vault, pageIndex: -1}      // 请求第一页
← NoteSyncPage|{pageIndex, pageSize, totalCount, isLast}
← NoteSyncModify / NoteSyncDelete / NoteSyncRename / NoteSyncMtime / NoteSyncNeedPush × totalCount
→ NoteSyncPageAck|{context, vault, pageIndex}          // 非最后一页时确认，再拉下一页
```

`lastTime` 是**毫秒**时间戳，由服务端生成，客户端应持久化。

### 上传与删除

```
→ NoteModify|{vault, path, pathHash, content, contentHash, baseHash, ctime, mtime, createOnly}
← NoteModifyAck|{lastTime, path, pathHash}

→ NoteDelete|{vault, path, pathHash}
← NoteDeleteAck|{...}
```

`baseHash` 是这次编辑所基于的内容哈希。服务端判定无法自动合并时返回 `530`，并在 data 里带 `serverContent` / `baseContent` / `serverHash`；客户端手动合并后带 `isConflictResolved: true` 重发。

## 用法

凭据放在仓库根的 `.local/fns-credentials.json`（已 gitignore，切勿提交）：

```json
{
  "api": "https://fns.example.com",
  "apiToken": "<token>",
  "vault": "test",
  "clientType": "obsidianPlugin"
}
```

```bash
cd app
cargo run -p flowix-fns --bin fns-probe                                   # 拉取
cargo run -p flowix-fns --bin fns-probe -- sync <notebook-root> [vault]  # 双向同步
cargo run -p flowix-fns --bin fns-probe -- push note.md "content"        # 上传后回拉
cargo run -p flowix-fns --bin fns-probe -- delete note.md                # 删除
```

## 双向同步模型

一个 notebook 绑定一个 vault。绑定关系与游标保存在
`<notebook>/.flowix/sync-state.json`：

```json
{
  "version": 1,
  "vault": "工作",
  "lastTime": 1792782688774,
  "deviceId": "…",
  "lastSyncAt": 1792782688774,
  "notes": { "hello.md": { "contentHash": "-1948130249", "mtimeMs": 1792782456914 } }
}
```

`notes` 是上次同步结束时的本地快照，用来做两件事：
1. **识别本地删除**——上次存在、这次消失的路径通过 `delNotes` 上报。漏掉这一步，服务端会把文件当成"客户端缺失"重新下发。
2. **只上报变更**——增量同步时只发送 hash 与快照不同的笔记。服务端会把"客户端上报了但本次增量窗口里没看到"的笔记判定为需要上传，因此每次都发全量清单会导致空转同步反复推送。

服务端下发 `NoteSyncMtime`（内容相同、时间不同）时，客户端只调整本地文件 mtime，不回传内容。

## 当前范围

已实现：

- 握手（Authorization / ClientInfo）
- 笔记增量拉取 + 分页确认
- 双向同步：创建 / 修改 / 删除 / 重命名
- 本地删除快照与 `delNotes` 上报
- 附件同步：`FileSync` 分页、分片上传（`"00"` 二进制帧）、分片下载
- 附件大小上限：超过上限的文件既不上传也不下载，`0` 表示关闭附件同步
- path/content 哈希
- `FsNoteStore` 与 `MemoryNoteStore`（同时实现笔记与附件两个 trait）

附件同步要点：

- 笔记和附件各用一个游标（`lastTime` / `fileLastTime`），共用会漏变更。
- 上传流程：`FileSync` 上报本地文件 → 服务端在页消息里下发 `FileUpload`（带 `sessionId`/`chunkSize`）→ 客户端按分片发送 → 等 `FileUploadAck`。
- 下载流程：收到 `FileSyncUpdate` → 发 `FileChunkDownload` → 服务端回 `FileSyncChunkDownload` 元数据后立即推送二进制分片 → 按 `totalChunks` 拼装。
- 快照里存在、当前列表里没有的路径，只有确认磁盘上确实不存在才作为删除上报；因超过大小上限被过滤的文件保持原样。

未实现（后续）：

- 文件夹同步
- 冲突手动解决流程（当前 `newTimeMerge`，`530` 会记录到报告里）
- 实时触发（watcher 驱动）与 IPC
