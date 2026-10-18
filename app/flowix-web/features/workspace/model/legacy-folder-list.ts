/** Shape persisted by the removed standalone folder-list workspace surface. */
export type LegacyFolderListScope = {
  kind: 'folder';
  path: string;
  notebookPath: string;
  notebookId: string | null;
};

export type LegacyFolderListFilters = {
  resourceKinds?: string[];
  tags?: string[];
  customFilterId?: string;
};

/** Read only at persistence and history boundaries; never a renderable target. */
export type LegacyFolderListTarget = {
  kind: 'document-list';
  displayId: string;
  scope: LegacyFolderListScope;
  filters: LegacyFolderListFilters;
};
