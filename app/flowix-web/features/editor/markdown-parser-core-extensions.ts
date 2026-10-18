import { Extension } from '@tiptap/core';

export const MarkdownEscape = Extension.create({
  name: 'markdownEscape',
  markdownTokenName: 'escape',
  parseMarkdown(token, helpers) {
    return helpers.createTextNode(token.raw || token.text || '');
  },
});

/** Read compatibility for legacy adjacent bold runs in saved Markdown. */
export const LegacyAdjacentStrongMarkdown = Extension.create({
  name: 'legacyAdjacentStrongMarkdown',
  markdownTokenizer: {
    name: 'strong',
    level: 'inline',
    start: '**',
    tokenize(src, _tokens, lexer) {
      const match = /^\*\*(?!\s)((?:(?!\*\*)[^\n])+?\S)\*\*(?=[\p{L}\p{N}])/u.exec(src);
      if (!match) return undefined;

      return {
        type: 'strong',
        raw: match[0],
        text: match[1],
        tokens: lexer.inlineTokens(match[1]),
      };
    },
  },
});
