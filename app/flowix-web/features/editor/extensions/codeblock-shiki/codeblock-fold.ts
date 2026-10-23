import type { Node as PMNode } from 'prosemirror-model';
import { NodeSelection, Plugin, PluginKey, Selection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

export const CODE_BLOCK_FOLD_META = 'flowixCodeBlockFold';

const codeBlockFoldPluginKey = new PluginKey('codeBlockFold');

export function toggleCodeBlockCollapsed(view: EditorView, pos: number): boolean {
  if (view.isDestroyed) return false;

  const { state } = view;
  const node = state.doc.nodeAt(pos);
  if (!node || node.type.name !== 'codeBlock') return false;

  const collapsed = node.attrs.collapsed !== true;
  const tr = state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, collapsed });
  // Matches toggle / heading-fold: chrome state does not consume an undo step.
  tr.setMeta('addToHistory', false);
  tr.setMeta(CODE_BLOCK_FOLD_META, { pos, auto: false });

  if (collapsed) {
    // The content DOM is about to be hidden; move the caret out first.
    const { from, to } = state.selection;
    const end = pos + node.nodeSize;
    if (from < end && to > pos) {
      const after = Math.min(end, tr.doc.content.size);
      const next = Selection.near(tr.doc.resolve(after), 1);
      const landsInside = next.from >= pos && next.to <= end;
      tr.setSelection(landsInside
        ? Selection.near(tr.doc.resolve(pos), -1)
        : next);
    }
  }

  view.dispatch(tr.scrollIntoView());
  return true;
}

function collapsedCodeBlockAt(doc: PMNode, pos: number): number | null {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.type.name === 'codeBlock' && node.attrs.collapsed === true) {
      return $pos.before(depth);
    }
  }
  return null;
}

/**
 * Re-expands a collapsed code block as soon as a selection enters it, so the
 * caret never lands inside a `display: none` subtree. A NodeSelection on the
 * block itself is ignored: that is how the drag handle targets a block, and
 * unfolding on every menu open would be surprising.
 */
export function createCodeBlockFoldPlugin(): Plugin {
  return new Plugin({
    key: codeBlockFoldPluginKey,
    appendTransaction(transactions, _oldState, newState) {
      if (transactions.some(transaction => transaction.getMeta(CODE_BLOCK_FOLD_META))) return null;
      if (!transactions.some(transaction => transaction.selectionSet || transaction.docChanged)) return null;

      const { selection } = newState;
      if (selection instanceof NodeSelection && selection.node.type.name === 'codeBlock') return null;

      const targets = new Set<number>();
      if (selection.empty) {
        const target = collapsedCodeBlockAt(newState.doc, selection.from);
        if (target !== null) targets.add(target);
      } else {
        newState.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
          if (node.type.name !== 'codeBlock') return true;
          if (node.attrs.collapsed === true) targets.add(pos);
          return false;
        });
      }
      if (targets.size === 0) return null;

      const tr = newState.tr;
      for (const pos of targets) {
        const node = tr.doc.nodeAt(pos);
        if (!node || node.type.name !== 'codeBlock') continue;
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, collapsed: false });
      }
      tr.setMeta('addToHistory', false);
      tr.setMeta(CODE_BLOCK_FOLD_META, { auto: true });
      return tr;
    },
  });
}
