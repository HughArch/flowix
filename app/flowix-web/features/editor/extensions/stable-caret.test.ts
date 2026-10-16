import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor, Node as TiptapNode } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { ComposerStableCaret, StableCaret, getInlineAtomBoundaryCaretRect, getTerminalInlineAtomCaretRect } from './stable-caret';
import { createInlineAtomNodeView } from './shared/inline-atom-nodeview';

const chipSchema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    chip: { inline: true, atom: true, group: 'inline' },
  },
});

function setRect(element: HTMLElement, rect: Partial<DOMRect>): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: rect.left ?? 0,
      right: rect.right ?? 0,
      top: rect.top ?? 0,
      bottom: rect.bottom ?? 0,
      width: rect.width ?? 0,
      height: rect.height ?? 0,
    }),
  });
}

describe('getTerminalInlineAtomCaretRect', () => {
  it('anchors the caret to the visible note card instead of the trailing break', () => {
    const editor = document.createElement('div');
    editor.className = 'ProseMirror';
    const wrapper = document.createElement('span');
    const card = document.createElement('span');
    const anchor = document.createElement('span');

    card.className = 'note-reference__card';
    anchor.className = 'terminal-inline-atom-caret-anchor';
    anchor.setAttribute('data-terminal-inline-atom-caret-position', '17');
    Object.defineProperty(card, 'getClientRects', {
      configurable: true,
      value: () => [
        { left: 100, right: 240, top: 80, bottom: 106, width: 140, height: 26 },
        { left: 80, right: 220, top: 107, bottom: 133, width: 140, height: 26 },
      ],
    });

    wrapper.append(card);
    editor.append(wrapper, anchor);

    const result = getTerminalInlineAtomCaretRect(
      { dom: editor } as never,
      17,
    );

    expect(result).toEqual({ left: 220, top: 107, bottom: 133 });
  });

  it('does not use another atom anchor position', () => {
    const editor = document.createElement('div');
    const wrapper = document.createElement('span');
    const card = document.createElement('span');
    const anchor = document.createElement('span');

    card.className = 'note-reference__card';
    anchor.className = 'terminal-inline-atom-caret-anchor';
    anchor.setAttribute('data-terminal-inline-atom-caret-position', '17');
    setRect(card, { left: 100, right: 240, top: 80, bottom: 106, width: 140, height: 26 });
    wrapper.append(card);
    editor.append(wrapper, anchor);

    expect(getTerminalInlineAtomCaretRect({ dom: editor } as never, 18)).toBeNull();
  });

  it('does not use an anchor from a nested ProseMirror editor', () => {
    const editor = document.createElement('div');
    editor.className = 'ProseMirror';
    const nestedEditor = document.createElement('div');
    nestedEditor.className = 'ProseMirror';
    const wrapper = document.createElement('span');
    const card = document.createElement('span');
    const anchor = document.createElement('span');

    card.className = 'note-reference__card';
    anchor.className = 'terminal-inline-atom-caret-anchor';
    anchor.setAttribute('data-terminal-inline-atom-caret-position', '17');
    setRect(card, { left: 100, right: 240, top: 80, bottom: 106, width: 140, height: 26 });
    wrapper.append(card);
    nestedEditor.append(wrapper, anchor);
    editor.append(nestedEditor);

    expect(getTerminalInlineAtomCaretRect({ dom: editor } as never, 17)).toBeNull();
  });
});

describe('composer inline atom caret boundaries', () => {
  it.each(['slash-token', 'skill-token', 'folder-token', 'note-reference'])('%s keeps both caret edges clear of the border after deleting a separator', (kind) => {
    const wrapper = document.createElement('span');
    wrapper.className = `agent-composer__inline-atom-wrapper ${kind}`;
    wrapper.setAttribute('data-inline-atom-caret', 'single-line');
    const card = document.createElement('span');
    card.setAttribute('data-inline-atom-card', '');
    setRect(card, { left: 100, right: 240, top: 80, bottom: 106, width: 140, height: 26 });
    wrapper.append(card);
    const doc = chipSchema.node('doc', null, [chipSchema.node('paragraph', null, [
      chipSchema.text(' '), chipSchema.node('chip'), chipSchema.text(' '),
    ])]);
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, 2) });
    state = state.apply(state.tr.delete(1, 2));
    const view = { state, nodeDOM: (pos: number) => pos === 1 ? wrapper : null };
    // Simulate the browser returning the next line / card border for native
    // caret coordinates: the resolver uses the visible card for both sides.
    expect(getInlineAtomBoundaryCaretRect(view as never, 1)).toEqual({ left: 97, top: 80, bottom: 106 });
    state = state.apply(state.tr.delete(2, 3));
    view.state = state;
    expect(getInlineAtomBoundaryCaretRect(view as never, 2)).toEqual({ left: 241, top: 80, bottom: 106 });
  });

  it('leaves ordinary text positions to the native caret', () => {
    const doc = chipSchema.node('doc', null, [chipSchema.node('paragraph', null, chipSchema.text('text'))]);
    const view = { state: EditorState.create({ doc }), nodeDOM: () => null };
    expect(getInlineAtomBoundaryCaretRect(view as never, 3)).toBeNull();
  });

  it('does not take over other editor atoms or unmounted cards', () => {
    const doc = chipSchema.node('doc', null, [chipSchema.node('paragraph', null, chipSchema.node('chip'))]);
    const wrapper = document.createElement('span');
    const view = { state: EditorState.create({ doc }), nodeDOM: () => wrapper };
    expect(getInlineAtomBoundaryCaretRect(view as never, 1)).toBeNull();
    wrapper.className = 'agent-composer__inline-atom-wrapper';
    wrapper.setAttribute('data-inline-atom-caret', 'single-line');
    expect(getInlineAtomBoundaryCaretRect(view as never, 2)).toBeNull();
  });

  it('uses the configured caret width and gap for either direction', () => {
    const doc = chipSchema.node('doc', null, [chipSchema.node('paragraph', null, chipSchema.node('chip'))]);
    const wrapper = document.createElement('span');
    wrapper.className = 'agent-composer__inline-atom-wrapper';
    wrapper.setAttribute('data-inline-atom-caret', 'single-line');
    wrapper.style.setProperty('--editor-caret-width', '3px');
    wrapper.style.setProperty('--inline-atom-caret-gap', '2px');
    const card = document.createElement('span');
    card.setAttribute('data-inline-atom-card', '');
    setRect(card, { left: 100, right: 240, top: 80, bottom: 106, width: 140, height: 26 });
    wrapper.append(card);
    document.body.append(wrapper);
    const view = { state: EditorState.create({ doc }), nodeDOM: () => wrapper };
    expect(getInlineAtomBoundaryCaretRect(view as never, 1)?.left).toBe(95);
    expect(getInlineAtomBoundaryCaretRect(view as never, 2)?.left).toBe(242);
    card.style.direction = 'rtl';
    expect(getInlineAtomBoundaryCaretRect(view as never, 1)?.left).toBe(242);
    expect(getInlineAtomBoundaryCaretRect(view as never, 2)?.left).toBe(95);
    wrapper.remove();
  });
});

describe('separate StableCaret instances in nested editors', () => {
  const editors: Editor[] = [];
  afterEach(() => {
    editors.splice(0).reverse().forEach((editor) => editor.destroy());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('uses the same caret for text and both card edges, and restores native selection during composition', () => {
    vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    const frames = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextId, callback);
      return nextId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const flush = () => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(0));
    };
    const Chip = TiptapNode.create({
      name: 'chip', inline: true, atom: true, group: 'inline',
      renderHTML: () => ['span'],
      addNodeView: () => () => createInlineAtomNodeView({
        caretGeometry: 'single-line',
        wrapperClassName: 'agent-composer__inline-atom-wrapper', label: '计划模式',
      }),
    });
    const mount = document.createElement('div');
    mount.contentEditable = 'false';
    const NestedComposer = TiptapNode.create({
      name: 'nestedComposer', group: 'block', atom: true,
      renderHTML: () => ['div'],
      addNodeView: () => () => ({ dom: mount, ignoreMutation: () => true }),
    });
    const parentMount = document.createElement('div');
    document.body.append(parentMount);
    const parent = new Editor({
      element: parentMount, extensions: [StarterKit, NestedComposer, StableCaret],
      content: { type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'text', text: '正文' }] },
        { type: 'nestedComposer' },
      ] },
      editorProps: { attributes: { style: 'font-size: 16px' } },
    });
    editors.push(parent);
    const parentCaret = document.body.querySelector<HTMLElement>('.stable-editor-caret--document')!;
    setRect(parent.view.dom, { left: 0, right: 500, top: 0, bottom: 100, width: 500, height: 100 });
    vi.spyOn(parent.view, 'coordsAtPos').mockReturnValue({ left: 20, right: 20, top: 20, bottom: 46 });
    // EditorView can report focus in a nested editable as parent focus too.
    vi.spyOn(parent.view, 'hasFocus').mockReturnValue(true);
    const editor = new Editor({
      element: mount,
      extensions: [StarterKit, Chip, ComposerStableCaret],
      editorProps: { attributes: { class: 'agent-composer__input-content', style: 'font-size: 16px' } },
      content: { type: 'doc', content: [{ type: 'paragraph', content: [
        { type: 'text', text: 'x' }, { type: 'chip' }, { type: 'text', text: 'yz' },
      ] }] },
    });
    editors.push(editor);
    setRect(editor.view.dom, { left: 0, right: 500, top: 0, bottom: 100, width: 500, height: 100 });
    const card = editor.view.dom.querySelector<HTMLElement>('[data-inline-atom-card]')!;
    setRect(card, { left: 100, right: 240, top: 20, bottom: 46, width: 140, height: 26 });
    vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ left: 20, right: 20, top: 20, bottom: 46 });
    editor.view.dom.focus();
    editor.commands.setTextSelection(2);
    flush();
    const caret = document.body.querySelector<HTMLElement>('.agent-composer__stable-caret')!;
    expect(caret.hidden).toBe(false);
    expect(caret.style.left).toBe('97px');
    expect(caret.style.width).toBe('2px');
    expect(editor.view.dom.classList.contains('has-composer-stable-caret')).toBe(true);
    expect(parentCaret.hidden).toBe(true);
    expect(parent.view.dom.classList.contains('has-document-stable-caret')).toBe(false);
    editor.commands.setTextSelection(3);
    flush();
    expect(caret.style.left).toBe('241px');
    editor.commands.setTextSelection(4);
    flush();
    expect(caret.style.left).toBe('20px');
    expect(document.body.querySelectorAll('.stable-editor-caret--document:not([hidden])')).toHaveLength(0);
    expect(document.body.querySelectorAll('.agent-composer__stable-caret:not([hidden])')).toHaveLength(1);
    editor.commands.setTextSelection({ from: 1, to: 4 });
    flush();
    expect(caret.hidden).toBe(true);
    editor.commands.setTextSelection(2);
    flush();
    vi.spyOn(editor.view, 'composing', 'get').mockReturnValue(true);
    editor.view.dom.dispatchEvent(new Event('compositionstart'));
    flush();
    expect(caret.hidden).toBe(true);
    expect(editor.view.dom.classList.contains('has-composer-stable-caret')).toBe(false);
    parent.view.dom.focus();
    parent.commands.setTextSelection(1);
    flush();
    expect(parentCaret.hidden).toBe(false);
    expect(parentCaret.style.width).toBe(caret.style.width);
    expect(parentCaret.style.height).toBe(caret.style.height);
    expect(caret.hidden).toBe(true);
  });
});
