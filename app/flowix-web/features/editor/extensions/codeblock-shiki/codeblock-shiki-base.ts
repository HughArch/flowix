import type {
  JSONContent,
  MarkdownParseHelpers,
  MarkdownRendererHelpers,
  MarkdownToken,
} from '@tiptap/core';
import { CodeBlock } from '@tiptap/extension-code-block';

export const SHIKI_DEFAULT_THEME = 'github-light';
export const SHIKI_DEFAULT_LANGUAGE = 'plaintext';
export const CODE_BLOCK_COLLAPSED_FLAG = 'collapsed';
const languageClassPrefix = 'language-';

export interface ShikiCodeBlockOptions {
  defaultTheme: string;
  traceId?: number | null;
}

export interface CodeBlockFenceInfo {
  language: string | null;
  collapsed: boolean;
}

function getLanguageFromElement(element: HTMLElement): string | null {
  const codeElement = element.matches('code') ? element : element.querySelector('code');
  const languageClass = Array.from(codeElement?.classList || [])
    .find(className => className.startsWith(languageClassPrefix));

  return languageClass?.replace(languageClassPrefix, '') || null;
}

/**
 * Split a fenced-code info string into the language token and the optional
 * `collapsed` flag. `{collapsed}` is accepted on input but only the bare
 * flag is emitted, so the first token stays a valid language name for
 * external renderers (GitHub, marked).
 */
export function parseCodeBlockFenceInfo(info: unknown): CodeBlockFenceInfo {
  const raw = typeof info === 'string' ? info.trim() : '';
  if (!raw) return { language: null, collapsed: false };

  let collapsed = false;
  const languageTokens: string[] = [];
  for (const token of raw.split(/\s+/)) {
    if (token.toLowerCase().replace(/^\{+|\}+$/g, '') === CODE_BLOCK_COLLAPSED_FLAG) {
      collapsed = true;
      continue;
    }
    languageTokens.push(token);
  }

  return { language: languageTokens[0] ?? null, collapsed };
}

export function formatCodeBlockFenceInfo(language: unknown, collapsed: unknown): string {
  const lang = typeof language === 'string' ? language.trim() : '';
  const isCollapsed = collapsed === true;
  if (lang && isCollapsed) return `${lang} ${CODE_BLOCK_COLLAPSED_FLAG}`;
  if (lang) return lang;
  return isCollapsed ? CODE_BLOCK_COLLAPSED_FLAG : '';
}

/** Document-level code-block schema and attributes, with no editor UI imports. */
export const CodeBlockShikiBase = CodeBlock.extend<ShikiCodeBlockOptions>({
  addOptions() {
    return {
      ...this.parent?.(),
      defaultLanguage: SHIKI_DEFAULT_LANGUAGE,
      defaultTheme: SHIKI_DEFAULT_THEME,
      traceId: null,
    };
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      language: {
        default: SHIKI_DEFAULT_LANGUAGE,
        parseHTML: (element) => {
          return element.getAttribute('data-language') || getLanguageFromElement(element) || null;
        },
        renderHTML: (attributes) => {
          if (attributes.language === SHIKI_DEFAULT_LANGUAGE) return {};
          return { 'data-language': attributes.language };
        },
      },
      theme: {
        default: SHIKI_DEFAULT_THEME,
        parseHTML: element => element.getAttribute('data-theme'),
      },
      collapsed: {
        default: false,
        parseHTML: element => element.getAttribute('data-collapsed') === 'true',
        renderHTML: attributes => (attributes.collapsed === true ? { 'data-collapsed': 'true' } : {}),
      },
    };
  },

  parseMarkdown(
    this: { parent?: (token: MarkdownToken, helpers: MarkdownParseHelpers) => JSONContent | JSONContent[] },
    token: MarkdownToken,
    helpers: MarkdownParseHelpers,
  ) {
    const parsed = this.parent ? this.parent(token, helpers) : [];
    if (Array.isArray(parsed) || parsed?.type !== 'codeBlock') return parsed;

    const info = parseCodeBlockFenceInfo((token as { lang?: string }).lang);
    return {
      ...parsed,
      attrs: { ...parsed.attrs, language: info.language, collapsed: info.collapsed },
    };
  },

  renderMarkdown(
    this: { parent?: (node: JSONContent, helpers: MarkdownRendererHelpers, ctx: unknown) => string },
    node: JSONContent,
    helpers: MarkdownRendererHelpers,
    ctx: unknown,
  ) {
    const attrs = node.attrs ?? {};
    const info = formatCodeBlockFenceInfo(attrs.language, attrs.collapsed);
    const rendered = info === (attrs.language ?? '')
      ? node
      : { ...node, attrs: { ...attrs, language: info } };
    return this.parent?.(rendered, helpers, ctx) ?? '';
  },
});
