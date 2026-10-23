import { mergeAttributes, Node } from '@tiptap/core';
import {
  COLUMN_WIDTH_UNIT,
  columnsMarkdownSpec,
  normalizeColumnWidth,
} from './columns-markdown';

/**
 * Notion-style content columns. The schema itself enforces the 2–3 column
 * limit, so malformed Markdown or drag operations cannot create a fourth
 * column. Nested columns are rejected by the editor commands and flattened by
 * the Markdown parser (see columns-markdown.ts).
 */
export const ColumnsNode = Node.create({
  name: 'columns',
  group: 'block',
  content: 'column{2,5}',
  isolating: true,
  // Clicking inside a column must place the caret in the column's paragraph,
  // not select the whole container. Node selection is still available through
  // drag/keyboard paths on the blocks themselves.
  selectable: false,
  draggable: false,

  parseHTML() {
    return [{ tag: 'div[data-flowix-columns]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-flowix-columns': '',
        class: 'flowix-columns',
      }),
      0,
    ];
  },

  ...columnsMarkdownSpec,
});

export const ColumnNode = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true,
  selectable: false,
  draggable: false,

  addAttributes() {
    return {
      width: {
        default: COLUMN_WIDTH_UNIT,
        parseHTML: (element) => normalizeColumnWidth(element.getAttribute('data-width')),
        renderHTML: (attributes) => ({
          'data-width': String(normalizeColumnWidth(attributes.width)),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-flowix-column]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const width = normalizeColumnWidth(node.attrs.width);
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-flowix-column': '',
        class: 'flowix-column',
        // Keep proportional widths in exported HTML; the NodeView uses the
        // same value through inline styles.
        style: `flex-grow:${width};flex-basis:0;min-width:0`,
      }),
      ['div', { class: 'flowix-column-content' }, 0],
    ];
  },
});
