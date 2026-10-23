import { createElement as createReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NotePropertyImageValue } from '@features/document/properties/image-value-input';
import { getWorkspaceMemoState } from '@features/memo/public/workspace-api';
import { parsePropertyInput } from '@features/document/properties/frontmatter-model';
import { renderFrontmatterPropertyValue } from './frontmatter-property-value';
import { translate } from '@/lib/i18n';
import { getPropertyTypeDefinition, type PropertyKind } from '@/lib/property-types';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { createPropertySvgIcon } from '@features/document/properties/property-type-icon';
import { canonicalizePropertyKey } from '@features/properties/property-key';
import { FrontmatterPropertyEditor, resolveRuntimePropertyPreset } from './frontmatter-property-editor';

interface DraftRowHandle { flush(): void; dispose(): void; render(): void; cancel(): void }
const rows = new WeakMap<HTMLElement, DraftRowHandle>();

export function closeEmptyPropertyRowEditor(row: HTMLElement) { rows.get(row)?.cancel(); }
export function refreshEmptyPropertyRow(row: HTMLElement) { rows.get(row)?.render(); }
export function flushEmptyPropertyRow(row: HTMLElement) { rows.get(row)?.flush(); }
export function destroyEmptyPropertyRow(row: HTMLElement) {
  rows.get(row)?.dispose();
  rows.delete(row);
}

/** The regular key/value editor with a local draft until the key is nonempty. */
export function createEmptyPropertyRow(
  editable: () => boolean,
  commit: (key: string, value: string, kind?: PropertyKind, storageKind?: PropertyKind) => boolean | void,
  getAttachmentNotebookId?: () => string | undefined,
): HTMLElement {
  const language = getCurrentAppLanguage();
  const row = document.createElement('div');
  row.className = 'frontmatter-property__display frontmatter-property__empty-row';
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  const key = document.createElement('span');
  key.className = 'frontmatter-property__display-key frontmatter-property__empty-key';
  const value = document.createElement('div');
  value.className = 'frontmatter-property__display-value frontmatter-property__empty-value';
  const label = document.createElement('span');
  label.className = 'frontmatter-property__key';
  key.append(label);
  let draftKey = '';
  let draftValue = '';
  let kind: PropertyKind = 'Text';
  let storageKind: PropertyKind = 'Text';
  let committed = false;
  let imageRoot: Root | null = null;
  let displaySignature = '';
  const render = () => {
    const definition = getPropertyTypeDefinition(kind);
    icon.className = `frontmatter-property__type-icon frontmatter-property__type-icon--${definition.displayKind}`;
    const keyIsEmpty = draftKey.trim().length === 0;
    icon.classList.toggle('frontmatter-property__type-icon--disabled', keyIsEmpty);
    icon.setAttribute('aria-disabled', String(keyIsEmpty));
    icon.title = translate(language, definition.labelKey);
    icon.replaceChildren(createPropertySvgIcon(definition.displayKind));
    label.textContent = draftKey || translate(language, 'document.properties.title');
    key.title = draftKey;
    const signature = JSON.stringify([draftKey, draftValue, kind, storageKind, editable()]);
    if (signature === displaySignature) return;
    displaySignature = signature;
    if (kind === 'Image') {
      value.dataset.propertyType = 'Image';
      imageRoot ??= createRoot(value);
      const notebookId = getAttachmentNotebookId?.();
      const notebook = getWorkspaceMemoState().notebooks.find((item) => item.id === notebookId);
      imageRoot.render(createReactElement(NotePropertyImageValue, {
        value: draftValue, notebook, disabled: !editable(),
        onChange: (path: string) => {
          if (!editable() || committed) return;
          draftValue = path;
          storageKind = 'Image';
          render();
          save();
        },
      }));
      return;
    }
    imageRoot?.unmount();
    imageRoot = null;
    delete value.dataset.propertyType;
    let parsedValue: unknown = draftValue;
    try {
      parsedValue = parsePropertyInput(draftValue, storageKind, undefined);
    } catch {
      // Keep an invalid draft available for correction in the regular editor.
    }
    const rendered = renderFrontmatterPropertyValue({ key: draftKey, value: parsedValue }, definition.displayKind, kind, {
      isEditable: editable,
      onBooleanChange: (checked) => {
        if (!editable()) return;
        draftValue = String(checked);
        render();
        save();
      },
      t: (key, params) => translate(language, key, params),
    });
    value.classList.toggle('frontmatter-property__display-value--checkbox', rendered.classList.contains('frontmatter-property__display-value--checkbox'));
    value.replaceChildren(...rendered.childNodes);
  };
  const save = () => {
    if (committed || !draftKey.trim()) return;
    committed = commit(draftKey.trim(), draftValue, kind, storageKind) !== false;
  };
  const editor = new FrontmatterPropertyEditor({
    ownerDocument: row.ownerDocument,
    isEditable: editable,
    getYaml: () => '',
    getDeclaredTypes: () => ({}),
    onSave: (edit) => {
      if (edit.target === 'key') {
        draftKey = edit.control.getValue().trim();
        const preset = resolveRuntimePropertyPreset(draftKey);
        if (preset) kind = storageKind = preset.kind;
      } else {
        draftValue = edit.control.getValue();
        kind = edit.kind ?? 'Text';
        storageKind = edit.control.storageKind;
      }
      render();
      save();
    },
  });
  const open = (cell: HTMLElement, target: 'key' | 'value') => {
    if (committed || !row.isConnected || (target === 'value' && kind === 'Image')) return;
    editor.open({ key: draftKey, value: draftValue }, cell, target, { kind, value: draftValue });
  };
  for (const [cell, target] of [[key, 'key'], [value, 'value']] as const) {
    cell.addEventListener('click', (event) => {
      const eventTarget = event.target;
      if (eventTarget instanceof Element && eventTarget.closest('button, input, textarea, select')) return;
      if (eventTarget instanceof HTMLAnchorElement) event.preventDefault();
      open(cell, target);
    });
    cell.addEventListener('keydown', (event: Event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (!editable() || (keyboardEvent.key !== 'Enter' && keyboardEvent.key !== ' ')) return;
      event.preventDefault();
      open(cell, target);
    });
  }
  const pointerDown = (event: Event) => {
    const active = editor.activePropertyEdit;
    const target = event.target;
    if (active && target instanceof Node && !active.popover.contains(target)
      && !(target instanceof Element && target.closest('.frontmatter-property__date-picker-popover'))) {
      const cell = target instanceof Element
        ? target.closest('.frontmatter-property__empty-key, .frontmatter-property__empty-value') : null;
      const root = row.closest('.ProseMirror');
      editor.savePropertyEdit();
      // Saving the first key promotes the draft to a regular property. Keep the
      // click on the other cell working even though the old row was replaced.
      if (committed && cell && row.contains(cell) && root && !row.isConnected) {
        const selector = cell === key ? '.frontmatter-property__display-key' : '.frontmatter-property__display-value';
        queueMicrotask(() => {
          const saved = [...root.querySelectorAll<HTMLElement>('[data-property-key]')]
            .find((item) => item.dataset.propertyKey === canonicalizePropertyKey(draftKey));
          saved?.querySelector<HTMLElement>(selector)?.click();
        });
      }
    }
  };
  row.ownerDocument.addEventListener('pointerdown', pointerDown, true);
  rows.set(row, {
    render,
    cancel: () => editor.closePropertyEditor(),
    flush: () => { editor.savePropertyEdit(); save(); },
    dispose: () => {
      editor.closePropertyEditor();
      imageRoot?.unmount();
      row.ownerDocument.removeEventListener('pointerdown', pointerDown, true);
    },
  });
  render();
  row.append(icon, key, value);
  return row;
}
