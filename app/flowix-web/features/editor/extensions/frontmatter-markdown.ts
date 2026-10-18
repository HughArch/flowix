import { Extension, type MarkdownToken } from '@tiptap/core';

// Consume a BOM at the file boundary and the legacy displaced-BOM position.
const FRONTMATTER_TOKEN_RE = /^\uFEFF?(?:[ \t]*\r?\n)*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n\uFEFF?|$)/;

export const frontmatterMarkdownSpec = {
  markdownTokenizer: {
    name: 'frontmatter',
    level: 'block' as const,
    start(src: string) {
      return /^\uFEFF?(?:[ \t]*\r?\n)*---/.test(src) ? 0 : -1;
    },
    tokenize(src: string, tokens?: unknown[]): { type: string; raw: string } | undefined {
      if (tokens && tokens.length > 0) return undefined;
      const match = FRONTMATTER_TOKEN_RE.exec(src);
      return match ? { type: 'frontmatter', raw: match[0] } : undefined;
    },
  },
  parseMarkdown(token: MarkdownToken) {
    const raw = token.raw ?? '';
    const match = FRONTMATTER_TOKEN_RE.exec(raw);
    if (!match) return { type: 'text', text: raw };
    return {
      type: 'frontmatter',
      attrs: { yamlContent: match[1].trim() },
    };
  },
};

export const FrontmatterMarkdownExtension = Extension.create({
  name: 'frontmatter',
  priority: 1000,
  ...frontmatterMarkdownSpec,
});
