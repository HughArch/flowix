import { ListItem } from '@tiptap/extension-list';
import { TaskList } from '@tiptap/extension-task-list';
import StarterKit from '@tiptap/starter-kit';
import { AttachmentMarkdownExtensions } from '@features/editor/extensions/attachment-link/markdown/extensions';
import { CodeBlockShikiBase } from '@features/editor/extensions/codeblock-shiki/codeblock-shiki-base';
import { FlowixHighlight } from '@features/editor/extensions/flowix-text-mark';
import { MarkdownLinkParserExtension } from '@features/editor/extensions/markdown-link-markdown';
import { NoteReferenceMarkdownExtension } from '@features/editor/extensions/note-link/note-reference-markdown';
import { FlowixTable } from '@features/editor/extensions/table/flowix-table';
import { FrontmatterMarkdownExtension } from '@features/editor/extensions/frontmatter-markdown';
import { TableReferenceMarkdownExtension } from '@features/multidimensional-table/table-reference-markdown';
import { MediaLibraryReferenceMarkdownExtension } from '@features/media-library/media-library-reference-markdown';
import { MarkdownEscape, LegacyAdjacentStrongMarkdown } from './markdown-parser-core-extensions';
import { MathBlockMarkdownExtension } from '@features/editor/extensions/math-block-markdown';
import { WebCardMarkdownExtension } from '@features/editor/extensions/web-card-markdown';
import { MarkdownParagraph, MarkdownTaskItem } from './markdown-parser-common-extensions';

/**
 * MarkdownManager only consumes Markdown tokenizers and parse handlers. Keep
 * this registry separate from editor menus, NodeViews, and editing plugins.
 */
export function createMarkdownParserExtensions() {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      dropcursor: false,
      gapcursor: false,
      link: false,
      codeBlock: false,
      paragraph: false,
      listItem: false,
    }),
    MarkdownParagraph,
    ListItem,
    TaskList,
    MarkdownTaskItem,
    MarkdownEscape,
    LegacyAdjacentStrongMarkdown,
    ...AttachmentMarkdownExtensions,
    MarkdownLinkParserExtension,
    CodeBlockShikiBase,
    MathBlockMarkdownExtension,
    WebCardMarkdownExtension,
    FlowixTable,
    TableReferenceMarkdownExtension,
    MediaLibraryReferenceMarkdownExtension,
    FlowixHighlight.configure({ multicolor: true }),
    FrontmatterMarkdownExtension,
    NoteReferenceMarkdownExtension,
  ];
}

export function hasUnsupportedWorkerMarkdown(markdown: string): boolean {
  // The legacy Agent Thread Card form is plain text to Marked unless its UI
  // extension is loaded. Route that legacy form through the browser parser.
  return /^ {0,3}::agent-thread-card\{/m.test(markdown);
}
