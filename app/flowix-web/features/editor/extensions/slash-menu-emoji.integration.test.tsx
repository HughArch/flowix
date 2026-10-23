import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { SlashMenu, isSlashMenuOpen } from './slash-menu';
import type { SlashMenuProps } from '@features/editor/components/slash-menu-dropdown';

vi.mock('@features/agent/public/runtime-status-api', () => ({
  getAgentRuntimeStatusSnapshot: () => ({ hasChecked: true, isChecking: false, statusByType: {} }),
  getAvailableAgentTypes: () => [],
  subscribeAgentRuntimeStatus: () => () => {},
  refreshAgentRuntimeStatusIfStale: async () => {},
}));

// Keep the real menu state/lifecycle/handlers, but expose each item as a
// clickable button so the test can choose the emoji command directly.
vi.mock('@features/editor/components/slash-menu-dropdown', async importOriginal => {
  const original = await importOriginal<
    typeof import('@features/editor/components/slash-menu-dropdown')
  >();
  return {
    ...original,
    SlashMenuDropdown: ({ items, onSelect }: SlashMenuProps) => (
      <div>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            data-testid={`slash-item-${item.id}`}
            onClick={() => onSelect(item)}
          >
            {item.id}
          </button>
        ))}
      </div>
    ),
  };
});

const editors: Editor[] = [];

function createEditor(): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ gapcursor: false, trailingNode: false }),
      SlashMenu,
    ],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  });
  vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({
    left: 100,
    right: 100,
    top: 100,
    bottom: 120,
  });
  editors.push(editor);
  return editor;
}

function type(editor: Editor, text: string) {
  const { from, to } = editor.state.selection;
  const insert = () => editor.state.tr.insertText(text, from, to);
  const handled = editor.view.someProp('handleTextInput', handler =>
    handler(editor.view, from, to, text, insert));
  if (!handled) editor.view.dispatch(insert());
}

afterEach(async () => {
  await act(async () => {
    for (const editor of editors.splice(0)) {
      const element = editor.options.element as HTMLElement;
      editor.destroy();
      element.remove();
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  vi.clearAllMocks();
});

describe('slash menu emoji command', () => {
  it('opens the shared emoji picker and inserts the chosen emoji', async () => {
    const editor = createEditor();
    await act(async () => {
      editor.commands.setTextSelection(1);
      type(editor, '/');
    });
    expect(isSlashMenuOpen(editor.view)).toBe(true);

    const entry = document.querySelector<HTMLButtonElement>('[data-testid="slash-item-emoji"]');
    expect(entry).toBeTruthy();
    await act(async () => {
      entry!.click();
    });

    expect(isSlashMenuOpen(editor.view)).toBe(false);
    const panel = document.querySelector<HTMLElement>('.flowix-emoji-picker');
    expect(panel).toBeTruthy();

    const first = panel!.querySelector<HTMLButtonElement>('.flowix-emoji-picker__icon');
    expect(first?.textContent).toBeTruthy();
    const emoji = first!.textContent!;

    await act(async () => {
      first!.click();
    });

    expect(document.querySelector('.flowix-emoji-picker')).toBeNull();
    expect(editor.state.doc.textContent).toBe(emoji);
    expect(editor.state.doc.textContent).not.toContain('/');
  });
});
