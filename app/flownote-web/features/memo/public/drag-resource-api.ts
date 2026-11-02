export interface NotebookNoteDragResource {
  kind: 'note';
  notebookId: string;
  relativePath: string;
  title: string;
}

export function isMarkdownNoteDragResource(item: unknown): item is NotebookNoteDragResource {
  if (!item || typeof item !== 'object') return false;
  const resource = item as Partial<NotebookNoteDragResource>;
  return resource.kind === 'note'
    && typeof resource.notebookId === 'string'
    && typeof resource.relativePath === 'string'
    && /\.(?:md|markdown)$/i.test(resource.relativePath)
    && typeof resource.title === 'string';
}

export interface NotebookFileDragResource {
  kind: 'file';
  absolutePath: string;
  name: string;
  resourceKind?: string | null;
}

export interface NotebookFolderDragResource {
  kind: 'folder';
  absolutePath: string;
  name: string;
}

export type NotebookDragResource =
  | NotebookNoteDragResource
  | NotebookFileDragResource
  | NotebookFolderDragResource;
