// Shared async loader that turns stored noteReference attrs into preview data
// (title / body preview / cover / full rendered content). Used by the inline
// note-reference NodeView, the block note-reference card, and the hover
// preview popover.
import type { JSONContent } from '@tiptap/core';

import { notes as notesClient } from '@platform/tauri/client';
import type { NoteEntry } from '@platform/tauri/client/notes';
import { useNoteStore } from '@features/memo/store/note-store';
import { joinNotebookMemoPath } from '@/lib/path';
import { displayTitleFromFilename } from '@/lib/utils';
import { parseMarkdownInWorker } from '@features/editor/markdown-parser';
import { parseNoteMarkdown, renderNoteContentHtml } from '@features/editor/read-only/render-note-content';
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

/** 卡片摘要纯文本的最大长度 (显示层还有 line-clamp, 这里只防超长文档). */
const EXCERPT_MAX_CHARS = 400;

/** 块级节点: 提取纯文本时前后补换行; 媒体节点不产生文本. */
const PLAIN_TEXT_BLOCK_TYPES = new Set([
  'paragraph', 'heading', 'codeBlock', 'blockquote', 'callout', 'toggle',
  'listItem', 'taskItem', 'bulletList', 'orderedList', 'taskList',
  'table', 'tableRow', 'tableCell', 'tableHeader', 'mathBlock',
  'horizontalRule', 'webCard', 'noteReferenceBlock', 'agentThreadCard', 'columns', 'column',
]);

function collectPlainText(node: JSONContent, out: string[]): void {
  if (node.type === 'text') {
    out.push(node.text ?? '');
    return;
  }
  if (node.type === 'hardBreak') {
    out.push('\n');
    return;
  }
  // 图片/视频等媒体不进纯文本摘要.
  if (node.type === 'image' || node.type === 'videoAttachment' || node.type === 'attachment') return;
  const isBlock = PLAIN_TEXT_BLOCK_TYPES.has(node.type ?? '');
  if (isBlock && out.length > 0 && !out[out.length - 1].endsWith('\n')) out.push('\n');
  for (const child of Array.isArray(node.content) ? node.content : []) collectPlainText(child, out);
  if (isBlock) out.push('\n');
}

/** 把渲染后的笔记 JSON 拍平成可读纯文本 (用于卡片摘要, 天然不带 markdown 符号). */
export function jsonToPlainText(json: JSONContent | null | undefined): string {
  if (!json) return '';
  const out: string[] = [];
  for (const block of Array.isArray(json.content) ? json.content : []) collectPlainText(block, out);
  // 卡片摘要逐行展示, 块级节点叠加产生的连续换行折叠为单换行.
  return out.join('').replace(/\n{2,}/g, '\n').trim().slice(0, EXCERPT_MAX_CHARS);
}

async function parseNoteMarkdownBestEffort(markdown: string): Promise<JSONContent | null> {
  try {
    const reply = await parseMarkdownInWorker(markdown);
    return reply.document ?? null;
  } catch {
    // jsdom / worker 不可用时退回主线程解析.
    try {
      return parseNoteMarkdown(markdown);
    } catch {
      return null;
    }
  }
}

/**
 * Resolve note locator attrs to a preview payload: locator fields, cover,
 * icon, a readable plain-text excerpt, and the full note rendered to
 * read-only HTML (the hover popover mounts it for scrollable preview).
 * Returns `null` when the target cannot be located (caller renders a
 * title-only / unavailable state).
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

  // 索引偶发抖动 (IPC 竞态 / 索引未就绪) 会丢掉封面与标题, 抛错时重试一次;
  // 返回 null 表示索引里确实没有这篇笔记, 不重试.
  let entry: NoteEntry | null = null;
  try {
    entry = await notesClient.getIndexed(notebookId, relativePath);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      entry = await notesClient.getIndexed(notebookId, relativePath);
    } catch { /* 保留 attrs 标题与占位封面. */ }
  }

  // 全文渲染: 摘要取自渲染后的纯文本 (天然不带 markdown/callout 源码符号,
  // 首行是特殊块也能出文字), 完整 HTML 供悬浮预览滚动阅读.
  let previewText = '';
  let contentHtml = '';
  const content = await notesClient.readDocument(filePath).catch(() => null);
  if (content) {
    const parsed = await parseNoteMarkdownBestEffort(content);
    if (parsed) {
      previewText = jsonToPlainText(parsed);
      try {
        contentHtml = renderNoteContentHtml(parsed, { notebookPath });
      } catch { /* 摘要仍可用; 弹窗退回纯文本展示. */ }
    }
  }
  if (!previewText) {
    // 全文不可得时退回索引摘要 (仍清洗一轮结构标记).
    previewText = sanitizeNotePreviewText(entry?.preview ?? '');
  }

  const data: NoteReferencePreviewData = {
    title: entry?.title || noteReferenceDisplayTitle(attrs) || fallbackTitle,
    preview: previewText,
    contentHtml,
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
