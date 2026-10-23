import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import Frontmatter from './frontmatter';
import { parseVisibleFrontmatter } from '@features/document/properties/frontmatter-model';
import { useSettingsStore } from '@/lib/store/settings-store';

function fixture() {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = new Editor({
    element: host,
    extensions: [StarterKit, Markdown, Frontmatter],
    content: '---\nenabled: false\nfirst: old\nsecond: next\n---\nBody',
    contentType: 'markdown',
  });
  const setEditable = (editable: boolean) => {
    editor.view.dom.dispatchEvent(new Event('flowix:editor-flush-drafts'));
    editor.setEditable(editable, false);
    editor.view.dom.dispatchEvent(new Event('flowix:editor-editability-change'));
  };
  const value = (key: string) => host.querySelector<HTMLElement>(`[data-property-key="${key}"] .frontmatter-property__display-value`)!;
  const draft = () => document.body.querySelector<HTMLTextAreaElement>('.frontmatter-property__edit-input')!;
  return { host, editor, setEditable, value, draft, dispose: () => { editor.destroy(); host.remove(); } };
}

function editCell(cell: HTMLElement, value: string) {
  cell.click();
  const input = document.body.querySelector<HTMLInputElement | HTMLTextAreaElement>('.frontmatter-property__edit-input')!;
  input.value = value;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
}

describe('frontmatter workspace interactions', () => {
  it('keeps the empty row mounted through visibility changes without changing saved content', () => {
    const previousVisible = useSettingsStore.getState().propertiesVisible;
    useSettingsStore.setState({ propertiesVisible: false });
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter.configure({ propertyTargetId: 'empty-note' })],
      content: 'Body',
      contentType: 'markdown',
    });
    try {
      const container = host.querySelector<HTMLElement>('[data-empty-properties]')!;
      const initialRow = host.querySelector<HTMLElement>('.frontmatter-property__empty-row');
      expect(initialRow).not.toBeNull();
      expect(container.dataset.visible).toBe('false');
      expect(container.inert).toBe(true);
      expect(container.getAttribute('aria-hidden')).toBe('true');
      useSettingsStore.setState({ propertiesVisible: true });
      const row = host.querySelector<HTMLElement>('.frontmatter-property__empty-row');
      expect(row).toBe(initialRow);
      expect(container.dataset.visible).toBe('true');
      expect(container.inert).toBe(false);
      expect(row!.querySelector('.frontmatter-property__type-icon--text')).not.toBeNull();
      const key = row!.querySelector<HTMLElement>('.frontmatter-property__empty-key')!;
      const value = row!.querySelector<HTMLElement>('.frontmatter-property__empty-value')!;
      const icon = row!.querySelector<HTMLElement>('.frontmatter-property__type-icon')!;
      // A draft row has nothing to reorder or delete, so its icon stays a plain
      // type indicator instead of opening a half-disabled menu.
      expect(icon.getAttribute('role')).toBeNull();
      expect(icon.hasAttribute('tabindex')).toBe(false);
      icon.click();
      expect(document.body.querySelector('.frontmatter-property__item-menu')).toBeNull();
      // The action bar is reachable before the first property exists.
      const actions = container.querySelectorAll<HTMLElement>('.frontmatter-property__actions');
      expect(actions).toHaveLength(1);
      expect(actions[0].querySelectorAll('button')).toHaveLength(2);
      expect(editor.getMarkdown().trim()).toBe('Body');

      editCell(value, 'local draft');
      useSettingsStore.setState({ propertiesVisible: false });
      expect(host.querySelector('[data-empty-properties]')).toBe(container);
      expect(host.querySelector('.frontmatter-property__empty-row')).toBe(row);
      expect(container.dataset.visible).toBe('false');
      expect(container.inert).toBe(true);
      useSettingsStore.setState({ propertiesVisible: true });
      expect(host.querySelector('.frontmatter-property__empty-row')).toBe(row);
      expect(value.textContent).toBe('local draft');
      expect(editor.getMarkdown().trim()).toBe('Body');
      key.click();
      const keyInput = document.body.querySelector<HTMLInputElement>('.frontmatter-property__edit-input')!;
      keyInput.value = 'cancelled';
      keyInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(editor.getMarkdown().trim()).toBe('Body');
      expect(editor.state.doc.firstChild?.type.name).toBe('paragraph');
      editCell(value, 'hello');
      editCell(key, 'summary');
      expect(host.querySelector('.frontmatter-property__empty-row')).toBeNull();
      expect(editor.getMarkdown()).toContain('summary: hello');

    } finally {
      editor.destroy();
      host.remove();
      useSettingsStore.setState({ propertiesVisible: previousVisible });
    }
  });

  it('commits a draft with the kind of the matching preset', () => {
    const previousVisible = useSettingsStore.getState().propertiesVisible;
    useSettingsStore.setState({ propertiesVisible: true });
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter.configure({ propertyTargetId: 'preset-note' })],
      content: 'Body',
      contentType: 'markdown',
    });
    try {
      const key = host.querySelector<HTMLElement>('.frontmatter-property__empty-key')!;
      const value = host.querySelector<HTMLElement>('.frontmatter-property__empty-value')!;
      editCell(value, 'alpha, beta');
      editCell(key, 'tags');
      // `tags` is a built-in preset, so the draft must land as a tag list
      // rather than the `tags: alpha, beta` scalar a plain Text row produces.
      expect(editor.getMarkdown()).toMatch(/tags: \[\s*alpha,\s*beta\s*\]/);
    } finally {
      editor.destroy();
      host.remove();
      useSettingsStore.setState({ propertiesVisible: previousVisible });
    }
  });

  it('keeps an invalid draft in place without writing to the document', () => {
    const previousVisible = useSettingsStore.getState().propertiesVisible;
    useSettingsStore.setState({ propertiesVisible: true });
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter.configure({ propertyTargetId: 'invalid-note' })],
      content: 'Body',
      contentType: 'markdown',
    });
    try {
      const key = host.querySelector<HTMLElement>('.frontmatter-property__empty-key')!;
      const value = host.querySelector<HTMLElement>('.frontmatter-property__empty-value')!;
      editCell(value, 'x');
      editCell(key, 'flowix_property_types');
      expect(editor.getMarkdown().trim()).toBe('Body');
      expect(key.textContent).toBe('flowix_property_types');
    } finally {
      editor.destroy();
      host.remove();
      useSettingsStore.setState({ propertiesVisible: previousVisible });
    }
  });

  it.each(['Body', '---\n\n---\nBody'])('uses the regular key/value popovers and retains a typed draft for %j', (content) => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter.configure({ propertyTargetId: 'unified-draft' })],
      content, contentType: 'markdown',
    });
    try {
      const original = editor.getMarkdown();
      const key = host.querySelector<HTMLElement>('.frontmatter-property__empty-key')!;
      const value = host.querySelector<HTMLElement>('.frontmatter-property__empty-value')!;
      expect(key.querySelector('input')).toBeNull();
      key.getBoundingClientRect = value.getBoundingClientRect = () => new DOMRect(100, 80, 120, 30);
      key.click();
      let popup = document.body.querySelector<HTMLElement>('.frontmatter-property__edit-popover')!;
      expect(popup.style.top).toBe('80px');
      const keyInput = popup.querySelector<HTMLInputElement>('input')!;
      keyInput.value = '   ';
      keyInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(editor.getMarkdown()).toBe(original);

      value.click();
      popup = document.body.querySelector<HTMLElement>('.frontmatter-property__edit-popover')!;
      expect(popup.style.top).toBe('80px');
      expect(popup.style.left).toBe('100px');
      const types = [...popup.querySelectorAll<HTMLElement>('.frontmatter-property__edit-type-option')].map((item) => item.dataset.value);
      popup.querySelector<HTMLButtonElement>('.frontmatter-property__edit-type-trigger')!.click();
      popup.querySelector<HTMLButtonElement>('[data-value="Number"]')!.click();
      let number = popup.querySelector<HTMLInputElement>('input[type="number"]')!;
      number.value = '42';
      number.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      expect(editor.getMarkdown()).toBe(original);
      value.click();
      popup = document.body.querySelector<HTMLElement>('.frontmatter-property__edit-popover')!;
      number = popup.querySelector<HTMLInputElement>('input[type="number"]')!;
      expect(number.value).toBe('42');
      number.value = '99';
      number.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      editCell(key, 'score');
      const parsed = parseVisibleFrontmatter(String(editor.state.doc.firstChild?.attrs.yamlContent ?? ''));
      expect(parsed.data.score).toBe(42);
      expect(parsed.data.flowix_property_types).toMatchObject({ score: 'Number' });
      expect(host.querySelector('.frontmatter-property__empty-row')).toBeNull();
      const savedValue = host.querySelector<HTMLElement>('[data-property-key="score"] .frontmatter-property__display-value')!;
      savedValue.getBoundingClientRect = () => new DOMRect(100, 80, 120, 30);
      savedValue.click();
      popup = document.body.querySelector<HTMLElement>('.frontmatter-property__edit-popover')!;
      expect(popup.style.top).toBe('80px');
      expect(popup.style.left).toBe('100px');
      expect([...popup.querySelectorAll<HTMLElement>('.frontmatter-property__edit-type-option')].map((item) => item.dataset.value)).toEqual(types);
      expect(popup.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('42');
    } finally { editor.destroy(); host.remove(); }
  });

  it.each(['Body', '---\n\n---\nBody'])('uses the regular Boolean value control without saving an empty key for %j', (content) => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter.configure({ propertyTargetId: 'boolean-draft' })],
      content, contentType: 'markdown',
    });
    try {
      const original = editor.getMarkdown();
      host.querySelector<HTMLElement>('.frontmatter-property__empty-value')!.click();
      const popup = document.body.querySelector<HTMLElement>('.frontmatter-property__edit-popover')!;
      popup.querySelector<HTMLButtonElement>('.frontmatter-property__edit-type-trigger')!.click();
      popup.querySelector<HTMLButtonElement>('[data-value="Boolean"]')!.click();
      popup.querySelector<HTMLInputElement>('input[type="checkbox"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      const checkbox = host.querySelector<HTMLInputElement>('.frontmatter-property__empty-row .frontmatter-property__value-checkbox')!;
      expect(checkbox.checked).toBe(false);
      checkbox.click();
      expect(editor.getMarkdown()).toBe(original);
      editCell(host.querySelector<HTMLElement>('.frontmatter-property__empty-key')!, 'enabled');
      const parsed = parseVisibleFrontmatter(String(editor.state.doc.firstChild?.attrs.yamlContent ?? ''));
      expect(parsed.data.enabled).toBe(true);
      expect(parsed.data.flowix_property_types).toMatchObject({ enabled: 'Boolean' });
    } finally { editor.destroy(); host.remove(); }
  });

  it.each(['Body', '---\n\n---\nBody'])('keeps the value click working while saving the first key for %j', async (content) => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Markdown, Frontmatter.configure({ propertyTargetId: 'draft-handoff' })],
      content, contentType: 'markdown',
    });
    try {
      host.querySelector<HTMLElement>('.frontmatter-property__empty-key')!.click();
      document.body.querySelector<HTMLInputElement>('.frontmatter-property__edit-input')!.value = 'summary';
      const next = host.querySelector<HTMLElement>('.frontmatter-property__empty-value')!;
      next.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      next.click();
      await Promise.resolve();
      expect(host.querySelector('[data-property-key="summary"]')).not.toBeNull();
      const input = document.body.querySelector<HTMLTextAreaElement>('textarea.frontmatter-property__edit-input')!;
      expect(input).not.toBeNull();
      input.value = 'hello';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      expect(editor.getMarkdown()).toContain('summary: hello');
    } finally { editor.destroy(); host.remove(); }
  });

  it('updates the same checkbox across read-only transitions and guards stale change events', () => {
    const f = fixture();
    try {
      const checkbox = f.host.querySelector<HTMLInputElement>('.frontmatter-property__value-checkbox')!;
      f.setEditable(false);
      expect(checkbox.disabled).toBe(true);
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      expect(f.editor.getMarkdown()).toContain('enabled: false');
      f.setEditable(true);
      expect(f.host.querySelector('.frontmatter-property__value-checkbox')).toBe(checkbox);
      expect(checkbox.disabled).toBe(false);
      checkbox.checked = false;
      checkbox.click();
      expect(f.editor.getMarkdown()).toContain('enabled: true');
    } finally { f.dispose(); }
  });

  it('keeps the saved property icon menu actions working', () => {
    const f = fixture();
    try {
      const icon = f.host.querySelector<HTMLElement>('[data-property-key="first"] .frontmatter-property__type-icon')!;
      icon.click();
      const actions = document.body.querySelectorAll<HTMLButtonElement>('.frontmatter-property__item-menu [role="menuitem"]');
      expect(actions).toHaveLength(3);
      expect(actions[0].disabled).toBe(false);
      expect(actions[1].disabled).toBe(false);
      actions[2].click();
      expect(f.host.querySelector('[data-property-key="first"]')).toBeNull();
      expect(f.editor.getMarkdown()).not.toContain('first:');
    } finally { f.dispose(); }
  });

  it('commits a draft before the editor becomes read-only', () => {
    const f = fixture();
    try {
      f.value('first').click();
      f.draft().value = 'saved';
      f.setEditable(false);
      expect(f.editor.getMarkdown()).toContain('first: saved');
      expect(document.body.querySelector('.frontmatter-property__edit-popover')).toBeNull();
    } finally { f.dispose(); }
  });

  it('preserves the next pointer target while saving another property', () => {
    const f = fixture();
    try {
      f.value('first').click();
      f.draft().value = 'saved';
      const next = f.value('second');
      const list = next.closest('.frontmatter-property__list');
      next.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      expect(f.editor.getMarkdown()).toContain('first: saved');
      expect(f.value('second')).toBe(next);
      expect(next.isConnected).toBe(true);
      expect(next.closest('.frontmatter-property__list')).toBe(list);
      next.click();
      expect(f.draft().value).toBe('next');
    } finally { f.dispose(); }
  });
});
