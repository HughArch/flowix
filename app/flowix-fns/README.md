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
cargo run -p flowix-fns --bin fns-probe                              # 拉取
cargo run -p flowix-fns --bin fns-probe -- push note.md "content"    # 上传后回拉
cargo run -p flowix-fns --bin fns-probe -- delete note.md            # 删除
```

## 当前范围

已实现：

- 握手（Authorization / ClientInfo）
- 增量拉取 + 分页确认
- NoteModify / NoteDelete
- path/content 哈希

未实现（后续）：

- 附件分片上传 / 下载
- 文件夹同步
- 冲突手动解决流程
- 本地持久化（lastTime、路径索引）
- 接入 Flowix 的 notebook 存储层与 IPC
