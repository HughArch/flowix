import type { Editor } from '@tiptap/core';
import { TextSelection, type Transaction } from '@tiptap/pm/state';

export interface ComposerInsertionPoint { from: number; to: number }

/** A saved editor selection mapped through every transaction while files load. */
export interface ComposerInsertionAnchor {
  resolve(): ComposerInsertionPoint | undefined;
  advance(point: ComposerInsertionPoint): void;
  dispose(): void;
}

export function captureComposerInsertionAnchor(editor: Editor): ComposerInsertionAnchor {
  let bookmark = editor.state.selection.getBookmark();
  let disposed = false;
  const mapBookmark = ({ transaction }: { transaction: Transaction }) => {
    bookmark = bookmark.map(transaction.mapping);
  };
  editor.on('transaction', mapBookmark);
  return {
    resolve() {
      if (disposed || editor.isDestroyed) return undefined;
      const selection = bookmark.resolve(editor.state.doc);
      return { from: selection.from, to: selection.to };
    },
    advance(point) {
      if (disposed || editor.isDestroyed) return;
      bookmark = TextSelection.create(editor.state.doc, point.to).getBookmark();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      editor.off('transaction', mapBookmark);
    },
  };
}
