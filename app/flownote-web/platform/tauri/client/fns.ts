import { invoke } from '@tauri-apps/api/core';

export interface FnsTokenView {
  id: string;
  label: string;
  /** The token itself never leaves the backend. */
  hasToken: boolean;
}

export interface FnsConfigView {
  enabled: boolean;
  api: string;
  /** Attachments larger than this are not synced (0 disables attachment sync). */
  maxAttachmentBytes: number;
  /** Seconds to wait after startup before the first sync (0 disables it). */
  startupSyncDelaySeconds: number;
  /** Stop retrying after this many consecutive failures (0 disables retries). */
  maxRetryAttempts: number;
  tokens: FnsTokenView[];
  configured: boolean;
}

export interface FnsConfigPatch {
  enabled?: boolean;
  api?: string;
  maxAttachmentBytes?: number;
  startupSyncDelaySeconds?: number;
  maxRetryAttempts?: number;
}

export interface FnsTokenInput {
  id?: string;
  label: string;
  /** Empty keeps the stored secret when `id` is set. */
  token?: string;
}

export type FnsSyncPhase = 'scanning' | 'notesPull' | 'notesPush' | 'filesPull' | 'filesPush';

export interface FnsSyncProgress {
  phase: FnsSyncPhase;
  total: number;
  completed: number;
  currentPath: string | null;
}

export interface FnsSyncStatus {
  running: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  lastPulled: number;
  lastPushed: number;
  consecutiveFailures: number;
  /** Epoch ms of the next scheduled retry, when one is pending. */
  nextRetryAt: number | null;
  /** Notebook the current/last status belongs to. */
  notebookId: string | null;
  /** Live progress while a sync runs. */
  progress: FnsSyncProgress | null;
}

export interface FnsSyncRecord {
  at: number;
  notebookId: string;
  vault: string;
  ok: boolean;
  pulled: number;
  pushed: number;
  filesPulled: number;
  filesPushed: number;
  deletedLocal: number;
  durationMs: number;
  error: string | null;
}

export interface FnsNotebookState {
  notebookId: string;
  bound: boolean;
  vault: string;
  tokenId: string;
  tokenLabel: string | null;
  status: FnsSyncStatus;
  history: FnsSyncRecord[];
}

export interface FnsNotebookSyncOutcome {
  notebookId: string;
  vault: string;
  pulled: number;
  pushed: number;
  deletedLocal: number;
  renamed: number;
  filesPulled: number;
  filesPushed: number;
  conflicts: string[];
  /** Conflicts settled automatically during this run. */
  conflictsAutoResolved: number;
  lastTime: number;
}

export interface FnsConflictView {
  path: string;
  /** Epoch ms of the latest detection. */
  detectedAt: number;
  /** Whether a clean automatic merge is plausible. */
  mergeable: boolean;
}

export interface FnsConflictDetail {
  path: string;
  detectedAt: number;
  mergeable: boolean;
  /** Current local file content (may be newer than at detection time). */
  localContent: string;
  /** Content the server held when the push was rejected. */
  serverContent: string;
  /** Content both sides diverged from. */
  baseContent: string;
}

export type FnsConflictAction = 'keepLocal' | 'keepRemote' | 'merge';

/** 一条笔记分享的当前状态 (URL 已由 Rust 侧拼好)。契约见 docs/NOTE-SHARE-CLOUD.md §3。 */
export interface FnsShareView {
  /** 笔记 (或文件) 表 ID, 分享页 URL 的 `/{id}` 段。 */
  id: number;
  /** `note` | `file`。 */
  shareType: 'note' | 'file' | string;
  token: string;
  isPassword: boolean;
  /** Go time.Time RFC3339 字符串; 零值 = 永久。 */
  expiresAt: string;
  shortLink: string;
  baseUrl: string;
  shareUrl: string;
}

/** 创建/改密码的有效期档位, `0` = 永久。 */
export const FNS_SHARE_EXPIRY_OPTIONS = [
  { value: 0, i18nKey: 'share.expiry.never' },
  { value: 86400, i18nKey: 'share.expiry.oneDay' },
  { value: 604800, i18nKey: 'share.expiry.sevenDays' },
  { value: 2592000, i18nKey: 'share.expiry.thirtyDays' },
] as const;

/** 一条云端笔记版本的元数据 (不含正文), 来自 FNS `note_history`。 */
export interface FnsCloudVersionMeta {
  historyId: number;
  /** 服务端笔记内递增版本号。 */
  version: number;
  createdAtMs: number;
  clientName: string;
  clientType: string;
  clientVersion: string;
  path: string;
}

/** 云端版本列表页。`notSynced` = 服务端查无此笔记 (从未同步过)。 */
export type FnsCloudHistoryPage =
  | { status: 'ok'; items: FnsCloudVersionMeta[]; total: number; hasMore: boolean }
  | { status: 'notSynced' };

export const fns = {
  getConfig: () => invoke<FnsConfigView>('fns_get_config'),
  patchConfig: (patch: FnsConfigPatch) =>
    invoke<FnsConfigView>('fns_patch_config', { patch }),
  upsertToken: (input: FnsTokenInput) =>
    invoke<FnsConfigView>('fns_upsert_token', { input }),
  deleteToken: (id: string) => invoke<FnsConfigView>('fns_delete_token', { id }),
  getStatus: () => invoke<FnsSyncStatus>('fns_get_status'),
  getHistory: (notebookId?: string) =>
    invoke<FnsSyncRecord[]>('fns_get_history', { notebookId }),
  getNotebookState: (notebookId: string) =>
    invoke<FnsNotebookState>('fns_get_notebook_state', { notebookId }),
  bindNotebook: (notebookId: string, tokenId: string, vault: string) =>
    invoke<FnsNotebookState>('fns_bind_notebook', { notebookId, tokenId, vault }),
  unbindNotebook: (notebookId: string) =>
    invoke<void>('fns_unbind_notebook', { notebookId }),
  syncNotebook: (notebookId: string) =>
    invoke<FnsNotebookSyncOutcome | null>('fns_sync_notebook', { notebookId }),
  syncAll: () => invoke<FnsNotebookSyncOutcome[]>('fns_sync_all'),
  /** Foreground return: debounced pull for bound notebooks. */
  scheduleFocusSync: () => invoke<void>('fns_schedule_focus_sync'),
  listConflicts: (notebookId: string) =>
    invoke<FnsConflictView[]>('fns_conflict_list', { notebookId }),
  getConflictDetail: (notebookId: string, path: string) =>
    invoke<FnsConflictDetail>('fns_conflict_detail', { notebookId, path }),
  resolveConflict: (notebookId: string, path: string, action: FnsConflictAction) =>
    invoke<void>('fns_conflict_resolve', { notebookId, path, action }),
  dismissConflict: (notebookId: string, path: string) =>
    invoke<void>('fns_conflict_dismiss', { notebookId, path }),
  /** Server-written `*.conflict.<timestamp>` copies from old force-merges. */
  listLegacyConflictCopies: (notebookId: string) =>
    invoke<string[]>('fns_legacy_conflict_copies', { notebookId }),
  cleanupLegacyConflictCopies: (notebookId: string) =>
    invoke<number>('fns_cleanup_legacy_conflict_copies', { notebookId }),
  /** `...` 菜单云端历史入口的门控: notebook 已绑定 FNS 且凭据齐备。 */
  cloudHistoryAvailable: (notebookId: string) =>
    invoke<boolean>('fns_cloud_history_available', { notebookId }),
  listNoteHistory: (notebookId: string, relativePath: string, page = 1, pageSize = 20) =>
    invoke<FnsCloudHistoryPage>('fns_note_history_list', { notebookId, relativePath, page, pageSize }),
  /** 拉取并重建某云端版本修改后的完整正文。 */
  noteHistoryContent: (notebookId: string, relativePath: string, historyId: number) =>
    invoke<string>('fns_note_history_content', { notebookId, relativePath, historyId }),
  /** `...` 菜单分享入口的门控: notebook 已绑定 FNS 且凭据齐备。 */
  shareAvailable: (notebookId: string) =>
    invoke<boolean>('fns_share_available', { notebookId }),
  /** 创建分享 (服务端幂等: 同资源已有 active 分享先撤销再建)。`expireAtSec` 0/缺省 = 永久。 */
  shareCreate: (notebookId: string, relativePath: string, password?: string, expireAtSec?: number) =>
    invoke<FnsShareView>('fns_share_create', { notebookId, relativePath, password, expireAtSec }),
  /** 查询当前分享; 无 active 分享返回 `null`。 */
  shareQuery: (notebookId: string, relativePath: string) =>
    invoke<FnsShareView | null>('fns_share_query', { notebookId, relativePath }),
  /** 取消 (撤销) 分享。外部分享链接随即失效, 不可恢复。 */
  shareCancel: (notebookId: string, relativePath: string) =>
    invoke<void>('fns_share_cancel', { notebookId, relativePath }),
  /** 更新分享密码与过期时间 (`password` 传空串 = 去掉密码)。 */
  sharePassword: (notebookId: string, relativePath: string, password?: string, expireAtSec?: number) =>
    invoke<void>('fns_share_password', { notebookId, relativePath, password, expireAtSec }),
  /** vault 内所有 active 分享的笔记路径 (预留: 列表角标)。 */
  sharePaths: (notebookId: string) =>
    invoke<string[]>('fns_share_paths', { notebookId }),
};
