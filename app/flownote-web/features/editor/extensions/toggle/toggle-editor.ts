import type { Node as PMNode } from 'prosemirror-model';
import { AllSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from 'prosemirror-view';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { ToggleNode } from './toggle';
import { isAtToggleStart } from './toggle-commands';
import {
  normalizeToggleOpen,
  TOGGLE_FOLD_META,
  TOGGLE_NODE_NAME,
} from './toggle-markdown';
import { toggleNodeView } from './toggle-node-view';

/**
 * Class applied to every body block of a collapsed toggle. Hiding is done with
 * decorations rather than `nth-child` selectors so it survives NodeView
 * structure changes and, because the CSS rule lives under `@media screen`,
 * printing and PDF export always see the full content.
 */
export const TOGGLE_COLLAPSED_CONTENT_CLASS = 'is-toggle-collapsed-content';

interface ToggleFoldState {
  decorations: DecorationSet;
}

const toggleFoldKey = new PluginKey<ToggleFoldState>('toggleFold');
const toggleAutoExpandKey = new PluginKey('toggleAutoExpand');

function buildDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (node.type.name !== TOGGLE_NODE_NAME) return true;
    if (normalizeToggleOpen(node.attrs.open)) return true;
    if (node.childCount < 2) return true;

    let childPos = pos + 1;
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (index > 0) {
        decorations.push(Decoration.node(childPos, childPos + child.nodeSize, {
          class: TOGGLE_COLLAPSED_CONTENT_CLASS,
        }));
      }
      childPos += child.nodeSize;
    }
    // Keep descending so a collapsed toggle nested inside an expanded one is
    // decorated as well.
    return true;
  });

  return DecorationSet.create(doc, decorations);
}

/**
 * Unfold the toggle that owns `pos`. Used by navigation surfaces (outline,
 * anchors, search) that need to reveal a block the user cannot see.
 */
export function revealToggleAtPos(view: EditorView, pos: number): boolean {
  if (view.isDestroyed) return false;
  const { doc } = view.state;

  let togglePos: number | null = null;
  try {
    const $pos = doc.resolve(Math.min(Math.max(pos, 0), doc.content.size));
    for (let depth = $pos.depth; depth >= 1; depth -= 1) {
      if ($pos.node(depth).type.name === TOGGLE_NODE_NAME) {
        togglePos = $pos.before(depth);
        break;
      }
    }
  } catch {
    return false;
  }
  if (togglePos === null) return false;

  const node = doc.nodeAt(togglePos);
  if (!node || normalizeToggleOpen(node.attrs.open)) return false;

  const tr = view.state.tr.setNodeMarkup(togglePos, undefined, {
    ...node.attrs,
    open: true,
  });
  tr.setMeta(TOGGLE_FOLD_META, { pos: togglePos });
  tr.setMeta('addToHistory', false);
  view.dispatch(tr);
  return true;
}

/** Unfold the toggle that contains a rendered element before revealing it. */
export function revealToggleAtDomElement(view: EditorView, element: HTMLElement): boolean {
  if (view.isDestroyed || !element.isConnected) return false;
  try {
    return revealToggleAtPos(view, view.posAtDOM(element, 0));
  } catch {
    return false;
  }
}

/**
 * Editor-only variant. The worker parser registry imports `toggle.ts`
 * directly, so NodeViews, i18n and DOM plugins must stay in this module.
 */
export const ToggleEditorNode = ToggleNode.extend({
  addNodeView() {
    return toggleNodeView;
  },

  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        if (!this.editor.isEditable) return false;
        if (!isAtToggleStart(this.editor.state)) return false;
        return this.editor.commands.unsetToggle();
      },
    };
  },

  addProseMirrorPlugins() {
    // `appendTransaction` runs with the plugin spec as `this`, so capture the
    // editor (and its read-only state) through a closure.
    const isEditable = () => this.editor.isEditable;

    return [
      new Plugin<ToggleFoldState>({
        key: toggleFoldKey,

        state: {
          init: (_config, state) => ({
            decorations: buildDecorations(state.doc),
          }),
          apply: (tr, value, _oldState, newState) => {
            if (!tr.docChanged) return value;
            return { decorations: buildDecorations(newState.doc) };
          },
        },

        props: {
          decorations(state) {
            return toggleFoldKey.getState(state)?.decorations ?? null;
          },
        },
      }),

      new Plugin({
        key: toggleAutoExpandKey,

        /**
         * Collapsed bodies are hidden but still present in the document, so
         * keyboard navigation, multi-block selection and search jumps can
         * place the caret inside them. Auto-expand the container instead of
         * leaving a caret in a hidden subtree.
         *
         * Transactions carrying `TOGGLE_FOLD_META` are our own fold/unfold
         * updates; reacting to them would unfold the toggle immediately after
         * the user collapsed it.
         */
        appendTransaction(transactions, _oldState, newState) {
          if (!isEditable()) return null;
          if (transactions.some((tr) => tr.getMeta(TOGGLE_FOLD_META))) return null;
          // Only react to explicit caret/selection moves. Document replacement
          // (e.g. `setContent`) remaps the selection implicitly and must not
          // rewrite every collapsed toggle in the note.
          if (!transactions.some((tr) => tr.selectionSet)) return null;
          // Select-all spans the hidden bodies by definition; unfolding every
          // toggle because the user pressed Ctrl+A would be surprising and
          // would persist across saves.
          if (newState.selection instanceof AllSelection) return null;

          const { from, to } = newState.selection;
          let targetPos: number | null = null;

          newState.doc.descendants((node, pos) => {
            if (targetPos !== null) return false;
            if (node.type.name !== TOGGLE_NODE_NAME) return true;
            if (node.childCount < 2) return true;
            if (normalizeToggleOpen(node.attrs.open)) return true;

            const title = node.firstChild;
            if (!title) return true;
            const bodyStart = pos + 1 + title.nodeSize;
            const bodyEnd = pos + node.nodeSize;
            if (from < bodyEnd && to > bodyStart) {
              targetPos = pos;
              return false;
            }
            return true;
          });

          if (targetPos === null) return null;
          const node = newState.doc.nodeAt(targetPos);
          if (!node) return null;

          const tr = newState.tr.setNodeMarkup(targetPos, undefined, {
            ...node.attrs,
            open: true,
          });
          tr.setMeta(TOGGLE_FOLD_META, { pos: targetPos });
          tr.setMeta('addToHistory', false);
          return tr;
        },
      }),
    ];
  },
});
