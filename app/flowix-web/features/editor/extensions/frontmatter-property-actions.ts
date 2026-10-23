import { createElement as createReactElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PlusIcon } from '@phosphor-icons/react';
import { MousePointerClick } from 'lucide-react';

export interface PropertyActionsHandle {
  readonly element: HTMLElement;
  setEditable(editable: boolean): void;
  setPopupOpen(open: boolean): void;
  dispose(): void;
}

interface PropertyActionsOptions {
  propertyTargetId?: string;
  isEditable: () => boolean;
  pickerLabel: string;
  addLabel: string;
}

/**
 * The floating "pick a property" / "add a property" bar.
 *
 * Both the frontmatter node view and the empty-properties widget mount this so
 * a document renders the exact same entry points whether or not it already
 * carries frontmatter.
 */
export function createPropertyActions(
  options: PropertyActionsOptions,
): PropertyActionsHandle | null {
  const { propertyTargetId, isEditable } = options;
  if (!propertyTargetId) return null;

  const roots: Root[] = [];
  const element = document.createElement('div');
  element.className = 'frontmatter-property__actions';

  const mountIcon = (host: HTMLElement, icon: ReactElement) => {
    const root = createRoot(host);
    roots.push(root);
    root.render(icon);
  };

  const createAction = (label: string, eventName: string) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'frontmatter-property__action';
    button.title = label;
    button.setAttribute('aria-label', label);
    const iconHost = document.createElement('span');
    iconHost.className = 'frontmatter-property__action-icon';
    button.append(iconHost);
    button.addEventListener('click', () => {
      if (!isEditable()) return;
      window.dispatchEvent(new CustomEvent(eventName, {
        detail: {
          propertyTargetId,
          anchorRect: button.getBoundingClientRect(),
        },
      }));
    });
    return { button, iconHost };
  };

  const select = createAction(options.pickerLabel, 'flowix:open-property-picker');
  mountIcon(select.iconHost, createReactElement(MousePointerClick, {
    className: 'h-4 w-4',
    'aria-hidden': true,
  }));

  const add = createAction(options.addLabel, 'flowix:open-add-property');
  mountIcon(add.iconHost, createReactElement(PlusIcon, {
    size: 16,
    weight: 'bold',
    'aria-hidden': true,
  }));

  element.append(select.button, add.button);

  return {
    element,
    setEditable: (editable: boolean) => {
      element.hidden = !editable;
    },
    setPopupOpen: (open: boolean) => {
      element.dataset.popupOpen = String(open);
    },
    dispose: () => {
      roots.forEach((root) => root.unmount());
      roots.length = 0;
      element.remove();
    },
  };
}
