import { CodeBlock } from '@tiptap/extension-code-block';

export const SHIKI_DEFAULT_THEME = 'github-light';
export const SHIKI_DEFAULT_LANGUAGE = 'plaintext';
const languageClassPrefix = 'language-';

export interface ShikiCodeBlockOptions {
  defaultTheme: string;
  traceId?: number | null;
}

function getLanguageFromElement(element: HTMLElement): string | null {
  const codeElement = element.matches('code') ? element : element.querySelector('code');
  const languageClass = Array.from(codeElement?.classList || [])
    .find(className => className.startsWith(languageClassPrefix));

  return languageClass?.replace(languageClassPrefix, '') || null;
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
    };
  },
});
