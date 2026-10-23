import type { NodeViewRendererProps } from '@tiptap/core';
import type { Node as PMNode } from 'prosemirror-model';
import { Selection, TextSelection } from 'prosemirror-state';
import type { ViewMutationRecord } from 'prosemirror-view';
import { translate, type I18nKey } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { clearBlockSelection } from '../block-selection';
import {
  normalizeToggleBackground,
  normalizeToggleOpen,
  TOGGLE_FOLD_META,
  TOGGLE_NODE_NAME,
} from './toggle-markdown';

// NodeViews live outside the React tree and cannot use useI18n.
function tKey(key: I18nKey): string {
  return translate(getCurrentAppLanguage(), key);
}

/**
 * Toggle NodeView: a gutter chevron plus the content DOM. The first content
 * child is the title; the remaining children are the body and are hidden by
 * CSS while `data-open="false"`.
 */
export function toggleNodeView({ node, getPos, editor }: NodeViewRendererProps) {
  const dom = document.createElement('div');
  dom.className = 'flowix-toggle';

  const chevron = document.createElement('button');
  chevron.type = 'button';
  chevron.className = 'flowix-toggle-chevron';
  chevron.contentEditable = 'false';
  chevron.tabIndex = -1;
  dom.appendChild(chevron);

  const contentDOM = document.createElement('div');
  contentDOM.className = 'flowix-toggle-content';
  dom.appendChild(contentDOM);

  const sync = (next: PMNode) => {
    const open = normalizeToggleOpen(next.attrs.open);
    const foldable = next.childCount > 1;
    const background = normalizeToggleBackground(next.attrs.flowixBg);

    dom.dataset.open = open ? 'true' : 'false';
    dom.dataset.foldable = foldable ? 'true' : 'false';
    // Custom NodeViews do not apply `renderHTML` attributes; mirror the
    // shared `data-flowix-block-bg` attribute so the line-background CSS
    // (and copy/paste snapshots) see the container colour.
    if (background) dom.dataset.flowixBlockBg = background;
    else delete dom.dataset.flowixBlockBg;

    // The global placeholder only decorates top-level textblocks, so the
    // title line needs its own empty-state label (Flowus' "折叠列表").
    const title = next.firstChild;
    const titleEmpty = !!title
      && title.type.name === 'paragraph'
      && title.content.size === 0;
    if (titleEmpty) contentDOM.dataset.titlePlaceholder = tKey('editor.toggle.placeholder');
    else delete contentDOM.dataset.titlePlaceholder;

    const label = tKey(open ? 'editor.toggle.fold' : 'editor.toggle.unfold');
    chevron.dataset.folded = open ? 'false' : 'true';
    chevron.setAttribute('aria-label', label);
    chevron.setAttribute('aria-expanded', open ? 'true' : 'false');
    chevron.title = label;
  };

  const toggleOpen = () => {
    if (editor.isDestroyed) return;
    const pos = typeof getPos === 'function' ? getPos() : undefined;
    if (typeof pos !== 'number') return;

    // `getPos()` may point at a node that has already been replaced; always
    // re-read the live node before merging attrs.
    const live = editor.state.doc.nodeAt(pos);
    if (!live || live.type.name !== TOGGLE_NODE_NAME) return;

    // A toggle that only has a title has nothing to fold yet. Clicking the
    // chevron creates the first body block and puts the caret inside it,
    // matching Flowus' empty "折叠列表" block.
    if (live.childCount < 2) {
      const paragraph = editor.schema.nodes.paragraph;
      const title = live.firstChild;
      if (!paragraph || !title) return;
      const insertPos = pos + 1 + title.nodeSize;
      const tr = editor.state.tr;
      // A hand-written `::: toggle collapsed` can be both collapsed and
      // body-less; the new block must be visible, so unfold it in the same
      // transaction (the fold meta keeps the auto-expand plugin out).
      if (!normalizeToggleOpen(live.attrs.open)) {
        tr.setNodeMarkup(pos, undefined, { ...live.attrs, open: true });
      }
      tr.insert(insertPos, paragraph.create());
      tr.setMeta('addToHistory', false);
      tr.setMeta(TOGGLE_FOLD_META, { pos });
      tr.setSelection(TextSelection.create(tr.doc, insertPos + 1));
      editor.view.dispatch(tr.scrollIntoView());
      return;
    }

    const nextOpen = !normalizeToggleOpen(live.attrs.open);
    const tr = editor.state.tr.setNodeMarkup(pos, undefined, {
      ...live.attrs,
      open: nextOpen,
    });
    // Folding is a view-level operation: persisting it must not consume an
    // undo step that the user expects to belong to their text edits.
    tr.setMeta('addToHistory', false);
    tr.setMeta(TOGGLE_FOLD_META, { pos });

    if (!nextOpen) {
      // Multi-block selection is independent of the ProseMirror selection. If
      // it still covers body rows, Delete would remove blocks the user can no
      // longer see, so drop the set together with the fold.
      clearBlockSelection(editor);

      // The body becomes hidden; move the caret out first so it never sits
      // inside a hidden subtree.
      const title = live.firstChild;
      if (title) {
        const bodyStart = pos + 1 + title.nodeSize;
        const bodyEnd = pos + live.nodeSize;
        const { selection } = editor.state;
        const overlapsBody = selection.from < bodyEnd && selection.to > bodyStart;
        if (overlapsBody) {
          const titleEnd = Math.min(pos + title.nodeSize, tr.doc.content.size);
          tr.setSelection(Selection.near(tr.doc.resolve(titleEnd), -1));
        }
      }
    }

    editor.view.dispatch(tr.scrollIntoView());
  };

  chevron.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  chevron.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleOpen();
  });

  sync(node);

  return {
    dom,
    contentDOM,
    update(updatedNode: PMNode) {
      if (updatedNode.type.name !== TOGGLE_NODE_NAME) return false;
      sync(updatedNode);
      return true;
    },
    stopEvent(event: Event) {
      return event.target instanceof Node && chevron.contains(event.target);
    },
    ignoreMutation(mutation: ViewMutationRecord) {
      // `sync` owns the placeholder attribute on the content wrapper itself.
      if (mutation.type === 'attributes' && mutation.target === contentDOM) return true;
      return !contentDOM.contains(mutation.target as Node);
    },
  };
}
