// Shared async loader that turns stored noteReference attrs into preview data
// (title / body preview / cover). Used by the inline note-reference NodeView,
// the block note-reference card, and the hover preview popover.
import { notes as notesClient } from '@platform/tauri/client';
import type { NoteEntry } from '@platform/tauri/client/notes';
import { useNoteStore } from '@features/memo/store/note-store';
import { joinNotebookMemoPath } from '@/lib/path';
import { displayTitleFromFilename } from '@/lib/utils';
import { stripMdSuffix } from '@features/editor/extensions/note-link/markdown';
import type { NoteReferencePreviewData } from '@features/editor/extensions/note-link/note-reference-preview-controller';
import type { NoteReferenceAttrs } from './note-reference-markdown';

export function noteReferenceDisplayTitle(attrs: NoteReferenceAttrs): string {
  if (attrs.relativePath) return displayTitleFromFilename(attrs.relativePath);
  if (attrs.linkTarget?.startsWith('flowix://open?')) {
    try {
      const url = new URL(attrs.linkTarget);
      const file = url.searchParams.get('f') ?? url.searchParams.get('file') ?? url.searchParams.get('relativePath') ?? url.searchParams.get('path');
      if (file) return displayTitleFromFilename(file);
    } catch { /* Keep the authored label for malformed links. */ }
  }
  if (attrs.originalPath) return displayTitleFromFilename(attrs.originalPath);
  return stripMdSuffix(attrs.title || '');
}

/**
 * 索引生成的摘要保留原始 markdown 源码 (callout 栅栏、标题/列表标记、
 * 行内符号等), 直接渲染到卡片/悬浮预览会出现 "::: callout icon=…" 这类
 * 噪音。这里做轻量清洗: 丢弃结构性标记行, 剥掉常见行内符号, 只留可读文本。
 */
export function sanitizeNotePreviewText(raw: string): string {
  if (!raw) return '';
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    // 结构性标记行整行丢弃: callout/toggle/列栅栏、::webcard 等块标记、
    // HTML 注释、frontmatter 边界与主题分隔线。
    if (!trimmed || /^:::/.test(trimmed) || /^::[a-z-]+\s*[{[]/i.test(trimmed) || /^<!--/.test(trimmed) || /^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      continue;
    }
    let cleaned = line;
    cleaned = cleaned.replace(/^\s{0,3}#{1,6}\s+/, ''); // 标题
    cleaned = cleaned.replace(/^\s{0,3}>\s?/, ''); // 引用
    cleaned = cleaned.replace(/^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, ''); // 列表 / 任务
    cleaned = cleaned.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1'); // 图片 → alt 文本
    cleaned = cleaned.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // 链接 → 链接文字
    cleaned = cleaned.replace(/`{1,3}([^`]*)`{1,3}/g, '$1'); // 行内代码
    cleaned = cleaned.replace(/\*\*|__|~~/g, ''); // 加粗 / 斜体 / 删除线标记
    kept.push(cleaned.trimEnd());
  }
  return kept.join('\n').replace(/\n{2,}/g, '\n').trim();
}

/**
 * Resolve note locator attrs to a preview payload. Returns `null` when the
 * target cannot be located (caller renders a title-only / unavailable state).
 */
export async function loadNoteReferencePreviewData(
  attrs: NoteReferenceAttrs,
  fallbackTitle = '',
): Promise<NoteReferencePreviewData | null> {
  let notebookId = attrs.notebookId;
  let relativePath = attrs.relativePath ?? null;
  let notebookPath: string | null = null;
  let physicalPath = attrs.originalPath;
  let notebookName = attrs.notebookName;

  if (attrs.linkTarget && /^flowix:\/\/open\?/i.test(attrs.linkTarget)) {
    try {
      const url = new URL(attrs.linkTarget);
      notebookId ||= url.searchParams.get('notebookId');
      relativePath ||= url.searchParams.get('f') ?? url.searchParams.get('file') ?? url.searchParams.get('relativePath');
      notebookName ||= url.searchParams.get('b') ?? url.searchParams.get('book') ?? '';
      physicalPath ||= url.searchParams.get('path');
    } catch { /* Keep the authored attrs as fallback. */ }
  } else if (!physicalPath && attrs.linkTarget && /^\//.test(attrs.linkTarget)) {
    physicalPath = attrs.linkTarget;
  }

  if ((!notebookId || !relativePath) && physicalPath) {
    try {
      const location = await notesClient.resolveLocation(physicalPath);
      notebookId ||= location?.notebookId;
      relativePath ||= location?.relativePath;
      notebookPath = location?.notebookPath ?? null;
    } catch { /* A missing note still gets a title-only preview. */ }
  }

  if (!notebookId && relativePath && notebookName) {
    let notebooks = useNoteStore.getState().notebooks;
    if (!notebooks.length) {
      await useNoteStore.getState().loadNotebooks();
      notebooks = useNoteStore.getState().notebooks;
    }
    const matches = notebooks.filter((item) => item.name === notebookName);
    if (matches.length === 1) notebookId = matches[0].id;
  }

  if (!notebookId || !relativePath) {
    return null;
  }

  let notebook = useNoteStore.getState().notebooks.find((item) => item.id === notebookId);
  if (!notebook) {
    await useNoteStore.getState().loadNotebooks();
    notebook = useNoteStore.getState().notebooks.find((item) => item.id === notebookId);
  }
  notebookPath ||= notebook?.path ?? null;
  const filePath = notebookPath ? joinNotebookMemoPath(notebookPath, relativePath) : null;
  if (!notebookPath || !filePath) {
    return null;
  }

  let entry: NoteEntry | null = null;
  try {
    entry = await notesClient.getIndexed(notebookId, relativePath);
  } catch { /* Render the saved reference title if the index is unavailable. */ }

  const data: NoteReferencePreviewData = {
    title: entry?.title || noteReferenceDisplayTitle(attrs) || fallbackTitle,
    preview: sanitizeNotePreviewText(entry?.preview ?? ''),
    thumbnail: entry?.cover ?? entry?.thumbnail ?? null,
    icon: entry?.icon ?? null,
    notebookId,
    relativePath,
    notebookPath,
    filePath,
  };
  return data;
}

/** True when the referenced note no longer resolves on this device. */
export async function isNoteReferenceStale(attrs: NoteReferenceAttrs): Promise<boolean> {
  try {
    const relativePath = attrs.relativePath;
    if (attrs.notebookId && relativePath) {
      let notebook = useNoteStore.getState().notebooks.find((item) => item.id === attrs.notebookId);
      if (!notebook) {
        await useNoteStore.getState().loadNotebooks();
        notebook = useNoteStore.getState().notebooks.find((item) => item.id === attrs.notebookId);
      }
      if (!notebook) return true;
      const path = joinNotebookMemoPath(notebook.path, relativePath);
      if (!path) return true;
      const content = await notesClient.readDocument(path);
      return content === null;
    }
    if (attrs.originalPath) {
      return await notesClient.readDocument(attrs.originalPath) === null;
    }
  } catch {
    return true;
  }
  return false;
}

/** Re-validate a mounted reference and write `stale` back into the doc. */
export function refreshNoteReferenceStale(
  attrs: NoteReferenceAttrs,
  applyAttrs: (patch: Partial<NoteReferenceAttrs>) => void,
): Promise<void> {
  return isNoteReferenceStale(attrs).then((stale) => {
    if (stale !== attrs.stale) applyAttrs({ stale });
  }).catch(() => { /* Background validation; ignore transient IPC errors. */ });
}

export type { NoteReferencePreviewData };
