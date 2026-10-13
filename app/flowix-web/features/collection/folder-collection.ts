import { createTableDocument, serializeTableDocument } from '@features/multidimensional-table/public/create-api';
import { createMediaLibrary, serializeMediaLibrary } from '@features/media-library/model';
import { parseCollectionDocumentV2, serializeCollectionDocumentV2, type CollectionType } from './model';
import { externalDocuments } from '@platform/tauri/client';
import { canonicalPath } from '@/lib/path';

export function createFolderCollectionContent(kind: 'notes' | 'media', folderName: string): string {
  if (kind === 'notes') {
    const document = createTableDocument('table', folderName, 'folder');
    document.dataset.source = { scope: 'containing_folder', depth: 'descendants' };
    document.dataset.filter = { all: [{ field: 'kind', op: 'eq', value: 'note' }], any: [] };
    return serializeTableDocument(document);
  }

  const document = createMediaLibrary(folderName);
  document.collection.placement = 'folder';
  document.dataset.source = { scope: 'containing_folder', depth: 'descendants' };
  return serializeMediaLibrary(document);
}

export async function switchFolderCollectionType(filePath: string, notebookPath: string, type: CollectionType): Promise<string> {
  const source = await externalDocuments.read(filePath, notebookPath);
  const current = parseCollectionDocumentV2(source);
  if (current.collection.placement !== 'folder' || !canonicalPath(filePath).endsWith('/.index.yaml')) {
    throw new Error('仅文件夹集合支持切换视图类型');
  }
  if (current.collection.type === type) return current.collection.id;
  const template = parseCollectionDocumentV2(createFolderCollectionContent(type === 'table' ? 'notes' : 'media', current.collection.name));
  const next = {
    ...template.collection,
    id: current.collection.id,
    name: current.collection.name,
    revision: current.collection.revision + 1,
    created_at: current.collection.created_at,
    updated_at: new Date().toISOString(),
    properties: current.collection.properties,
  };
  const result = await externalDocuments.write({
    filePath, scopePath: notebookPath, expectedContent: source,
    content: serializeCollectionDocumentV2({ ...template, collection: next }),
  });
  if (result.status !== 'saved') throw new Error('集合文件已变化，请重试');
  return next.id;
}
