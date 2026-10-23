import { mergeAttributes, Node } from '@tiptap/core';
import { setCallout, unsetCallout } from './callout-commands';
import {
  calloutMarkdownSpec,
  DEFAULT_CALLOUT_COLOR,
  DEFAULT_CALLOUT_ICON,
  normalizeCalloutColor,
  normalizeCalloutIcon,
} from './callout-markdown';

/**
 * Flowus-style callout ("着重块"): an icon rail plus arbitrary block content on
 * a tinted background.
 *
 * The node is deliberately non-selectable and isolating, like `columns`: the
 * caret belongs to the inner blocks, and selection cannot span the container
 * boundary and silently drag half of it away.
 */
export const CalloutNode = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  isolating: true,
  selectable: false,
  draggable: false,

  addAttributes() {
    return {
      icon: {
        default: DEFAULT_CALLOUT_ICON,
        parseHTML: (element) => normalizeCalloutIcon(element.getAttribute('data-icon')),
        renderHTML: (attributes) => ({
          'data-icon': normalizeCalloutIcon(attributes.icon),
        }),
      },
      color: {
        default: DEFAULT_CALLOUT_COLOR,
        parseHTML: (element) => normalizeCalloutColor(element.getAttribute('data-color')),
        renderHTML: (attributes) => ({
          'data-color': normalizeCalloutColor(attributes.color),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-flowix-callout]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-flowix-callout': '',
        class: 'flowix-callout',
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setCallout: () => setCallout,
      unsetCallout: () => unsetCallout,
    };
  },

  ...calloutMarkdownSpec,
});
