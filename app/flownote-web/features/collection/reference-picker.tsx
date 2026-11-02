import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor } from '@tiptap/core';

export interface CollectionReferenceInsertRange {
  from: number;
  to: number;
}

export type CollectionReferencePickerAnchor =
  | { kind: 'slash'; rect: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'> }
  | { kind: 'button'; element: HTMLElement; align?: 'left' | 'right' };

export interface CollectionReferenceCandidate {
  notebookId: string;
  notebookName: string;
  notebookPath: string;
  relativePath: string;
  collectionId: string;
  name: string;
}

type PickerKind = 'table' | 'media-library';
type PickerContent = (generation: number, onClose: () => void) => ReactNode;

let pickerRoot: Root | null = null;
let pickerHost: HTMLDivElement | null = null;
let pickerAnchorActions: HTMLElement | null = null;
let pickerGeneration = 0;
const PICKER_WIDTH = 272;
const VIEWPORT_PADDING = 8;

export function normalizeCollectionPickerQuery(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function filterCollectionCandidates<T extends CollectionReferenceCandidate>(items: T[], query: string): T[] {
  const normalized = normalizeCollectionPickerQuery(query);
  if (!normalized) return items;
  return items.filter((item) => normalizeCollectionPickerQuery(
    `${item.name} ${item.notebookName} ${item.relativePath}`,
  ).includes(normalized));
}

export function collectionCandidateFolderLabel(candidate: CollectionReferenceCandidate): string {
  const folder = candidate.relativePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  return folder ? `${folder}/` : `${candidate.notebookName}/`;
}

export function isCollectionReferencePickerCurrent(generation: number): boolean {
  return pickerGeneration === generation && pickerRoot !== null;
}

export function closeCollectionReferencePicker(generation?: number) {
  if (generation !== undefined && generation !== pickerGeneration) return;
  pickerGeneration += 1;
  const root = pickerRoot;
  const host = pickerHost;
  pickerAnchorActions?.removeAttribute('data-reference-picker-open');
  pickerAnchorActions = null;
  pickerRoot = null;
  pickerHost = null;
  root?.unmount();
  host?.remove();
}

function updatePickerPosition(editor: Editor, position: number, anchor: CollectionReferencePickerAnchor) {
  const host = pickerHost;
  if (!host || editor.isDestroyed) return;
  try {
    const coords = editor.view.coordsAtPos(position);
    const rect = anchor.kind === 'button' && anchor.element.isConnected
      ? anchor.element.getBoundingClientRect()
      : anchor.kind === 'slash' ? anchor.rect : coords;
    const width = Math.min(PICKER_WIDTH, window.innerWidth - VIEWPORT_PADDING * 2);
    const maxHeight = Math.max(0, Math.min(320, window.innerHeight - VIEWPORT_PADDING * 2));
    host.style.width = `${width}px`;
    host.style.maxHeight = `${maxHeight}px`;
    const height = Math.min(host.offsetHeight || maxHeight, maxHeight);
    const requestedTop = anchor.kind === 'button' ? rect.bottom : rect.top;
    host.style.top = `${Math.min(Math.max(requestedTop, VIEWPORT_PADDING), Math.max(VIEWPORT_PADDING, window.innerHeight - height - VIEWPORT_PADDING))}px`;
    const requestedLeft = anchor.kind === 'button' && anchor.align === 'right' ? rect.right - width : rect.left;
    host.style.left = `${Math.min(Math.max(requestedLeft, VIEWPORT_PADDING), Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING))}px`;
  } catch {
    closeCollectionReferencePicker();
  }
}

function ReferencePickerFrame({ editor, replaceRange, anchor, onClose, children }: {
  editor: Editor;
  replaceRange: CollectionReferenceInsertRange;
  anchor: CollectionReferencePickerAnchor;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !pickerHost?.contains(event.target)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    const reposition = () => updatePickerPosition(editor, replaceRange.from, anchor);
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    const observer = pickerHost && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(reposition)
      : null;
    if (observer && pickerHost) observer.observe(pickerHost);
    return () => {
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      observer?.disconnect();
    };
  }, [anchor, editor, onClose, replaceRange.from]);

  useLayoutEffect(() => {
    updatePickerPosition(editor, replaceRange.from, anchor);
  });

  return <>{children}</>;
}

export function openCollectionReferencePicker(
  editor: Editor,
  replaceRange: CollectionReferenceInsertRange,
  anchor: CollectionReferencePickerAnchor,
  kind: PickerKind,
  renderContent: PickerContent,
) {
  closeCollectionReferencePicker();
  const generation = pickerGeneration;
  pickerAnchorActions = anchor.kind === 'button'
    ? anchor.element.closest<HTMLElement>('.multidimensional-table__view-nav-actions')
    : null;
  pickerAnchorActions?.setAttribute('data-reference-picker-open', 'true');
  pickerHost = document.createElement('div');
  pickerHost.dataset.collectionReferencePicker = kind;
  pickerHost.style.position = 'fixed';
  pickerHost.style.zIndex = '2147483647';
  pickerHost.style.width = `${PICKER_WIDTH}px`;
  document.body.appendChild(pickerHost);
  pickerRoot = createRoot(pickerHost);
  const onClose = () => closeCollectionReferencePicker(generation);
  pickerRoot.render(
    <ReferencePickerFrame editor={editor} replaceRange={replaceRange} anchor={anchor} onClose={onClose}>
      {renderContent(generation, onClose)}
    </ReferencePickerFrame>,
  );
  requestAnimationFrame(() => updatePickerPosition(editor, replaceRange.from, anchor));
}

function shouldNavigateList(textarea: HTMLTextAreaElement, key: 'ArrowUp' | 'ArrowDown'): boolean {
  if (textarea.selectionStart !== textarea.selectionEnd) return false;
  const style = getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(style.lineHeight) || 20;
  const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
  const border = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
  const visualLines = Math.max(1, Math.round((textarea.clientHeight - verticalPadding - border) / lineHeight));
  if (visualLines === 1) return true;
  return key === 'ArrowDown'
    ? textarea.selectionEnd === textarea.value.length
    : textarea.selectionStart === 0;
}

export function useCollectionPickerListNavigation(itemCount: number, resetKey: string) {
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [keyboardNavigation, setKeyboardNavigation] = useState(false);

  useEffect(() => {
    setActiveIndex(-1);
    setKeyboardNavigation(false);
  }, [resetKey]);

  useEffect(() => {
    optionRefs.current = optionRefs.current.slice(0, itemCount);
    if (activeIndex >= itemCount) setActiveIndex(itemCount - 1);
  }, [activeIndex, itemCount]);

  const move = (index: number, byKeyboard: boolean) => {
    if (!itemCount) return;
    const next = (index + itemCount) % itemCount;
    setActiveIndex(next);
    setKeyboardNavigation(byKeyboard);
    if (byKeyboard) requestAnimationFrame(() => optionRefs.current[next]?.scrollIntoView({ block: 'nearest' }));
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || !shouldNavigateList(event.currentTarget, event.key)) return;
    if (!itemCount) return;
    event.preventDefault();
    move(event.key === 'ArrowDown' ? activeIndex + 1 : activeIndex < 0 ? itemCount - 1 : activeIndex - 1, true);
  };

  return {
    activeIndex,
    keyboardNavigation,
    optionRefs,
    onInputKeyDown,
    onOptionMouseMove: (index: number) => move(index, false),
    isSelected: (index: number) => index === activeIndex,
  };
}
