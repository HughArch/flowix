import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

type StableCaretScope = 'document' | 'composer';

function activeClassFor(scope: StableCaretScope): string {
  return scope === 'composer' ? 'has-composer-stable-caret' : 'has-document-stable-caret';
}

function elementAtPosition(view: EditorView, position: number): HTMLElement {
  const { node } = view.domAtPos(position, -1);
  if (node instanceof HTMLElement) return node;
  return node.parentElement ?? view.dom;
}

function caretHeightAt(view: EditorView, position: number): number {
  const element = elementAtPosition(view, position);
  const fontSize = Number.parseFloat(getComputedStyle(element).fontSize);
  const resolvedFontSize = Number.isFinite(fontSize) ? fontSize : 16;

  // Native carets expand to the line box in editable pre-wrap content. Keep
  // the visual caret tied to glyph size instead, independently of line-height.
  return Math.max(12, resolvedFontSize * 1.15);
}

function caretWidthAt(element: HTMLElement, scope: StableCaretScope = scopeAt(element)): number {
  const property = scope === 'composer' ? '--agent-composer-caret-width' : '--editor-caret-width';
  const width = Number.parseFloat(getComputedStyle(element).getPropertyValue(property));
  return Number.isFinite(width) && width > 0 ? width : 2;
}

function scopeAt(element: HTMLElement): StableCaretScope {
  return element.closest('.agent-composer__input-content') ? 'composer' : 'document';
}

interface CaretRect {
  left: number;
  top: number;
  bottom: number;
}

/** Resolve both sides from the logical selection and the visible chip, never
 * from the browser's caret inside a non-editable NodeView. The shared caret
 * is two pixels wide; its nearest edge stays one pixel away from the border. */
export function getInlineAtomBoundaryCaretRect(
  view: Pick<EditorView, 'state' | 'nodeDOM'>,
  position: number,
): CaretRect | null {
  const $pos = view.state.doc.resolve(position);
  const candidates = [
    { node: $pos.nodeBefore, pos: position - ($pos.nodeBefore?.nodeSize ?? 0), side: 'after' },
    { node: $pos.nodeAfter, pos: position, side: 'before' },
  ] as const;
  for (const { node, pos, side } of candidates) {
    if (!node?.isInline || !node.isAtom || node.isText) continue;
    const wrapper = view.nodeDOM(pos);
    if (!(wrapper instanceof HTMLElement)
      || wrapper.getAttribute('data-inline-atom-caret') !== 'single-line') continue;
    const card = wrapper.querySelector<HTMLElement>('[data-inline-atom-card]');
    if (!card) continue;
    const rect = card.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const scope = scopeAt(wrapper);
    const gapProperty = scope === 'composer' ? '--agent-composer-caret-gap' : '--inline-atom-caret-gap';
    const gapValue = Number.parseFloat(getComputedStyle(wrapper).getPropertyValue(gapProperty));
    const gap = Number.isFinite(gapValue) && gapValue >= 0 ? gapValue : 1;
    const width = caretWidthAt(wrapper, scope);
    const rtl = getComputedStyle(card).direction === 'rtl';
    const leftEdge = (side === 'before') !== rtl;
    const result = {
      left: leftEdge ? rect.left - width - gap : rect.right + gap,
      top: rect.top,
      bottom: rect.bottom,
    };
    if (isUsableCaretRect(result)) return result;
  }
  return null;
}

interface TerminalInlineAtomCaretResolution {
  found: boolean;
  rect: CaretRect | null;
}

function isUsableCaretRect(rect: CaretRect): boolean {
  return Number.isFinite(rect.left)
    && Number.isFinite(rect.top)
    && Number.isFinite(rect.bottom)
    && rect.bottom >= rect.top;
}

function terminalInlineCaretRect(card: HTMLElement): CaretRect | null {
  // A collapsed range at the end of the content represents the actual visual
  // caret position, including the final line of a wrapped inline element.
  // Unlike getBoundingClientRect(), it does not return the union of all line
  // fragments.
  try {
    const range = document.createRange();
    range.selectNodeContents(card);
    range.collapse(false);
    const rangeRect = range.getBoundingClientRect();
    if (
      rangeRect.width <= 1.5
      && rangeRect.height > 0
      && isUsableCaretRect({
        left: rangeRect.left,
        top: rangeRect.top,
        bottom: rangeRect.bottom,
      })
    ) {
      return {
        left: rangeRect.left,
        top: rangeRect.top,
        bottom: rangeRect.bottom,
      };
    }
  } catch {
    // Fall through to fragment geometry for older or partially implemented
    // browser Range implementations.
  }

  // Inline elements can produce one DOMRect per visual line.  Select the
  // lowest fragment, then the rightmost one for wrapped bidirectional text.
  const fragments = Array.from(card.getClientRects())
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .sort((a, b) => a.bottom - b.bottom || a.right - b.right);
  const lastFragment = fragments[fragments.length - 1];
  if (!lastFragment) return null;

  const direction = getComputedStyle(card).direction;
  const left = direction === 'rtl' ? lastFragment.left : lastFragment.right;
  const fragmentRect = { left, top: lastFragment.top, bottom: lastFragment.bottom };
  return isUsableCaretRect(fragmentRect) ? fragmentRect : null;
}

function findTerminalInlineAtomCaretAnchor(
  view: Pick<EditorView, 'dom'>,
  position: number,
): HTMLElement | null {
  const anchors = view.dom.querySelectorAll<HTMLElement>(
    '.terminal-inline-atom-caret-anchor',
  );
  return Array.from(anchors).find((anchor) => (
    anchor.closest('.ProseMirror') === view.dom
    &&
    anchor.getAttribute('data-terminal-inline-atom-caret-position') === String(position)
  )) ?? null;
}

function resolveTerminalInlineAtomCaret(
  view: Pick<EditorView, 'dom'>,
  position: number,
): TerminalInlineAtomCaretResolution {
  const anchor = findTerminalInlineAtomCaretAnchor(view, position);
  if (!anchor) return { found: false, rect: null };

  // The decoration is inserted immediately after the NodeView wrapper.
  // Prefer the visible card's terminal visual fragment. The card may wrap,
  // so its union bounding box is not a valid caret position.
  const atomWrapper = anchor.previousElementSibling as HTMLElement | null;
  const card = atomWrapper?.querySelector<HTMLElement>(
    '.note-reference__card, .editor-file-attachment__card',
  );
  if (card) {
    const cardRect = terminalInlineCaretRect(card);
    if (cardRect) return { found: true, rect: cardRect };
  }

  // If a custom atom has no known card class, its wrapper is still a useful
  // single-fragment fallback.
  const wrapperRect = atomWrapper?.getBoundingClientRect();
  if (wrapperRect && wrapperRect.width > 0 && wrapperRect.height > 0) {
    const fallbackRect = {
      left: wrapperRect.right,
      top: wrapperRect.top,
      bottom: wrapperRect.bottom,
    };
    if (isUsableCaretRect(fallbackRect)) return { found: true, rect: fallbackRect };
  }

  return { found: true, rect: null };
}

/**
 * Returns geometry for a selection immediately after a terminal inline atom.
 *
 * ProseMirror's logical position is still the source of truth for the
 * selection, but `coordsAtPos` can describe the line box belonging to the
 * trailing break instead of the atom boundary.  The decoration carries the
 * position back into the DOM, allowing us to use the visible card's box as a
 * stable cross-engine anchor.
 */
export function getTerminalInlineAtomCaretRect(
  view: Pick<EditorView, 'dom'>,
  position: number,
): CaretRect | null {
  return resolveTerminalInlineAtomCaret(view, position).rect;
}

class StableCaretView {
  private readonly caret = document.createElement('span');
  private frame: number | null = null;
  private lastGeometry: { left: number; top: number; height: number } | null = null;

  constructor(
    private readonly view: EditorView,
    private readonly scope: StableCaretScope,
  ) {
    this.caret.className = scope === 'composer'
      ? 'agent-composer__stable-caret'
      : 'stable-editor-caret--document';
    this.caret.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this.caret);

    view.dom.addEventListener('focus', this.schedule, true);
    view.dom.addEventListener('blur', this.schedule, true);
    view.dom.addEventListener('compositionstart', this.handleCompositionStart);
    view.dom.addEventListener('compositionend', this.schedule);
    document.addEventListener('selectionchange', this.schedule);
    window.addEventListener('resize', this.schedule);
    window.addEventListener('scroll', this.schedule, true);
    this.schedule();
  }

  update(): void {
    this.schedule();
  }

  destroy(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.view.dom.classList.remove(activeClassFor(this.scope));
    this.view.dom.removeEventListener('focus', this.schedule, true);
    this.view.dom.removeEventListener('blur', this.schedule, true);
    this.view.dom.removeEventListener('compositionstart', this.handleCompositionStart);
    this.view.dom.removeEventListener('compositionend', this.schedule);
    document.removeEventListener('selectionchange', this.schedule);
    window.removeEventListener('resize', this.schedule);
    window.removeEventListener('scroll', this.schedule, true);
    this.caret.remove();
  }

  private readonly handleCompositionStart = (): void => {
    this.hide();
  };

  private readonly schedule = (): void => {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.render();
    });
  };

  private render(): void {
    const { selection } = this.view.state;
    // A thread-card composer is a nested contenteditable inside the document
    // editor. EditorView.hasFocus() treats focus in that subtree as focus in
    // the parent view, but the parent stable caret must not hide or compete
    // with the composer's own caret renderer.
    const activeElement = document.activeElement;
    const nestedEditableHasFocus = activeElement instanceof HTMLElement
      && activeElement !== this.view.dom
      && this.view.dom.contains(activeElement)
      && activeElement.closest('[contenteditable="true"]') !== this.view.dom;
    if (
      !this.view.editable
      || !this.view.hasFocus()
      || nestedEditableHasFocus
      || this.view.composing
      || !(selection instanceof TextSelection)
      || !selection.empty
    ) {
      this.hide();
      return;
    }

    try {
      const boundaryRect = getInlineAtomBoundaryCaretRect(this.view, selection.head);
      const terminalAtom = boundaryRect
        ? { found: false, rect: null }
        : resolveTerminalInlineAtomCaret(this.view, selection.head);
      // Never fall back to coordsAtPos for a known terminal atom.  If the
      // NodeView is between mount and layout, showing the native caret is safer
      // than drawing a caret from the trailing-break line box.
      if (terminalAtom.found && !terminalAtom.rect) {
        this.hide();
        return;
      }
      const rect = boundaryRect ?? terminalAtom.rect ?? this.view.coordsAtPos(selection.head);
      const clipsOwnContent = /^(auto|scroll|hidden|clip)$/.test(getComputedStyle(this.view.dom).overflowY);
      const scrollViewport = clipsOwnContent
        ? this.view.dom
        : this.view.dom.closest('.editor-content');
      const viewportRect = scrollViewport instanceof HTMLElement
        ? scrollViewport.getBoundingClientRect()
        : this.view.dom.getBoundingClientRect();
      const isVisible = (
        rect.bottom >= viewportRect.top
        && rect.top <= viewportRect.bottom
        && rect.left >= viewportRect.left - 1
        && rect.left <= viewportRect.right + 1
      );
      if (!isVisible) {
        this.hide();
        return;
      }

      const height = caretHeightAt(this.view, selection.head);
      const lineHeight = Math.max(0, rect.bottom - rect.top);
      const top = rect.top + Math.max(0, (lineHeight - height) / 2);
      const geometry = { left: rect.left, top, height };
      const geometryChanged = (
        this.lastGeometry === null
        || Math.abs(this.lastGeometry.left - geometry.left) > 0.1
        || Math.abs(this.lastGeometry.top - geometry.top) > 0.1
        || Math.abs(this.lastGeometry.height - geometry.height) > 0.1
      );

      this.caret.style.left = `${rect.left}px`;
      this.caret.style.width = `${caretWidthAt(this.view.dom, this.scope)}px`;
      this.caret.style.top = `${top}px`;
      this.caret.style.height = `${height}px`;
      this.caret.hidden = false;
      this.view.dom.classList.add(activeClassFor(this.scope));
      this.lastGeometry = geometry;

      if (geometryChanged) {
        this.caret.style.animation = 'none';
        void this.caret.offsetWidth;
        this.caret.style.animation = '';
      }
    } catch {
      this.hide();
    }
  }

  private hide(): void {
    this.caret.hidden = true;
    this.lastGeometry = null;
    this.view.dom.classList.remove(activeClassFor(this.scope));
  }
}

function createStableCaretExtension(scope: 'document' | 'composer') {
  const key = new PluginKey(`stableCaret:${scope}`);
  return Extension.create({
    name: 'stableCaret',

    addProseMirrorPlugins() {
      return [
        new Plugin({
          key,
          view: (view) => new StableCaretView(view, scope),
        }),
      ];
    },
  });
}

export const StableCaret = createStableCaretExtension('document');
export const ComposerStableCaret = createStableCaretExtension('composer');
