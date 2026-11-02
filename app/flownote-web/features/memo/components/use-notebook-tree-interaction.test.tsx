import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureFileDisplayIdentity, rebaseFileDisplayPath } from '@/lib/file-display-registry';
import { useNotebookTreeInteraction } from './use-notebook-tree-interaction';
import { TREE_ROW_HEIGHT, TREE_ROW_SIZE } from './notebook-tree-layout';

describe('file tree selection through a rename', () => {
  let root: Root;
  let interaction: ReturnType<typeof useNotebookTreeInteraction>;
  let sequence = 0;
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const tree = { expanded: new Set<string>(), toggle: vi.fn() };
  const onNoteSelect = vi.fn();

  function Harness({ path, paths }: { path: string; paths: Set<string> }) {
    interaction = useNotebookTreeInteraction({
      activeFilePath: path, treeItemPaths: paths, visibleTreeItems: [], tree,
      treeRootRef: { current: null }, treeScrollerRef: { current: null },
      renderRowIndexByPath: new Map(), treeContentOffset: 0, onNoteSelect,
    });
    return null;
  }
  beforeEach(() => {
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(document.createElement('div'));
    onNoteSelect.mockClear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('starts one smooth scroll to 40% without an intermediate nearest-row scroll', async () => {
    const oldPath = '/creation-reveal/old.md';
    const newPath = '/creation-reveal/new.md';
    const scroller = document.createElement('div');
    const writes: number[] = [];
    let scrollTop = 0;
    Object.defineProperties(scroller, {
      clientHeight: { value: 500 },
      scrollHeight: { value: 2000 },
      scrollTop: {
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; writes.push(value); },
      },
    });
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      scroller.scrollTop = options.top ?? 0;
    });
    Object.defineProperty(scroller, 'scrollTo', { value: scrollTo });
    let positionAtLayout = 0;
    function CreationHarness({ path, ratio, loaded }: {
      path: string; ratio?: number; loaded: boolean;
    }) {
      useNotebookTreeInteraction({
        activeFilePath: path, activeFileRevealRatio: ratio,
        treeItemPaths: new Set([oldPath, newPath]), visibleTreeItems: [], tree,
        treeRootRef: { current: null }, treeScrollerRef: { current: scroller },
        renderRowIndexByPath: new Map(loaded ? [[path, 30]] : []),
        treeContentOffset: 0, onNoteSelect,
      });
      useLayoutEffect(() => { positionAtLayout = scrollTop; });
      return null;
    }
    await act(async () => root.render(createElement(CreationHarness, {
      path: oldPath, loaded: false,
    })));
    expect(writes).toEqual([]);
    await act(async () => root.render(createElement(CreationHarness, {
      path: newPath, ratio: 0.4, loaded: false,
    })));
    expect(writes).toEqual([]);
    await act(async () => root.render(createElement(CreationHarness, {
      path: newPath, ratio: 0.4, loaded: true,
    })));
    const target = 30 * TREE_ROW_SIZE + TREE_ROW_HEIGHT / 2 - 500 * 0.4;
    expect(writes).toEqual([target]);
    expect(positionAtLayout).toBe(target);
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: target, behavior: 'smooth' });
    await act(async () => root.render(createElement(CreationHarness, {
      path: newPath, ratio: 0.4, loaded: true,
    })));
    expect(writes).toEqual([target]);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    // A subsequent ordinary navigation carries no creation policy.
    await act(async () => root.render(createElement(CreationHarness, {
      path: oldPath, loaded: true,
    })));
    expect(writes).toEqual([target]);
  });

  it('retains selection, anchor and focus while the directory read still contains the old filename', async () => {
    const identity = ensureFileDisplayIdentity(`/tree-rename-${++sequence}/old.md`);
    const next = identity.path.replace('old.md', 'new.md');
    const stalePaths = new Set([identity.path]);
    await act(async () => root.render(createElement(Harness, { path: identity.path, paths: stalePaths })));
    await act(async () => {
      interaction.updateSelection([identity.path], identity.path);
      interaction.setFocusedTreePath(identity.path);
      interaction.setNavigationPolicy(identity.path, 'preserve');
    });
    rebaseFileDisplayPath(identity.path, next, identity.displayId);
    // The registry notification can precede the active-path store update.
    await act(async () => root.render(createElement(Harness, { path: identity.path, paths: stalePaths })));
    expect(interaction.selectedFilePaths).toEqual([identity.path]);
    await act(async () => root.render(createElement(Harness, { path: next, paths: stalePaths })));
    expect(interaction.selectedFilePaths).toEqual([next]);
    expect(interaction.getSelectionAnchorPath()).toBe(next);
    expect(interaction.focusedTreePath).toBe(next);
    expect(interaction.activeFileShouldReveal).toBe(false);

    await act(async () => root.render(createElement(Harness, { path: next, paths: new Set([next]) })));
    expect(interaction.selectedFilePaths).toEqual([next]);
    expect(onNoteSelect).not.toHaveBeenCalled();

    const other = ensureFileDisplayIdentity(`/tree-rename-${sequence}/other.md`);
    await act(async () => root.render(createElement(Harness, { path: other.path, paths: new Set([next, other.path]) })));
    expect(interaction.selectedFilePaths).toEqual([]);
    expect(interaction.getSelectionAnchorPath()).toBeNull();
  });
});
