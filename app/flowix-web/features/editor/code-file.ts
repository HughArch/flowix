import {
  fileExtension,
  isMarkdownFilePath,
  isEditableTextFilePath,
  isImageFilePath,
  isVideoFilePath,
  isHtmlFilePath,
  isTextMimeType,
} from '@features/content/model/content-kind';

export {
  fileExtension,
  isMarkdownFilePath,
  isCodeTextFilePath,
  isEditableTextFilePath,
  isImageFilePath,
  isVideoFilePath,
  isHtmlFilePath,
  isNotebookResourcePath,
  resourceKindFromPath,
} from '@features/content/model/content-kind';

export type { ResourceKind } from '@features/content/model/content-kind';

export type ExternalFileViewKind = 'code' | 'csv' | 'markdown' | 'image' | 'video' | 'html' | 'docx' | 'unavailable';

/** Renderer choice belongs to the opening Surface, separate from factual content classification. */
export function externalFileViewKind(
  path: string,
  mimeType?: string | null,
  detectedTextContent = false,
): ExternalFileViewKind {
  const extension = fileExtension(path);
  if (extension === 'docx') return 'docx';
  if (extension === 'csv') return 'csv';
  if (isImageFilePath(path)) return 'image';
  if (isVideoFilePath(path)) return 'video';
  if (isHtmlFilePath(path)) return 'html';
  if (isMarkdownFilePath(path)) return 'markdown';
  if (isEditableTextFilePath(path, mimeType) || detectedTextContent) return 'code';
  return 'unavailable';
}

/** Kept for API compatibility; classifier text MIME behavior is centralized in content-kind. */
export { isTextMimeType };
