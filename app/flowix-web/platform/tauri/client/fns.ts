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

export type FnsConflictAction = 'keepLocal' | 'keepRemote' | 'merge';

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
  resolveConflict: (notebookId: string, path: string, action: FnsConflictAction) =>
    invoke<void>('fns_conflict_resolve', { notebookId, path, action }),
  dismissConflict: (notebookId: string, path: string) =>
    invoke<void>('fns_conflict_dismiss', { notebookId, path }),
};
