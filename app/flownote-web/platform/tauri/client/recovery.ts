import { invoke } from '@tauri-apps/api/core';

export const recoveryDrafts = {
  write: (identityKey: string, draft: unknown) =>
    invoke<boolean>('write_recovery_draft', { identityKey, draft }),
  read: <T>(identityKey: string) =>
    invoke<T | null>('read_recovery_draft', { identityKey }),
  clearThrough: (identityKey: string, savedRevision: number) =>
    invoke<boolean>('clear_recovery_draft_through', { identityKey, savedRevision }),
  list: <T>() => invoke<T[]>('list_recovery_drafts'),
};
