import { mergeAttributes, Node } from '@tiptap/core';
import { flowixBlockBackgroundAttribute } from '../flowix-block-background';
import { setToggle, unsetToggle } from './toggle-commands';
import {
  normalizeToggleOpen,
  TOGGLE_NODE_NAME,
  toggleMarkdownSpec,
} from './toggle-markdown';

/**
 * Flowus-style toggle ("折叠块"): the first child block is the title line and
 * every following block belongs to the collapsible body.
 *
 * The node is deliberately non-selectable and isolating, like `columns` and
 * `callout`: the caret belongs to the inner blocks, and a selection cannot
 * span the container boundary and silently drag half of it away.
 */
export const ToggleNode = Node.create({
  name: TOGGLE_NODE_NAME,
  group: 'block',
  content: 'block+',
  isolating: true,
  selectable: false,
  draggable: false,

  addAttributes() {
    return {
      open: {
        default: true,
        parseHTML: (element) => normalizeToggleOpen(element.getAttribute('data-open')),
        renderHTML: (attributes) => ({
          'data-open': normalizeToggleOpen(attributes.open) ? 'true' : 'false',
        }),
      },
      // Whole-container line background, shared with paragraph/heading so the
      // drag-handle background palette works unchanged.
      ...flowixBlockBackgroundAttribute,
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-flowix-toggle]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-flowix-toggle': '',
        class: 'flowix-toggle',
      }),
      ['div', { class: 'flowix-toggle-content' }, 0],
    ];
  },

  addCommands() {
    return {
      setToggle: () => setToggle,
      unsetToggle: () => unsetToggle,
    };
  },

  ...toggleMarkdownSpec,
});
