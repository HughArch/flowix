import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { DecorationSet } from "@tiptap/pm/view";
import { createTerminalInlineAtomCaretDecorations } from "@features/editor/extensions/shared/terminal-inline-atom-caret";
import { COMPOSER_ATTACHMENT_NODE_NAME } from "./composer-attachment-compat";

const composerInlineAtomCaretPluginKey = new PluginKey<DecorationSet>(
  "composerInlineAtomCaret",
);

/** Supplies a terminal caret anchor so browser trailing breaks do not add an
 * extra line after composer-only inline chips. */
export const ComposerInlineAtomCaret = Extension.create({
  name: "composerInlineAtomCaret",

  addProseMirrorPlugins() {
    const nodeNames = [
      "composerFolderToken",
      "composerSkillToken",
      COMPOSER_ATTACHMENT_NODE_NAME,
    ];

    return [new Plugin({
      key: composerInlineAtomCaretPluginKey,
      state: {
        init: (_, state) => createTerminalInlineAtomCaretDecorations(state.doc, nodeNames),
        apply: (transaction, value, _oldState, newState) => (
          transaction.docChanged
            ? createTerminalInlineAtomCaretDecorations(newState.doc, nodeNames)
            : value
        ),
      },
      props: {
        decorations: (state) => composerInlineAtomCaretPluginKey.getState(state)
          ?? DecorationSet.empty,
      },
    })];
  },
});
