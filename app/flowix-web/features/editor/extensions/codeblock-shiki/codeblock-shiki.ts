import { createCodeBlockShikiView } from '@features/editor/extensions/codeblock-shiki/codeblock-shiki-view';
import { createCodeBlockFoldPlugin } from '@features/editor/extensions/codeblock-shiki/codeblock-fold';
import { proseMirrorPluginShiki } from '@features/editor/extensions/codeblock-shiki/shiki/shiki-plugin';
import { TextSelection } from '@tiptap/pm/state';
import {
  CodeBlockShikiBase,
  SHIKI_DEFAULT_LANGUAGE,
  SHIKI_DEFAULT_THEME,
  type ShikiCodeBlockOptions,
} from './codeblock-shiki-base';

/** Shiki themes preloaded for synchronous theme changes after editor mount. */
const PRELOADED_SHIKI_THEMES = ['github-light', 'github-dark'] as const;

/** Browser editor behavior layered over the worker-safe document extension. */
export const CodeBlockShiki = CodeBlockShikiBase.extend<ShikiCodeBlockOptions>({
  addNodeView() {
    return (...args) => createCodeBlockShikiView(...args);
  },

  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      Backspace: () => {
        const { selection } = this.editor.state;
        const { empty, $anchor } = selection;

        if (
          selection instanceof TextSelection &&
          empty &&
          $anchor.parent.type.name === this.name &&
          $anchor.parentOffset === 0 &&
          $anchor.parent.textContent.length > 0
        ) {
          return true;
        }

        const isAtStart = $anchor.pos === 1;
        if (empty && $anchor.parent.type.name === this.name && (isAtStart || !$anchor.parent.textContent.length)) {
          return this.editor.commands.clearNodes();
        }

        return false;
      },
    };
  },

  addProseMirrorPlugins() {
    const plugins = super.addProseMirrorPlugins?.() || [];
    return [
      ...plugins,
      proseMirrorPluginShiki({
        name: this.name,
        defaultLanguage: SHIKI_DEFAULT_LANGUAGE,
        defaultTheme: SHIKI_DEFAULT_THEME,
        preloadThemes: [...PRELOADED_SHIKI_THEMES],
        traceId: this.options.traceId,
      }),
      createCodeBlockFoldPlugin(),
    ];
  },
});
