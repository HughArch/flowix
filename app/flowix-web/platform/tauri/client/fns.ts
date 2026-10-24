import { invoke } from '@tauri-apps/api/core';

export interface FnsConfigView {
  enabled: boolean;
  api: string;
  /** The token itself never leaves the backend. */
  hasToken: boolean;
  clientName: string;
  clientVersion: string;
  clientType: string;
  /** Attachments larger than this are not synced (0 disables attachment sync). */
  maxAttachmentBytes: number;
  configured: boolean;
}

export interface FnsConfigPatch {
  enabled?: boolean;
  api?: string;
  /** Empty string keeps the stored token. */
  token?: string;
  clientName?: string;
  clientType?: string;
  maxAttachmentBytes?: number;
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
  lastTime: number;
}

export const fns = {
  getConfig: () => invoke<FnsConfigView>('fns_get_config'),
  patchConfig: (patch: FnsConfigPatch) =>
    invoke<FnsConfigView>('fns_patch_config', { patch }),
  getStatus: () => invoke<FnsSyncStatus>('fns_get_status'),
  syncNotebook: (notebookId: string) =>
    invoke<FnsNotebookSyncOutcome | null>('fns_sync_notebook', { notebookId }),
  syncAll: () => invoke<FnsNotebookSyncOutcome[]>('fns_sync_all'),
};
