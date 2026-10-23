import type { PropertyKind } from '@/lib/property-types';
import { closeEmptyPropertyRowEditor, createEmptyPropertyRow, destroyEmptyPropertyRow, flushEmptyPropertyRow } from './frontmatter-empty-row';
import { createPropertyActions } from './frontmatter-property-actions';
import { syncFrontmatterEditability } from './frontmatter-interactions';
import { syncFrontmatterVisibility } from './frontmatter-visibility';

export interface EmptyPropertiesPanel {
  readonly root: HTMLElement;
  setVisible(visible: boolean): void;
  setEditable(editable: boolean): void;
  setPopupOpen(open: boolean): void;
  flush(): void;
  dispose(): void;
}

const panels = new WeakMap<HTMLElement, EmptyPropertiesPanel>();

export function getEmptyPropertiesPanel(root: HTMLElement): EmptyPropertiesPanel | undefined {
  return panels.get(root);
}

interface EmptyPropertiesPanelOptions {
  getAttachmentNotebookId?: () => string | undefined;
  propertyTargetId?: string;
  isEditable: () => boolean;
  visible: boolean;
  pickerLabel: string;
  addLabel: string;
  commit: (key: string, value: string, kind?: PropertyKind, storageKind?: PropertyKind) => boolean | void;
}

/**
 * The panel shown for a note that has no frontmatter yet. It renders the same
 * draft row and the same action bar as the frontmatter node view, so a note
 * gains its first property through exactly the same affordances as any other.
 *
 * Everything here stays local until `commit` runs; mounting the panel never
 * writes to the document.
 */
export function createEmptyPropertiesPanel(
  options: EmptyPropertiesPanelOptions,
): EmptyPropertiesPanel {
  const root = document.createElement('div');
  root.className = 'frontmatter-property-node';
  root.contentEditable = 'false';
  root.dataset.emptyProperties = 'true';

  const container = document.createElement('div');
  container.className = 'frontmatter-property';

  const list = document.createElement('div');
  list.className = 'frontmatter-property__list';
  const row = createEmptyPropertyRow(options.isEditable, options.commit, options.getAttachmentNotebookId);
  list.append(row);
  container.append(list);

  const actions = createPropertyActions({
    propertyTargetId: options.propertyTargetId,
    isEditable: options.isEditable,
    pickerLabel: options.pickerLabel,
    addLabel: options.addLabel,
  });
  if (actions) {
    actions.setEditable(options.isEditable());
    container.append(actions.element);
  }

  root.append(container);

  const panel: EmptyPropertiesPanel = {
    root,
    setVisible: (visible) => {
      if (!visible) closeEmptyPropertyRowEditor(row);
      syncFrontmatterVisibility(root, visible);
    },
    setEditable: (editable) => {
      if (!editable) flushEmptyPropertyRow(row);
      syncFrontmatterEditability(root, editable);
      actions?.setEditable(editable);
    },
    setPopupOpen: (open) => actions?.setPopupOpen(open),
    flush: () => flushEmptyPropertyRow(row),
    dispose: () => {
      destroyEmptyPropertyRow(row);
      actions?.dispose();
      panels.delete(root);
    },
  };

  panels.set(root, panel);
  panel.setVisible(options.visible);
  panel.setEditable(options.isEditable());
  return panel;
}
