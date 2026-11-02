import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

export interface InlineAtomHoverAction {
  ariaLabel: string;
  title?: string;
  icon: Node;
  onClick: (event: MouseEvent) => void;
}

export interface InlineAtomNodeViewOptions {
  wrapperClassName?: string;
  wrapper?: HTMLSpanElement;
  /** Opt into border-based caret positioning for a single-line chip. */
  caretGeometry?: 'single-line';
  cardClassName?: string;
  leadingIcon?: Node;
  label?: string;
  labelClassName?: string;
  title?: string;
  ariaLabel?: string;
  content?: HTMLElement;
  onClick?: (event: MouseEvent) => void;
  onDoubleClick?: (event: MouseEvent) => void;
  remove?: {
    view: EditorView;
    node: ProseMirrorNode;
    getPos?: () => number | undefined;
  };
  hoverActions?: readonly InlineAtomHoverAction[];
  stopEvent?: (event: Event) => boolean;
}

/** Small close affordance shared by removable composer chips. */
export function createInlineAtomCloseIcon(): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 16 16");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "1.7");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m4 4 8 8M12 4l-8 8");
  icon.append(path);
  return icon;
}

/** Delete an inline atom at its current document position. */
export function deleteInlineAtomNode(
  view: EditorView,
  node: ProseMirrorNode,
  getPos?: () => number | undefined,
): void {
  const pos = getPos?.();
  if (pos === undefined) return;
  view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
  view.focus();
}

/**
 * Creates the shared shell and interaction surface for inline atom cards.
 * Card contents and actions stay type-specific; focus, selection, hover-action
 * plumbing, and caret landing points are handled consistently here.
 */
export function createInlineAtomNodeView(options: InlineAtomNodeViewOptions) {
  const wrapper = options.wrapper ?? document.createElement("span");
  if (options.wrapperClassName) wrapper.className = options.wrapperClassName;
  wrapper.classList.add("editor-inline-atom");
  wrapper.contentEditable = "false";
  if (options.caretGeometry) wrapper.setAttribute('data-inline-atom-caret', options.caretGeometry);

  const card = options.content ?? document.createElement("button");
  card.setAttribute("data-inline-atom-card", "");
  if (!options.content) {
    const button = card as HTMLButtonElement;
    button.type = "button";
    if (options.cardClassName) button.className = options.cardClassName;
    if (options.leadingIcon) {
      button.append(options.leadingIcon);
      const label = document.createElement("span");
      if (options.labelClassName) label.className = options.labelClassName;
      label.textContent = options.label ?? "";
      button.append(label);
    } else {
      button.textContent = options.label ?? "";
    }
  }
  if (wrapper.classList.contains("agent-composer__inline-atom-wrapper")) {
    // Give composer atoms one styling hook regardless of their node type.
    card.classList.add("agent-composer__inline-card");
  }
  if (options.title) card.title = options.title;
  if (options.ariaLabel) card.setAttribute("aria-label", options.ariaLabel);
  card.addEventListener("mousedown", (event) => event.preventDefault());

  const actions = options.hoverActions ?? [];
  const actionGroup = actions.length > 0 ? document.createElement("span") : null;
  if (actionGroup) {
    actionGroup.className = "agent-inline-atom__actions";
    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "agent-inline-atom__action";
      button.setAttribute("aria-label", action.ariaLabel);
      button.title = action.title ?? action.ariaLabel;
      button.append(action.icon);
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        action.onClick(event);
      });
      actionGroup.append(button);
    }
  }

  // Real text nodes provide browser caret landing points on both sides of the
  // non-editable atom; the trailing anchor stays after optional hover actions.
  wrapper.append(document.createTextNode("\u200B"), card);
  if (actionGroup) wrapper.append(actionGroup);
  wrapper.append(document.createTextNode("\u200B"));

  const remove = options.remove;
  const onClick = options.onClick ?? (remove
    ? () => deleteInlineAtomNode(remove.view, remove.node, remove.getPos)
    : undefined);
  if (onClick) {
    wrapper.addEventListener("click", (event) => {
      if ((event.target as Element | null)?.closest?.(".agent-inline-atom__actions")) return;
      event.preventDefault();
      event.stopPropagation();
      onClick(event);
    });
  }
  if (options.onDoubleClick) wrapper.addEventListener("dblclick", options.onDoubleClick);

  return {
    dom: wrapper,
    selectNode: () => setInlineAtomNodeViewSelected(wrapper, true),
    deselectNode: () => setInlineAtomNodeViewSelected(wrapper, false),
    ...(options.stopEvent ? { stopEvent: options.stopEvent } : {}),
    ignoreMutation: () => true,
  };
}

export function setInlineAtomNodeViewSelected(wrapper: HTMLElement, selected: boolean): void {
  wrapper.classList.toggle("is-selected", selected);
}

/** Delete an adjacent inline atom using the same Backspace/Delete behavior. */
export function deleteAdjacentInlineAtom(
  editor: Editor,
  nodeName: string,
  direction: "before" | "after",
): boolean {
  const { selection } = editor.state;
  if (selection instanceof NodeSelection && selection.node.type.name === nodeName) {
    editor.commands.deleteSelection();
    return true;
  }

  if (!selection.empty) return false;
  const { $from } = selection;
  const node = direction === "before" ? $from.nodeBefore : $from.nodeAfter;
  if (!node || node.type.name !== nodeName) return false;

  const from = direction === "before" ? $from.pos - node.nodeSize : $from.pos;
  editor.commands.deleteRange({ from, to: from + node.nodeSize });
  return true;
}
