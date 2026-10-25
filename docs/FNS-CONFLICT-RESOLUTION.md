# FNS 同步冲突解决方案

> 分支：`feat/fns-conflict-resolution` · 2026-10-25 · 状态：PR1/PR2/PR3 已实现（PR4 服务端增强未做，非阻塞）

## 1. 现状与问题

### 1.1 事实链（两侧代码已核实）

**客户端（flowix）**

| 事实 | 位置 |
|---|---|
| 冲突检测：push 时服务端回业务码 530 → `FnsError::Conflict { path, payload }` | `app/flowix-fns/src/sync.rs:203-217` |
| 530 payload 携带三方内容：`ConflictPayload { server_content, base_content, server_hash }` | `app/flowix-fns/src/protocol.rs:313-326` |
| 冲突解决流程**不存在**：530 只记入 `report.conflicts`，无后续动作 | `app/flowix-fns/src/engine.rs:261-265` |
| 协议要求的 `isConflictResolved=true` 重推从未发出（恒 false） | `app/flowix-fns/src/sync.rs:198` |
| 同步策略硬编码 `NewTimeMerge`（可配置 UI 曾上线后被 revert，8ecaf805） | `app/flowix-desktop/src/fns_sync/config.rs:199-200` |
| 现成三方合并能力：保守合并，冲突绝不写标记进原文件 | `app/flowix-core/src/text_merge.rs:131` `merge_markdown(base, local, remote) -> MergeOutcome` |
| 同步状态：`<notebook>/.flowix/sync-state.json`，只有 `path → {content_hash, mtime}` 快照 + `last_time` 游标，push 时 content_hash 兼任 `base_hash` | `app/flowix-fns/src/state.rs:25-54, 87-94` |

**服务端（fast-note-sync-service）**

| 事实 | 位置 |
|---|---|
| `manualMerge` 策略：baseHash 不匹配 → 拦截 push，回 530 + 三方内容，**不写任何副本** | `internal/routers/websocket_router/ws_note.go:140-164, 295-308` |
| 客户端带 `isConflictResolved=true` 重推 → 跳过合并直写 + 向**所有**端广播 | `ws_note.go:177-181, 410-433` |
| `newTimeMerge` 等合并策略：真冲突时 `MergeTextsIgnoreConflictIgnoreDelete` 强制合并进原路径 + **服务端生成 `.conflict.<yyyyMMddHHmmss>` 副本** + 530 通知触发端 | `ws_note.go:351-397` |
| 冲突副本命名 `{baseName}.conflict.{ts}{ext}`，即 `notes/test.md → notes/test.conflict.20060102150405.md` | `internal/service/conflict_service.go:52-119` |
| baseContent 靠历史表反查；历史快照约 20-30s 才落一份，baseHash 经常查不到 → 退化为「拿服务端当前内容当 base」 | `ws_note.go:242-288` |
| 530 只发给触发冲突的那条连接；**没有独立的冲突广播事件** | `ws_note.go:152-158`、`pkg/app/websocket.go:704-815` |
| 版本语义：无数字版本号，`content_hash`（32 位哈希）+ 毫秒时间戳游标 `lastTime`；删除为 tombstone | `internal/dao/note_repository.go:827-832` |

### 1.2 问题定性

1. **用户看到的「客户端生成冲突文件」实为服务端产物**：`NewTimeMerge` 下真冲突 → 服务端强制合并 + 生成 `.conflict.` 副本 → 副本经 pull 以普通新笔记落盘。客户端对它零感知、零去重。
2. **服务端强制合并「保留双方全部文本」会污染原笔记**：原路径内容被写入两边的重复段落，且此结果直接广播到所有设备。
3. **冲突风暴根因已修但生产源未关**：push 缺 `base_hash` 导致每次编辑产一个副本的问题已在 66380248 修复；但只要 `NewTimeMerge` 下发生真冲突，服务端仍会继续产副本。
4. **协议里最完整的合并套件（manualMerge + 530 三方内容 + resolved 重推）客户端完全没接**。

### 1.3 设计目标

- 冲突的**决定权在客户端**：服务端停止生产 `.conflict.` 副本（关闭生产源）。
- **自动优先**：能自动三方合并的静默解决，不打扰用户；真冲突才上报 UI。
- **防循环防风暴**：冲突挂起期间同步循环不得反复重推/反复触发 530。
- 崩溃/重启安全：挂起的冲突可恢复。
- 存量 `.conflict.` 文件有清理路径。

## 2. 方案总览

```
┌─ 客户端（全部改动主体） ──────────────────────────────────────────┐
│                                                                    │
│  push ──530──▶ ConflictDetector 记录 pending conflict              │
│                  │  （server/base content 落 .flowix/conflicts/）  │
│                  ▼                                                 │
│           auto_resolve：text_merge::merge_markdown                 │
│             ├─ Merged ──▶ 本地写回 + push(isConflictResolved=true) │
│             │              + 清除 pending + 快照推进               │
│             └─ Conflict/Unsupported ──▶ 挂起，UI 冲突中心提示      │
│                                                                    │
│  同步循环：pending 中的 path 跳过自动 push（防循环）               │
│  UI 冲突中心：使用我的 / 使用云端 / 智能合并（同上管线）           │
└────────────────────────────────────────────────────────────────────┘

服务端：仅切换客户端上报策略为 manualMerge 即可（协议全部现成）。
       可选增强另列 §6。
```

核心判断：**服务端 `manualMerge` 分支 + `isConflictResolved` 直写广播 + 客户端 `text_merge` 保守合并**三块积木都已存在，方案是「接线」而非「造轮子」。服务端零必需改动。

## 3. 客户端详细设计

### 3.1 策略切换（开关生产源）

`config.rs:199-200` 的 `NewTimeMerge` 改为 `ManualMerge`。这是唯一让服务端停写 `.conflict.` 副本的开关：`manualMerge` 下 push 冲突一律 530 拦截，服务端不合并、不产副本、原路径不被污染。

保留按配置读取的能力（默认 `manual`），作为逃生口——若自动管线出问题可临时切回旧行为。

### 3.2 冲突记录：pending conflict 状态机

**存储**：内容放独立目录，索引放 sync-state，避免 `sync-state.json` 膨胀。

```
<notebook>/.flowix/conflicts/<sha256(path)>.json
{
  "path": "notes/test.md",
  "server_content": "...",     // 530 payload
  "server_hash": "...",
  "base_content": "...",       // 530 payload（可能为空，见 §5 边界）
  "base_hash": "...",          // 触发 530 时所用的 base
  "detected_at": 1730000000000,
  "device": "desktop-win"
}
```

`SyncState` 增加 `pending_conflicts: BTreeMap<String /*path*/, i64 /*detected_at*/>`，随现有原子写（tmp+rename，`state.rs:151-164`）持久化。同一 path 重复 530 → **刷新**记录而非新增（去重）。

**状态机**：

```
              530 ──▶ [Pending] ──auto merge ok──▶ [Resolving: push resolved=true] ──ack──▶ 清除+快照推进
                        │  ▲                                │ 失败（网络等）→ 保留 Pending，下轮重试
                        │  └──── 用户再次编辑本地 ── 刷新本地侧（resolve 时重读文件）
                        └──── 另一端已解决并广播 ──▶ 下轮 pull 比对后自动消解（§3.5）
```

### 3.3 同步循环改造（防循环的关键）

`engine.rs` 两处：

1. **push 前过滤**：构造 `need_push` 上传循环时，跳过 `state.pending_conflicts` 中的 path。没有这一步会出现死循环：本地改动未推 → 快照未推进 → 下轮又被 need_push → 再 530 → 再挂起。
2. **快照排除**（PR1 实现期发现的补充细节）：`record_snapshot` 改为 `record_snapshot_ignoring_pending`，挂起路径不进快照。否则该路径的本地内容会被当作「服务端已确认的版本」成为下一次 push 的 base——而它从未被服务端接受过；且不进快照才能保证路径每轮都被上报（服务端只对它看到的上报发 need_push，静默的挂起会永远失去重试与对端消解的机会）。
3. **自愈清消**：skip 分支里比对本地内容哈希与冲突记录的 `server_hash`，一致（对端解决结果经 pull 到达，或用户手工取了云端内容）即清除挂起标记，避免永久滞留的 UI 徽标。
4. **530 处理**（替换 `engine.rs:261-265` 的仅记录行为）：

```rust
Err(FnsError::Conflict { path, payload }) => {
    state.record_pending_conflict(&path, &payload);   // 去重刷新
    match auto_resolve(&store, &path, &payload) {     // §3.4
        Ok(Some(merged)) => {
            store.write_note(&path, &merged)?;
            push_note(client, PushNote { ..., is_conflict_resolved: true }).await?;
            state.clear_pending_conflict(&path);
            report.conflicts_auto_resolved += 1;
        }
        Ok(None) => report.conflicts_pending.push(path),   // 真冲突，留 UI
        Err(e) => return Err(e),
    }
}
```

`sync.rs:198` 的 `is_conflict_resolved` 参数化（当前恒 false），仅解决动作置 true。

### 3.4 解决管线与语义

resolve 时**重读本地文件**（挂起期间用户可能又编辑过，以最新内容为准），三方语义：

| 用户动作 / 自动合并 | base | local | remote | 推送内容 |
|---|---|---|---|---|
| 自动合并成功（静默） | 记录的 base_content | 当前文件内容 | server_content | 合并结果 |
| 「智能合并」按钮 | 同上 | 同上 | 同上 | 合并结果（失败则提示手动） |
| 「使用我的」 | — | 当前文件内容 | — | 当前本地内容 |
| 「使用云端」 | — | — | server_content | server_content（同时写回本地文件） |

自动合并复用 `flowix-core::text_merge::merge_markdown`：保守策略（`Merged | Conflict | Unsupported`），冲突永不写标记进原文件——与「静默解决必须零信息损失」的要求一致。`Unsupported`（如非 UTF-8）按 `Conflict` 处理进 UI。

服务端配合语义（现成，无需改动）：

- hard protection 检查 `!IsConflictResolved` 才拦截（`ws_note.go:140`）→ resolved=true 直写。
- resolved=true 写入后广播含发起端（`isExcludeSelf=false`，`ws_note.go:177-181`）→ 所有设备立即收敛。

### 3.5 与 pull / 实时广播的交互

- **挂起期间对端已解决**：本端 pending 中的 path 收到 `NoteSyncModify` 广播或下轮 pull 的 Modify。处理规则：若 `server_hash == 记录的 server_hash` 说明远端没变化（就是那份内容），不动；若不同，说明另一端已解决并写入新版本 → 自动清除本端 pending（对方的解决结果即权威版本），UI 撤条目。
- **listener 链路不变**：广播仍只触发防抖调度，不直接应用（`listener.rs:7-9` 既有原则），冲突处理统一走同步循环。

### 3.6 UI：冲突中心

- **入口**：状态栏徽标（pending 数量）+ 同步历史条目；主窗口内冲突中心列表（path、检测时间、来源设备）。
- **每条操作**：使用我的 / 使用云端 / 智能合并 / 打开临时对比笔记（把 server/base/local 三个版本生成只读临时笔记供查阅，v2 可升级为编辑器内 diff 视图）。
- **批量**：全部智能合并（逐条跑 §3.4 管线，失败的留列表）。
- 前端触点：`fns_sync/commands.rs` 暴露 `fns_conflict_list / fns_conflict_resolve / fns_conflict_dismiss` IPC；`flowix-web/platform/tauri/client/fns.ts` 封装。

### 3.7 存量 `.conflict.` 文件

新管线关闭生产源后，存量副本（`*.conflict.<14位时间戳>.*`）处理（PR3 实现为按命名模式识别，未做 memo property 打标——清理按命名匹配即可覆盖，避免为每个副本写属性的写放大）：

1. `fns_legacy_conflict_copies` 按命名模式（`.conflict.` + 14 位数字 + 结尾或扩展点）列出存量副本；同步面板在有副本时显示「历史冲突副本（N）」区块。
2. `fns_cleanup_legacy_conflict_copies` 一键删除全部本地副本（经 `MemoFileStore` 正式删除），并自动调度一次同步，让删除以 tombstone 传播到服务端与其他设备。

## 4. 为什么不用其他方案

| 备选 | 否决理由 |
|---|---|
| 维持 `NewTimeMerge`，客户端事后清理副本 | 生产源常开：副本持续产生、原笔记被强制合并污染、广播放大到全设备；清理永远追不上生产 |
| 服务端 `manualMerge` + 每次冲突弹模态框打断用户 | 手机/多设备场景 530 可能成批出现，模态打断不可接受；自动优先 + 徽标汇总更合理 |
| 服务端增加数字版本号/向量时钟做 CRDT 式合并 | 协议、存储、多端全链路重构；笔记场景 Markdown 行级三方合并已够，收益不抵成本 |
| 客户端把 base content 随 push 上传以补齐服务端历史缺口 | 需要改服务端协议与历史表；且 §5 的退化路径已可接受，v1 不做 |

## 5. 边界与开放问题

1. **baseContent 缺失**：服务端历史查不到 baseHash 时，530 payload 的 `base_content` 退化为服务端当前内容（`ws_note.go:148-150, 280-288`）。此时三方合并退化为「remote 当 base」→ 几乎必然 `Conflict` → 进 UI。可接受：`manualMerge` 下 530 本身低频。可选服务端增强见 §6。
2. **删除冲突**（本地删、他端改）：`NoteDelete` 链路的服务端冲突语义本次未深查。v1 先按「删除前比对本地快照 hash 与服务端 hash，不一致则转 pending conflict 进 UI（动作：保留云端副本 / 确认删除）」，复用同一状态机。
3. **附件冲突**：`FileSync` 链路二进制无法三方合并，维持现状（新者胜），冲突中心仅提示。独立跟进。
4. **多设备同时挂起**：A、B 同时对同一路径 pending。A 解决推送后，B 按 §3.5 自动消解；若 B 此后也有新本地改动，B 的改动会作为普通增量正常推走。
5. **引擎崩溃恢复**：pending 记录已持久化；重启后同步循环按 §3.3 继续 skip + UI 继续展示，无额外恢复逻辑。

## 6. 服务端可选增强（独立 PR，非阻塞）

| 项 | 动机 | 改动点 |
|---|---|---|
| 历史快照即时化（modify 时同步写 history） | 消除 baseContent 20-30s 缺口，提高自动合并成功率 | `note_service.go` ModifyOrCreate 后追加 history 写入 |
| `ConflictDetected` 广播事件 | 非触发端也能感知冲突（当前 530 只发给触发连接） | `ws_note.go` 530 处加 `BroadcastResponse`，`action.go` 加事件常量 |
| `CreateConflictFile` 路径碰撞后缀 | 同秒同路径双端产副本时覆盖（manualMerge 下不触发，纯防御） | `conflict_service.go:114-119` |

## 7. 实施拆分

| PR | 内容 | 依赖 |
|---|---|---|
| PR1 ✅ | `flowix-fns`：`is_conflict_resolved` 参数化 + `SyncState.pending_conflicts` + `.flowix/conflicts/` 存储 + engine 状态机（skip/快照排除/自愈/530/自动解决）+ 单测 | — |
| PR2 ✅ | 桌面层：IPC 命令（list/resolve/dismiss）+ 同步面板冲突中心（keepLocal/keepRemote/merge/忽略）+ 同步结果 toast 计数 | PR1 |
| PR3 ✅ | 策略切 `manualMerge`（config 文件可配，默认 manual，不进 UI）+ 存量副本按命名模式列出与一键清理 | PR1 |
| PR4（可选，另一仓库） | 服务端 §6 增强 | — |

## 8. 测试要点

- engine 单测：530→pending 持久化；同 path 重复 530 刷新不重复；pending 期间 need_push 被 skip（防循环断言：N 轮同步 push 次数不增）；auto-merge 成功→resolved=true 重推→pending 清除→快照推进；resolve 后 ack 失败→pending 保留可重试。
- `text_merge` 集成：base 缺失退化路径；二进制 `Unsupported`。
- 服务端契约（已有）：`ws_note_conflict_notify_test.go` 530 契约不回归。
- 手工场景清单：双端离线各改同一段 / 各改不同段（应静默合并）/ 一端删一端改 / 挂起期间他端解决 / 冲突期间继续编辑。
