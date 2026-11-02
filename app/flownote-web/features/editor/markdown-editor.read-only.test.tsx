import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MarkdownEditor } from './markdown-editor';
import { ShortcutsProvider } from '@features/shortcuts';
import '@features/shortcuts/actions';

let container: HTMLDivElement;
let root: Root;
let editor: Editor | null;
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function render(content: string, editable: boolean) {
  return act(async () => {
    root.render(
      <ShortcutsProvider overrides={{}}>
        <MarkdownEditor
          content={content}
          editable={editable}
          onBeforeCreate={(instance) => { editor = instance; }}
        />
      </ShortcutsProvider>,
    );
  });
}

function edit(text: string) {
  editor!.commands.setTextSelection(editor!.state.doc.content.size - 1);
  editor!.commands.insertContent(text);
}

describe('MarkdownEditor read-only guard', () => {
  beforeEach(async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    editor = null;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 }),
      },
    });
    await render('Body', false);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('drops document-changing commands while the host is read-only', () => {
    act(() => edit(' blocked'));
    expect(editor!.state.doc.textContent).toBe('Body');
  });

  it('still applies an authoritative external replacement', async () => {
    await render('Replaced by sync', false);
    expect(editor!.state.doc.textContent).toBe('Replaced by sync');
  });

  it('accepts edits again once the host becomes editable', async () => {
    await render('Body', true);
    act(() => edit(' edited'));
    expect(editor!.state.doc.textContent).toBe('Body edited');
  });

  it('normalizes parsed placeholders at mount while read-only', async () => {
    await act(async () => root.unmount());
    root = createRoot(container);
    editor = null;
    await render('- [ ] &nbsp;\n- [ ] &nbsp;', false);
    const taskParagraphs: string[] = [];
    editor!.state.doc.descendants((node) => {
      if (node.type.name === 'taskItem') taskParagraphs.push(node.firstChild?.textContent ?? '');
    });
    expect(taskParagraphs).toEqual(['', '']);
  });
});
