import { Plugin, TextSelection } from '@tiptap/pm/state';
import { CalloutNode } from './callout';
import { canWrapBlockInCallout, isAtCalloutStart, isCalloutShortcut } from './callout-commands';
import { DEFAULT_CALLOUT_PRESET } from './callout-presets';
import { calloutNodeView } from './callout-node-view';

/**
 * Editor-only variant. The worker parser registry imports `callout.ts`
 * directly, so NodeViews, i18n and DOM plugins must stay in this module.
 */
export const CalloutEditorNode = CalloutNode.extend({
  addNodeView() {
    return calloutNodeView;
  },

  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        if (!this.editor.isEditable) return false;
        if (!isAtCalloutStart(this.editor.state)) return false;
        return this.editor.commands.unsetCallout();
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          /**
           * Flowus' `!!` + space shortcut. `handleTextInput` runs before the
           * space is inserted, so the paragraph still contains exactly `!!`.
           * Consuming the input (returning true) replaces the paragraph in a
           * single transaction and avoids a flash of the literal marker.
           */
          handleTextInput(view, from, to, text) {
            if (text !== ' ' || from !== to) return false;

            const { state } = view;
            const $from = state.doc.resolve(from);
            if (!isCalloutShortcut($from.parent, $from.parentOffset)) return false;

            // A list item's required leading paragraph cannot be replaced by a
            // block container; leave the shortcut inert there.
            const containerDepth = $from.depth - 1;
            if (
              containerDepth >= 0
              && !canWrapBlockInCallout($from.node(containerDepth), $from.index(containerDepth))
            ) {
              return false;
            }

            const calloutType = state.schema.nodes.callout;
            const paragraphType = state.schema.nodes.paragraph;
            if (!calloutType || !paragraphType) return false;

            const start = $from.before($from.depth);
            const end = $from.after($from.depth);
            const callout = calloutType.create(
              {
                icon: DEFAULT_CALLOUT_PRESET.icon,
                color: DEFAULT_CALLOUT_PRESET.color,
              },
              paragraphType.create(),
            );
            const tr = state.tr.replaceWith(start, end, callout);
            tr.setSelection(TextSelection.create(tr.doc, start + 2));
            view.dispatch(tr.scrollIntoView());
            return true;
          },
        },
      }),
    ];
  },
});
