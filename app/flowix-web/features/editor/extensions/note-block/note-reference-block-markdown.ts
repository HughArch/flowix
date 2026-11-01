// Markdown form of the block-level note reference:
//   ::notecard{"notebookId":"…","relativePath":"…",…,"layout":"card"}
// A fenced JSON payload keeps every locator field (and the layout switch)
// lossless across round-trips, mirroring the `::webcard` block convention.
import { Extension, type MarkdownToken } from '@tiptap/core';
import { boundedIndexOf } from '@features/editor/markdown-tokenizer-start';

export type NoteReferenceBlockLayout = 'line' | 'card' | 'cardLarge';

export interface NoteReferenceBlockAttrs {
  notebookId: string | null;
  relativePath: string | null;
  notebookName: string;
  title: string;
  originalPath: string | null;
  linkStyle: 'flowix' | 'wiki' | 'markdown';
  linkTarget: string | null;
  heading: string | null;
  stale: boolean;
  layout: NoteReferenceBlockLayout;
  /** 卡片填充色 (NoteColor 小写串; 空串 = 不填充). */
  color: string;
  /** 自定义展示文字: 覆盖卡片摘要 (笔记首行); 空串 = 使用首行. */
  customText: string;
}

export const DEFAULT_NOTE_BLOCK_LAYOUT: NoteReferenceBlockLayout = 'card';

export const NOTE_BLOCK_MARKER = '::notecard';

const NOTE_BLOCK_RE = /^::notecard\s*(\{[\s\S]*?\})(?:\n|$)/;
const LAYOUTS: readonly NoteReferenceBlockLayout[] = ['line', 'card', 'cardLarge'];

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeNullableText(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function normalizeNoteBlockLayout(value: unknown): NoteReferenceBlockLayout {
  return LAYOUTS.includes(value as NoteReferenceBlockLayout)
    ? value as NoteReferenceBlockLayout
    : DEFAULT_NOTE_BLOCK_LAYOUT;
}

export function normalizeNoteBlockAttrs(attrs: Partial<NoteReferenceBlockAttrs> | null | undefined): NoteReferenceBlockAttrs {
  const linkStyle = attrs?.linkStyle === 'wiki' || attrs?.linkStyle === 'markdown'
    ? attrs.linkStyle
    : 'flowix';
  return {
    notebookId: normalizeNullableText(attrs?.notebookId),
    relativePath: normalizeNullableText(attrs?.relativePath),
    notebookName: normalizeText(attrs?.notebookName),
    title: normalizeText(attrs?.title),
    originalPath: normalizeNullableText(attrs?.originalPath),
    linkStyle,
    linkTarget: normalizeNullableText(attrs?.linkTarget),
    heading: normalizeNullableText(attrs?.heading),
    stale: attrs?.stale === true,
    layout: normalizeNoteBlockLayout(attrs?.layout),
    color: normalizeText(attrs?.color),
    customText: normalizeText(attrs?.customText),
  };
}

export const noteReferenceBlockMarkdownSpec = {
  markdownTokenizer: {
    name: 'noteReferenceBlock',
    level: 'block' as const,
    start(src: string) {
      return boundedIndexOf(src, NOTE_BLOCK_MARKER);
    },
    tokenize(src: string) {
      const match = NOTE_BLOCK_RE.exec(src);
      return match ? { type: 'noteReferenceBlock', raw: match[0], text: match[1] } : undefined;
    },
  },
  parseMarkdown(token: MarkdownToken) {
    try {
      return { type: 'noteReferenceBlock', attrs: normalizeNoteBlockAttrs(JSON.parse(token.text ?? '')) };
    } catch {
      return { type: 'noteReferenceBlock', attrs: normalizeNoteBlockAttrs(null) };
    }
  },
};

export const NoteReferenceBlockMarkdownExtension = Extension.create({
  name: 'noteReferenceBlock',
  ...noteReferenceBlockMarkdownSpec,
});
