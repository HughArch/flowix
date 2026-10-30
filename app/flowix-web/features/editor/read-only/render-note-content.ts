/**
 * Static read-only HTML rendering for note content.
 *
 * Pipeline: markdown -> Tiptap JSON (worker or `parseNoteMarkdown`) -> schema
 * validation -> ProseMirror DOMSerializer -> presentation pass -> HTML string.
 * No editor instance is mounted, so cost is milliseconds per note and N notes
 * on a canvas board stay cheap. The output is meant to be mounted inside a
 * `.markdown-editor > .editor-document-body > .ProseMirror` wrapper so the
 * editor stylesheet applies unchanged.
 *
 * The presentation pass covers what only exists as editor NodeViews:
 * attachment URLs (storage keys resolve against the owning notebook),
 * callout icon rails, and note-reference chips. Anything the schema does not
 * know is dropped defensively instead of failing the whole render.
 */
import type { JSONContent } from '@tiptap/core';
import { DOMSerializer } from '@tiptap/pm/model';
import type { Schema } from '@tiptap/pm/model';
import { MarkdownManager } from '@tiptap/markdown';
import { resolveAttachmentUrl } from '@features/editor/extensions/attachment-link/utils';
import { normalizeCalloutIcon } from '@features/editor/extensions/callout/callout-markdown';
import { flagAssetUrlForIcon } from '@features/editor/extensions/callout/flag-assets';
import { createMarkdownParserExtensions } from '@features/editor/markdown-parser-extensions';
import { getReadOnlyNoteSchema } from './read-only-schema';

/** Node types that never belong in a rendered body. */
const DROPPED_NODE_TYPES = new Set(['frontmatter']);

export interface NoteRenderOptions {
  /** Notebook root used to resolve notebook-relative attachment keys. */
  notebookPath?: string | null;
  /** Test seam: override attachment URL resolution. */
  resolveAttachmentUrl?: (storageKey: string, notebookPath?: string | null) => string;
}

let parserManager: MarkdownManager | null = null;

function getParserManager(): MarkdownManager {
  if (!parserManager) {
    parserManager = new MarkdownManager({
      extensions: createMarkdownParserExtensions(),
      markedOptions: { gfm: true, breaks: true },
    });
  }
  return parserManager;
}

/** Parse markdown on the calling thread; prefer `parseMarkdownInWorker` on hot paths. */
export function parseNoteMarkdown(markdown: string): JSONContent {
  return getParserManager().parse(markdown);
}

function flattenText(nodes: JSONContent[] | undefined): string {
  if (!Array.isArray(nodes)) return '';
  let text = '';
  for (const node of nodes) {
    if (typeof node.text === 'string') text += node.text;
    else if (Array.isArray(node.content)) text += flattenText(node.content);
  }
  return text;
}

function normalizeHeadingText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Top-level headings in document order, for scope pickers. */
export function listNoteHeadings(json: JSONContent): Array<{ level: number; text: string }> {
  const blocks = Array.isArray(json.content) ? json.content : [];
  const headings: Array<{ level: number; text: string }> = [];
  for (const block of blocks) {
    if (block.type !== 'heading') continue;
    const text = flattenText(block.content).trim();
    if (!text) continue;
    headings.push({ level: Number(block.attrs?.level ?? 1) || 1, text });
  }
  return headings;
}

/**
 * Content under one heading: the heading itself plus every block until the
 * next heading of the same or a higher level. Returns `null` when no heading
 * matches (callers fall back to the full note).
 */
export function sliceNoteByHeading(json: JSONContent, heading: string): JSONContent[] | null {
  const blocks = Array.isArray(json.content) ? json.content : [];
  const target = normalizeHeadingText(heading);
  if (!target) return null;
  const startIndex = blocks.findIndex((block) => (
    block.type === 'heading' && normalizeHeadingText(flattenText(block.content)) === target
  ));
  if (startIndex < 0) return null;
  const level = Number(blocks[startIndex].attrs?.level ?? 1) || 1;
  let end = blocks.length;
  for (let index = startIndex + 1; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.type !== 'heading') continue;
    const nextLevel = Number(block.attrs?.level ?? 1) || 1;
    if (nextLevel <= level) {
      end = index;
      break;
    }
  }
  return blocks.slice(startIndex, end);
}

/**
 * Drop nodes the schema does not know (or that never render) instead of
 * letting `nodeFromJSON` throw. Unknown container nodes are unwrapped so
 * their children survive a parser/schema version skew.
 */
function sanitizeBlocks(blocks: JSONContent[], schema: Schema): JSONContent[] {
  const output: JSONContent[] = [];
  for (const block of blocks) {
    if (typeof block.type !== 'string' || DROPPED_NODE_TYPES.has(block.type)) continue;
    const nodeType = schema.nodes[block.type];
    const childBlocks = Array.isArray(block.content) ? sanitizeBlocks(block.content, schema) : null;
    if (!nodeType) {
      // Unknown wrapper: keep the (sanitized) children so content survives.
      if (childBlocks) output.push(...childBlocks);
      continue;
    }
    const marks = Array.isArray(block.marks)
      ? block.marks.filter((mark) => typeof mark.type === 'string' && Boolean(schema.marks[mark.type]))
      : undefined;
    output.push({
      ...block,
      ...(marks ? { marks } : {}),
      ...(childBlocks ? { content: childBlocks } : {}),
    });
  }
  return output;
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Last-resort output when serialization itself fails: readable plain text. */
function fallbackPlainTextHtml(blocks: JSONContent[]): string {
  const paragraphs = flattenText(blocks)
    .split(/\n{2,}|\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtmlText(line)}</p>`);
  return paragraphs.join('') || '<p></p>';
}

/** The editor NodeView renders the callout icon rail; static output must match. */
function enhanceCallout(element: HTMLElement): void {
  if (element.querySelector(':scope > .flowix-callout-content')) return;
  const icon = normalizeCalloutIcon(element.getAttribute('data-icon'));
  const iconElement = document.createElement('span');
  iconElement.className = 'flowix-callout-icon';
  iconElement.setAttribute('aria-hidden', 'true');
  const flagUrl = flagAssetUrlForIcon(icon);
  if (flagUrl) {
    const image = document.createElement('img');
    image.src = flagUrl;
    image.alt = icon;
    image.draggable = false;
    iconElement.appendChild(image);
  } else {
    iconElement.textContent = icon;
  }
  const content = document.createElement('div');
  content.className = 'flowix-callout-content';
  while (element.firstChild) content.appendChild(element.firstChild);
  element.appendChild(iconElement);
  element.appendChild(content);
}

/**
 * The editor resolves attachment keys through its NodeView; static output
 * carries the raw key, so rewrite URLs against the owning notebook and make
 * images behave like lazy canvas content.
 */
function enhanceAttachments(element: HTMLElement, options: NoteRenderOptions): void {
  const resolve = options.resolveAttachmentUrl ?? resolveAttachmentUrl;
  for (const node of Array.from(element.querySelectorAll<HTMLElement>('[data-storage-key]'))) {
    const storageMode = node.getAttribute('data-storage-mode');
    if (storageMode !== 'attachment') continue;
    const storageKey = node.getAttribute('data-storage-key') ?? '';
    if (!storageKey) continue;
    const url = resolve(storageKey, options.notebookPath);
    const media = node.querySelector('img, video');
    if (media) {
      media.setAttribute('src', url);
      if (media.tagName === 'IMG') {
        media.setAttribute('loading', 'lazy');
        media.setAttribute('draggable', 'false');
      }
      continue;
    }
    const link = node.matches('a') ? node : node.querySelector('a');
    if (link) link.setAttribute('href', url);
  }
}

/** Turn legacy `<note>` serialization into a read-only reference chip. */
function enhanceNoteReferences(element: HTMLElement): void {
  for (const node of Array.from(element.querySelectorAll('note'))) {
    const source = node as HTMLElement;
    const chip = document.createElement('span');
    chip.className = 'readonly-note-ref';
    chip.setAttribute('data-note-ref', 'true');
    const notebookId = source.getAttribute('notebook') ?? '';
    const relativePath = source.getAttribute('relativepath') ?? '';
    const originalPath = source.getAttribute('path') ?? '';
    const heading = source.getAttribute('heading') ?? '';
    if (notebookId) chip.setAttribute('data-notebook-id', notebookId);
    if (relativePath) chip.setAttribute('data-relative-path', relativePath);
    if (originalPath) chip.setAttribute('data-original-path', originalPath);
    if (heading) chip.setAttribute('data-heading', heading);
    const title = document.createElement('span');
    title.className = 'readonly-note-ref__title';
    title.textContent = source.textContent ?? '';
    chip.appendChild(title);
    if (heading) {
      const headingLabel = document.createElement('span');
      headingLabel.className = 'readonly-note-ref__heading';
      headingLabel.textContent = `› ${heading}`;
      chip.appendChild(headingLabel);
    }
    node.replaceWith(chip);
  }
}

function enhanceReadOnlyHtml(element: HTMLElement, options: NoteRenderOptions): void {
  for (const callout of Array.from(element.querySelectorAll<HTMLElement>('.flowix-callout'))) enhanceCallout(callout);
  enhanceAttachments(element, options);
  enhanceNoteReferences(element);
}

/** Render a parsed note document (or a sliced section) to static HTML. */
export function renderNoteContentHtml(json: JSONContent, options: NoteRenderOptions = {}): string {
  const schema = getReadOnlyNoteSchema();
  const blocks = sanitizeBlocks(Array.isArray(json.content) ? json.content : [json], schema);
  try {
    const doc = schema.nodeFromJSON({ type: 'doc', content: blocks });
    const serializer = DOMSerializer.fromSchema(schema);
    const fragment = serializer.serializeFragment(doc.content, { document });
    const host = document.createElement('div');
    host.appendChild(fragment);
    enhanceReadOnlyHtml(host, options);
    return host.innerHTML;
  } catch {
    return fallbackPlainTextHtml(blocks);
  }
}

/** Convenience for cold paths: parse + render in one step on this thread. */
export function renderNoteMarkdownHtml(markdown: string, options: NoteRenderOptions = {}): string {
  return renderNoteContentHtml(parseNoteMarkdown(markdown), options);
}
