import type { NodeViewRendererProps } from '@tiptap/core';
import type { Node as PMNode } from 'prosemirror-model';
import type { ViewMutationRecord } from 'prosemirror-view';
import { translate, type I18nKey } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import {
  deleteColumn,
  insertColumn,
  resolveColumnResize,
  setColumnWidths,
} from './columns-commands';
import { MAX_COLUMNS, normalizeColumnWidth } from './columns-markdown';

// NodeViews live outside the React tree and cannot use useI18n.
function tKey(key: I18nKey): string {
  return translate(getCurrentAppLanguage(), key);
}

function positionOf(getPos: () => number | undefined): number | null {
  const pos = getPos();
  return typeof pos === 'number' ? pos : null;
}

function isEmptyColumn(node: PMNode): boolean {
  if (node.childCount !== 1) return false;
  const onlyChild = node.firstChild;
  return !!onlyChild
    && onlyChild.type.name === 'paragraph'
    && onlyChild.content.size === 0;
}

export function columnsNodeView({ getPos, editor }: NodeViewRendererProps) {
  const dom = document.createElement('div');
  dom.className = 'flowix-columns-shell';

  const contentDOM = document.createElement('div');
  contentDOM.className = 'flowix-columns';
  dom.appendChild(contentDOM);

  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'flowix-columns-add';
  addButton.contentEditable = 'false';
  addButton.title = tKey('editor.block.addColumn');
  addButton.setAttribute('aria-label', tKey('editor.block.addColumn'));
  addButton.textContent = '+';
  dom.appendChild(addButton);

  const syncAddButton = (node: PMNode) => {
    addButton.hidden = node.childCount >= MAX_COLUMNS;
  };

  addButton.addEventListener('mousedown', (event) => event.preventDefault());
  addButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const pos = positionOf(getPos);
    if (pos !== null) insertColumn(editor, pos);
  });

  return {
    dom,
    contentDOM,
    update(updatedNode: PMNode) {
      if (updatedNode.type.name !== 'columns') return false;
      syncAddButton(updatedNode);
      return true;
    },
    stopEvent(event: Event) {
      return event.target instanceof Node && addButton.contains(event.target);
    },
    ignoreMutation(mutation: ViewMutationRecord) {
      return !contentDOM.contains(mutation.target as Node);
    },
  };
}

export function columnNodeView({ node, getPos, editor }: NodeViewRendererProps) {
  const dom = document.createElement('div');
  dom.className = 'flowix-column';
  dom.dataset.flowixColumn = '';

  const contentDOM = document.createElement('div');
  contentDOM.className = 'flowix-column-content';
  contentDOM.dataset.placeholder = tKey('editor.block.emptyColumn');
  dom.appendChild(contentDOM);

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'flowix-column-remove';
  removeButton.contentEditable = 'false';
  removeButton.title = tKey('editor.block.removeColumn');
  removeButton.setAttribute('aria-label', tKey('editor.block.removeColumn'));
  removeButton.textContent = '×';
  dom.appendChild(removeButton);

  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'flowix-column-resize-handle';
  resizeHandle.contentEditable = 'false';
  resizeHandle.title = tKey('editor.block.resizeColumn');
  resizeHandle.setAttribute('role', 'separator');
  resizeHandle.setAttribute('aria-orientation', 'vertical');
  dom.appendChild(resizeHandle);

  let dragState: {
    startX: number;
    widths: number[];
    columnsPos: number;
    index: number;
    containerWidth: number;
    last: number[];
  } | null = null;

  const columnLocation = () => {
    const pos = positionOf(getPos);
    if (pos === null) return null;
    try {
      const $pos = editor.state.doc.resolve(pos);
      // `getPos()` is the column's open position, so its parent is the
      // `columns` container and `index()` is the column index.
      if ($pos.parent.type.name !== 'columns') return null;
      const columnsPos = $pos.before();
      const columnsNode = editor.state.doc.nodeAt(columnsPos);
      if (!columnsNode || columnsNode.type.name !== 'columns') return null;
      return {
        columnsPos,
        columnsNode,
        index: $pos.index(),
        isLast: $pos.index() >= $pos.parent.childCount - 1,
      };
    } catch {
      return null;
    }
  };

  const sync = (current: PMNode) => {
    const width = normalizeColumnWidth(current.attrs.width);
    dom.style.flexGrow = String(width);
    dom.style.flexBasis = '0';
    dom.style.minWidth = '0';

    const empty = isEmptyColumn(current);
    if (empty) dom.dataset.empty = '';
    else delete dom.dataset.empty;

    const location = columnLocation();
    resizeHandle.hidden = location?.isLast ?? true;
    removeButton.hidden = !location;
  };

  sync(node);

  removeButton.addEventListener('mousedown', (event) => event.preventDefault());
  removeButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const location = columnLocation();
    if (location) deleteColumn(editor, location.columnsPos, location.index);
  });

  resizeHandle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const location = columnLocation();
    if (!location || location.isLast) return;

    const widths = Array.from(
      { length: location.columnsNode.childCount },
      (_, index) => normalizeColumnWidth(location.columnsNode.child(index).attrs.width),
    );
    const containerWidth = dom.closest('.flowix-columns')?.getBoundingClientRect().width ?? 0;
    if (containerWidth <= 0) return;

    dragState = {
      startX: event.clientX,
      widths,
      columnsPos: location.columnsPos,
      index: location.index,
      containerWidth,
      last: widths,
    };
    resizeHandle.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  });

  resizeHandle.addEventListener('pointermove', (event) => {
    if (!dragState) return;
    const next = resolveColumnResize(
      dragState.widths,
      dragState.index,
      event.clientX - dragState.startX,
      dragState.containerWidth,
    );
    if (next.every((width, index) => width === dragState!.last[index])) return;
    dragState.last = next;
    setColumnWidths(editor, dragState.columnsPos, next);
  });

  const endResize = (event: PointerEvent) => {
    if (!dragState) return;
    dragState = null;
    if (resizeHandle.hasPointerCapture(event.pointerId)) {
      resizeHandle.releasePointerCapture(event.pointerId);
    }
  };
  resizeHandle.addEventListener('pointerup', endResize);
  resizeHandle.addEventListener('pointercancel', endResize);

  return {
    dom,
    contentDOM,
    update(updatedNode: PMNode) {
      if (updatedNode.type.name !== 'column') return false;
      sync(updatedNode);
      return true;
    },
    stopEvent(event: Event) {
      return event.target instanceof Node
        && (removeButton.contains(event.target) || resizeHandle.contains(event.target));
    },
    ignoreMutation(mutation: ViewMutationRecord) {
      return !contentDOM.contains(mutation.target as Node);
    },
  };
}
