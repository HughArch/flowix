import { Extension } from '@tiptap/core';
import type { Node as PMNode } from 'prosemirror-model';
import { NodeSelection, Plugin, PluginKey, Selection } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import {
  isJsonFoldableLanguage,
  scanJsonFoldRanges,
  type JsonFoldScan,
} from './json-fold-scan';

export const JSON_FOLD_HIDDEN_CLASS = 'json-fold-hidden';

export interface JsonFoldLabels {
  fold: string;
  unfold: string;
}

export interface JsonFoldOptions {
  getLabels: () => JsonFoldLabels;
}

interface FoldedEntry {
  char: '{' | '[';
}

interface HiddenRange {
  open: number;
  from: number;
  to: number;
}

interface JsonFoldState {
  folded: Map<number, FoldedEntry>;
  hidden: HiddenRange[];
  decorations: DecorationSet;
}

interface AbsoluteRange {
  openPos: number;
  openChar: '{' | '[';
  linePos: number;
  hiddenFrom: number;
  hiddenTo: number;
}

type JsonFoldMeta =
  | { type: 'toggle'; pos: number }
  | { type: 'unfold'; positions: number[] }
  | { type: 'refresh' };

export const jsonFoldPluginKey = new PluginKey<JsonFoldState>('jsonFold');

const scanCache = new WeakMap<PMNode, JsonFoldScan>();

function scanCodeBlock(node: PMNode): JsonFoldScan | null {
  if (node.type.name !== 'codeBlock') return null;
  if (node.attrs.collapsed === true) return null;
  if (!isJsonFoldableLanguage(node.attrs.language)) return null;

  let scan = scanCache.get(node);
  if (!scan) {
    scan = scanJsonFoldRanges(node.textContent, String(node.attrs.language));
    scanCache.set(node, scan);
  }
  return scan.valid && scan.ranges.length > 0 ? scan : null;
}

function collectRanges(doc: PMNode): AbsoluteRange[] {
  const ranges: AbsoluteRange[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock') return true;
    const scan = scanCodeBlock(node);
    if (!scan) return false;
    for (const range of scan.ranges) {
      ranges.push({
        openPos: pos + 1 + range.openOffset,
        openChar: range.openChar,
        linePos: pos + 1 + range.lineStart,
        hiddenFrom: pos + 1 + range.hiddenStart,
        hiddenTo: pos + 1 + range.hiddenEnd,
      });
    }
    return false;
  });
  return ranges;
}

function createFoldButton(
  openPos: number,
  folded: boolean,
  labels: JsonFoldLabels,
  view: EditorView,
): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'json-fold-toggle';
  button.contentEditable = 'false';
  button.tabIndex = -1;
  button.dataset.folded = folded ? 'true' : 'false';

  const label = folded ? labels.unfold : labels.fold;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-expanded', String(!folded));

  button.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleJsonFold(view, openPos);
  });
  return button;
}

function buildState(
  doc: PMNode,
  folded: Map<number, FoldedEntry>,
  labels: JsonFoldLabels,
): JsonFoldState {
  const ranges = collectRanges(doc);
  const byOpen = new Map(ranges.map(range => [range.openPos, range]));

  // Drop folds whose opener no longer exists or changed bracket type.
  const nextFolded = new Map<number, FoldedEntry>();
  for (const [pos, entry] of folded) {
    const range = byOpen.get(pos);
    if (range && range.openChar === entry.char) nextFolded.set(pos, entry);
  }

  const hidden = ranges
    .filter(range => nextFolded.has(range.openPos) && range.hiddenTo > range.hiddenFrom)
    .map(range => ({ open: range.openPos, from: range.hiddenFrom, to: range.hiddenTo }))
    .sort((a, b) => a.from - b.from);

  const isHidden = (pos: number) => hidden.some(range => pos >= range.from && pos < range.to);

  const decorations: Decoration[] = [];
  for (const range of ranges) {
    // Nested toggles inside a folded container are hidden with it.
    if (isHidden(range.openPos)) continue;

    const foldedHere = nextFolded.has(range.openPos);
    decorations.push(Decoration.widget(
      range.linePos,
      view => createFoldButton(range.openPos, foldedHere, labels, view),
      {
        side: -1,
        // Force a fresh button when the fold state changes; ProseMirror
        // otherwise reuses the widget DOM at the same position.
        key: `json-fold:${range.openPos}:${foldedHere ? 'folded' : 'open'}`,
        stopEvent: event => event.type === 'mousedown' || event.type === 'click',
      },
    ));
    if (foldedHere) {
      decorations.push(Decoration.inline(range.hiddenFrom, range.hiddenTo, {
        class: JSON_FOLD_HIDDEN_CLASS,
      }));
    }
  }

  return { folded: nextFolded, hidden, decorations: DecorationSet.create(doc, decorations) };
}

export function toggleJsonFold(view: EditorView, openPos: number): boolean {
  if (view.isDestroyed) return false;

  const pluginState = jsonFoldPluginKey.getState(view.state);
  if (!pluginState) return false;

  const tr = view.state.tr;

  if (!pluginState.folded.has(openPos)) {
    // About to hide content: move a caret that sits inside it to the opener line.
    const range = collectRanges(view.state.doc).find(item => item.openPos === openPos);
    if (range) {
      const { from, to } = view.state.selection;
      if (from < range.hiddenTo && to > range.hiddenFrom) {
        tr.setSelection(Selection.near(tr.doc.resolve(range.hiddenFrom), -1));
      }
    }
  }

  tr.setMeta('addToHistory', false);
  tr.setMeta(jsonFoldPluginKey, { type: 'toggle', pos: openPos });
  view.dispatch(tr);
  return true;
}

export function createJsonFoldPlugin(options: JsonFoldOptions): Plugin<JsonFoldState> {
  return new Plugin<JsonFoldState>({
    key: jsonFoldPluginKey,

    state: {
      init: (_config, state) => buildState(state.doc, new Map(), options.getLabels()),

      apply(transaction, previous, _oldState, newState) {
        const meta = transaction.getMeta(jsonFoldPluginKey) as JsonFoldMeta | undefined;
        const labels = options.getLabels();

        if (meta?.type === 'toggle') {
          const folded = new Map(previous.folded);
          if (folded.has(meta.pos)) {
            folded.delete(meta.pos);
          } else {
            const range = collectRanges(newState.doc).find(item => item.openPos === meta.pos);
            if (range) folded.set(meta.pos, { char: range.openChar });
          }
          return buildState(newState.doc, folded, labels);
        }

        if (meta?.type === 'unfold') {
          const folded = new Map(previous.folded);
          for (const pos of meta.positions) folded.delete(pos);
          return buildState(newState.doc, folded, labels);
        }

        if (meta?.type === 'refresh') {
          return buildState(newState.doc, previous.folded, labels);
        }

        if (transaction.docChanged) {
          const folded = new Map<number, FoldedEntry>();
          for (const [pos, entry] of previous.folded) {
            const result = transaction.mapping.mapResult(pos, 1);
            if (!result.deleted) folded.set(result.pos, entry);
          }
          return buildState(newState.doc, folded, labels);
        }

        return {
          ...previous,
          decorations: previous.decorations.map(transaction.mapping, transaction.doc),
        };
      },
    },

    props: {
      decorations(state) {
        return jsonFoldPluginKey.getState(state)?.decorations;
      },
    },

    appendTransaction(transactions, _oldState, newState) {
      if (transactions.some(transaction => transaction.getMeta(jsonFoldPluginKey))) return null;
      if (!transactions.some(transaction => transaction.selectionSet || transaction.docChanged)) return null;

      const state = jsonFoldPluginKey.getState(newState);
      if (!state || state.hidden.length === 0) return null;
      // Selecting the whole block (drag handle) must not unfold it.
      if (newState.selection instanceof NodeSelection) return null;

      const { from, to } = newState.selection;
      const positions = state.hidden
        .filter(range => from < range.to && to > range.from)
        .map(range => range.open);
      if (positions.length === 0) return null;

      const tr = newState.tr;
      tr.setMeta('addToHistory', false);
      tr.setMeta(jsonFoldPluginKey, { type: 'unfold', positions });
      return tr;
    },
  });
}

export const JsonFoldExtension = Extension.create<JsonFoldOptions>({
  name: 'jsonFold',

  addOptions() {
    return {
      getLabels: () => ({ fold: 'Collapse', unfold: 'Expand' }),
    };
  },

  addProseMirrorPlugins() {
    return [createJsonFoldPlugin({ getLabels: this.options.getLabels })];
  },
});
