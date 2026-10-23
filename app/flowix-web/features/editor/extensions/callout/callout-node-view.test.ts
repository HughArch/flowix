import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMarkdownEditorExtensions } from '../../markdown-editor-extensions';

const editors: Editor[] = [];

function createEditor(content: JSONContent): Editor {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: createMarkdownEditorExtensions({
      getOwnerPath: () => undefined,
      getAttachmentNotebookId: () => undefined,
      workspaceHost: 'main-third',
      getPlaceholder: () => '',
      getHeadingFoldLabels: () => ({ fold: '', unfold: '' }),
    }),
    content,
    contentType: 'json',
  });
  editors.push(editor);
  return editor;
}

function calloutDocument(icon = '💡', color = 'gray'): JSONContent {
  return {
    type: 'doc',
    content: [{
      type: 'callout',
      attrs: { icon, color },
      content: [{ type: 'paragraph' }],
    }],
  };
}

function iconButton(editor: Editor): HTMLButtonElement {
  const button = editor.view.dom.querySelector('.flowix-callout-icon');
  if (!(button instanceof HTMLButtonElement)) throw new Error('missing callout icon button');
  return button;
}

function pickerPanel(): HTMLElement | null {
  return document.body.querySelector('.flowix-callout-picker');
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  document.body.innerHTML = '';
});

describe('callout node view', () => {
  it('renders the icon and colour from the node attributes', () => {
    const editor = createEditor(calloutDocument('⚠️', 'yellow'));
    const dom = editor.view.dom.querySelector('.flowix-callout') as HTMLElement;

    expect(dom.dataset.color).toBe('yellow');
    expect(iconButton(editor).textContent).toBe('⚠️');
  });

  it('renders flag icons as bundled SVG artwork', () => {
    const editor = createEditor(calloutDocument('🇨🇳', 'gray'));
    const image = editor.view.dom.querySelector<HTMLImageElement>('.flowix-callout-icon img');

    expect(image).toBeTruthy();
    expect(image!.getAttribute('src')).toContain('1f1e8-1f1f3');
    expect(image!.alt).toBe('🇨🇳');
  });

  it('opens the picker and applies a new icon', () => {
    const editor = createEditor(calloutDocument());
    iconButton(editor).click();

    const panel = pickerPanel();
    expect(panel).toBeTruthy();

    const choices = panel!.querySelectorAll<HTMLButtonElement>('.flowix-callout-picker__icon');
    expect(choices.length).toBeGreaterThan(0);
    const nextIcon = choices[3].textContent!;
    choices[3].click();

    expect(editor.state.doc.firstChild!.attrs.icon).toBe(nextIcon);
    expect(iconButton(editor).textContent).toBe(nextIcon);
    expect(pickerPanel()).toBeNull();
  });

  it('applies a scenario preset', () => {
    const editor = createEditor(calloutDocument());
    iconButton(editor).click();

    const presets = document.querySelectorAll<HTMLButtonElement>('.flowix-callout-picker__preset');
    expect(presets).toHaveLength(4);

    document.querySelector<HTMLButtonElement>('[data-preset="success"]')!.click();

    expect(editor.state.doc.firstChild!.attrs).toMatchObject({ icon: '✅', color: 'green' });
    expect(pickerPanel()).toBeNull();
  });

  it('applies a background colour from the picker', () => {
    const editor = createEditor(calloutDocument());
    iconButton(editor).click();

    const swatches = document.body.querySelectorAll<HTMLButtonElement>(
      '.flowix-callout-picker__swatch',
    );
    expect(swatches.length).toBe(9);
    swatches[0].click();

    expect(editor.state.doc.firstChild!.attrs.color).toBe('red');
    expect(
      (editor.view.dom.querySelector('.flowix-callout') as HTMLElement).dataset.color,
    ).toBe('red');
  });

  it('loads the full catalog into category tabs', async () => {
    const editor = createEditor(calloutDocument());
    iconButton(editor).click();
    const panel = pickerPanel()!;

    await vi.waitFor(() => {
      expect(panel.querySelectorAll('.flowix-callout-picker__tab')).toHaveLength(10);
    }, { timeout: 5000 });

    const tabs = panel.querySelectorAll<HTMLButtonElement>('.flowix-callout-picker__tab');
    // Common + the nine Unicode groups; no component/skin-tone group.
    expect(Array.from(tabs).map((tab) => tab.textContent)).not.toContain('Component');

    // Switching to "Smileys & emotion" renders that group's full set.
    tabs[1].click();
    expect(
      panel.querySelectorAll('.flowix-callout-picker__icon').length,
    ).toBeGreaterThan(40);

    // "People" contains ZWJ sequences; they must be marked wide so the grid
    // scales them down instead of letting them overlap neighbours.
    tabs[2].click();
    expect(
      panel.querySelectorAll('.flowix-callout-picker__icon[data-wide]').length,
    ).toBeGreaterThan(0);

    // Flags render as bundled SVGs, not platform font glyphs.
    tabs[9].click();
    expect(
      panel.querySelectorAll('.flowix-callout-picker__icon img').length,
    ).toBeGreaterThan(0);
  });

  it('searches across categories and applies the first result', async () => {
    const editor = createEditor(calloutDocument());
    iconButton(editor).click();
    const panel = pickerPanel()!;

    const input = panel.querySelector<HTMLInputElement>('.flowix-callout-picker__search')!;
    await vi.waitFor(() => {
      expect(input.disabled).toBe(false);
    }, { timeout: 5000 });

    input.value = 'apple';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const results = Array.from(
      panel.querySelectorAll<HTMLButtonElement>('.flowix-callout-picker__icon'),
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((button) => /apple|苹果/i.test(button.title))).toBe(true);

    const nextIcon = results[0].textContent!;
    results[0].click();
    expect(editor.state.doc.firstChild!.attrs.icon).toBe(nextIcon);
  });

  it('closes the picker when the editor is destroyed', () => {
    const editor = createEditor(calloutDocument());
    iconButton(editor).click();
    expect(pickerPanel()).toBeTruthy();

    editor.destroy();
    editors.splice(editors.indexOf(editor), 1);
    expect(pickerPanel()).toBeNull();
  });
});
