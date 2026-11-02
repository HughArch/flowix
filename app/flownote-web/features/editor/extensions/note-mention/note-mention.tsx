import { type Editor } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import {
  createSuggestionExtension,
  openSuggestionMenuFromEditor,
  type SuggestionMenuConfig,
} from '@features/editor/extensions/shared/suggestion-menu';
import { NoteMentionDropdown } from '@features/editor/extensions/note-mention/note-mention-dropdown';
import {
  queryMentionNotes,
  toNoteReferenceAttrs,
  type MentionNoteItem,
} from '@features/editor/extensions/note-mention/note-mention-data';
import { DEFAULT_NOTE_BLOCK_LAYOUT } from '@features/editor/extensions/note-block/note-reference-block-markdown';

const TRIGGER = '@';
const WIDTH = 280;

const noteMentionConfig: SuggestionMenuConfig<MentionNoteItem> = {
  trigger: TRIGGER,
  width: WIDTH,

  parseQuery: (view: EditorView, triggerFrom, trigger) => {
    const { selection } = view.state;
    if (!selection.empty || selection.from < triggerFrom + 1) return null;

    const $trigger = view.state.doc.resolve(triggerFrom);
    const $cursor = view.state.doc.resolve(selection.from);
    if (!$trigger.sameParent($cursor)) return null;

    const text = view.state.doc.textBetween(triggerFrom, selection.from, '\n', '\n');
    if (!text.startsWith(trigger)) return null;

    const query = text.slice(1);
    // Note titles often contain punctuation; only whitespace closes the query.
    if (/\s/.test(query)) return null;
    return query;
  },

  fetchItems: (query) => queryMentionNotes(query),

  render: ({ items, selectedIndex, scrollSelectedItem, hasMore, loading, onSelect, onHover, onLoadMore }) => (
    <NoteMentionDropdown
      items={items}
      selectedIndex={selectedIndex}
      scrollSelectedItem={scrollSelectedItem}
      hasMore={hasMore}
      loading={loading}
      onSelect={onSelect}
      onHover={onHover}
      onLoadMore={onLoadMore}
    />
  ),

  onSelect: ({ editor, item, deleteTriggerText }) => {
    deleteTriggerText();
    if (!editor.schema.nodes.noteReference) return;
    editor.commands.insertContent({
      type: 'noteReference',
      attrs: toNoteReferenceAttrs(item),
    });
  },

  onError: (err) => console.warn('[note-mention] query failed:', err),
};

export function openNoteMention(editor: Editor): boolean {
  return openSuggestionMenuFromEditor(editor, noteMentionConfig);
}

/**
 * `@` trigger for note references. Selecting an item inserts a `noteReference`
 * inline card that can navigate to the target memo.
 */
export const NoteMention = createSuggestionExtension<MentionNoteItem>(noteMentionConfig);

const wikiNoteMentionConfig: SuggestionMenuConfig<MentionNoteItem> = {
  ...noteMentionConfig,
  trigger: '[[',
  parseQuery: (view: EditorView, triggerFrom, trigger) => {
    const { selection } = view.state;
    if (!selection.empty || selection.from < triggerFrom + trigger.length) return null;
    const $trigger = view.state.doc.resolve(triggerFrom);
    const $cursor = view.state.doc.resolve(selection.from);
    if (!$trigger.sameParent($cursor)) return null;
    const text = view.state.doc.textBetween(triggerFrom, selection.from, '\n', '\n');
    if (!text.startsWith(trigger)) return null;
    const query = text.slice(trigger.length);
    if (query.includes(']') || query.includes('\n')) return null;
    return query;
  },
  onSelect: ({ editor, item, deleteTriggerText }) => {
    deleteTriggerText();
    if (!editor.schema.nodes.noteReference) return;
    editor.commands.insertContent({
      type: 'noteReference',
      attrs: {
        ...toNoteReferenceAttrs(item),
        heading: null,
      },
    });
  },
};

/** Obsidian-style `[[` note picker. */
export const WikiNoteMention = createSuggestionExtension<MentionNoteItem>(wikiNoteMentionConfig);

/**
 * Slash-menu entry for block-level note cards. Shares the inline mention's
 * trigger/query/dropdown, but the picked note becomes an `noteReferenceBlock`
 * occupying its own line. When the caret sits in an empty textblock (the
 * usual `/`-at-line-start case) that block is replaced so no empty paragraph
 * is left behind; mid-paragraph insertion splits the paragraph instead.
 */
export function openNoteBlockMention(editor: Editor): boolean {
  if (!editor.schema.nodes.noteReferenceBlock) return false;
  const config: SuggestionMenuConfig<MentionNoteItem> = {
    ...noteMentionConfig,
    onSelect: ({ editor: targetEditor, item, deleteTriggerText }) => {
      deleteTriggerText();
      const { state } = targetEditor;
      const { $from } = state.selection;
      // 空文本块整体替换 (与其它 slash 块级插入的 prepareSlashBlockTarget 同思路),
      // 避免插入后留下一个空段落; 非空段落则直接在光标处切分插入.
      let replaceRange: { from: number; to: number } | undefined;
      if ($from.depth >= 1 && $from.parent.isTextblock && $from.parent.content.size === 0) {
        replaceRange = { from: $from.before($from.depth), to: $from.after($from.depth) };
      }
      targetEditor
        .chain()
        .focus()
        .insertContentAt(replaceRange ?? state.selection.from, {
          type: 'noteReferenceBlock',
          attrs: {
            ...toNoteReferenceAttrs(item),
            layout: DEFAULT_NOTE_BLOCK_LAYOUT,
          },
        })
        .run();
    },
  };
  return openSuggestionMenuFromEditor(editor, config);
}
