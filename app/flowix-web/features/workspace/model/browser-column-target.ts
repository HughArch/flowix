import { contentIdentityKey, type ContentIdentity } from './surface-identity';

import type { FileBrowserTarget } from './surface-target';

export type BrowserColumnTarget =
  | {
      kind: 'folder-collection';
      folderPath: string;
      notebookId: string;
      notebookPath: string;
      folderName: string;
      viewMode?: 'work-documents';
    }
  | {
      kind: 'media';
      filePath: string;
      notebookId: string;
      notebookPath: string;
      resourceKind: 'image' | 'video';
    }
  | FileBrowserTarget
  | {
      kind: 'web';
      url: string;
    }
  | {
      kind: 'agent_conversation';
      instanceId: string;
    };


export function browserColumnTargetIdentity(target: BrowserColumnTarget): ContentIdentity {
  switch (target.kind) {
    case 'folder-collection': return { kind: 'folder-collection', notebookId: target.notebookId, folderPath: target.folderPath, viewMode: target.viewMode };
    case 'media': return { kind: 'media', path: target.filePath };
    case 'file-browser': return target.collectionDisplay ? { kind: 'collection', ...target.collectionDisplay } : target.activeFilePath
      ? { kind: 'external', path: target.activeFilePath }
      : { kind: 'file-browser', folderPath: target.folderPath ?? '' };
    case 'web': return { kind: 'web', url: target.url };
    case 'agent_conversation': return {
      kind: 'agent-conversation',
      instanceId: target.instanceId,
    };
  }
}

export function browserColumnTargetKey(target: BrowserColumnTarget): string | null {
  return contentIdentityKey(browserColumnTargetIdentity(target));
}

