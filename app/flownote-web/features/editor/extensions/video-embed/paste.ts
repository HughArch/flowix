import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import { parseVideoUrl } from './providers';

/** Keep the pasted link usable immediately; conversion is an explicit choice. */
export function pasteVideoLink(editor: Editor, text: string): boolean {
  const video = parseVideoUrl(text);
  if (!video || !editor.schema.nodes.videoEmbed || editor.isActive('codeBlock') || editor.isActive('code')) return false;
  const { from } = editor.state.selection;
  const sourceUrl = text.trim();
  const inserted = editor.chain().command(({ tr }) => { closeHistory(tr); return true; })
    .insertContent({ type: 'text', text: sourceUrl, marks: [{ type: 'link', attrs: { href: sourceUrl } }] }).run();
  if (!inserted) return false;

  const pastedSelection = editor.state.selection;
  const doc = editor.view.dom.ownerDocument;
  const win = doc.defaultView!;
  const bubble = doc.createElement('div');
  bubble.className = 'editor-video-paste-bubble';
  bubble.style.fontFamily = win.getComputedStyle(editor.view.dom).fontFamily;
  bubble.setAttribute('role', 'group');
  bubble.setAttribute('aria-label', '视频链接');
  const button = doc.createElement('button');
  button.type = 'button';
  button.textContent = '嵌入视频';
  bubble.append(button);
  doc.body.append(bubble);
  let active = true;

  const position = () => {
    if (!active || editor.isDestroyed) return;
    const anchor = editor.view.coordsAtPos(from);
    // Intersect the viewport with every clipping ancestor, including pane scrollers.
    let top = 0, bottom = win.innerHeight, left = 0, right = win.innerWidth;
    for (let parent: HTMLElement | null = editor.view.dom; parent; parent = parent.parentElement) {
      const style = win.getComputedStyle(parent);
      const rect = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY || style.overflow)) {
        top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX || style.overflow)) {
        left = Math.max(left, rect.left); right = Math.min(right, rect.right);
      }
    }
    bubble.hidden = anchor.bottom <= top || anchor.top >= bottom || anchor.right < left || anchor.left > right;
    if (bubble.hidden) return;
    const width = bubble.offsetWidth;
    const height = bubble.offsetHeight;
    bubble.style.left = `${Math.max(8, Math.min(anchor.left, win.innerWidth - width - 8))}px`;
    bubble.style.top = `${Math.max(8, anchor.top - height - 8)}px`;
  };
  const cleanup = () => {
    if (!active) return;
    active = false;
    bubble.remove();
    editor.off('transaction', onTransaction);
    editor.off('destroy', cleanup);
    doc.removeEventListener('pointerdown', onOutside, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    win.removeEventListener('scroll', position, true);
    win.removeEventListener('resize', position);
  };
  const onOutside = (event: Event) => {
    if (!bubble.contains(event.target as globalThis.Node)) cleanup();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') cleanup();
  };
  const onTransaction = ({ transaction }: { transaction: Transaction }) => {
    if (transaction.docChanged || (transaction.selectionSet && !transaction.selection.eq(pastedSelection))) cleanup();
  };
  // Keep the editor selection when using the floating action.
  bubble.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', () => {
    if (!active || editor.isDestroyed) return;
    cleanup();
    editor.chain().focus().command(({ tr }) => { closeHistory(tr); return true; })
      .insertContentAt({ from, to: from + sourceUrl.length }, { type: 'videoEmbed', attrs: video }).run();
  });
  editor.on('transaction', onTransaction);
  editor.on('destroy', cleanup);
  doc.addEventListener('pointerdown', onOutside, true);
  doc.addEventListener('keydown', onKeyDown, true);
  win.addEventListener('scroll', position, true);
  win.addEventListener('resize', position);
  position();
  return true;
}
