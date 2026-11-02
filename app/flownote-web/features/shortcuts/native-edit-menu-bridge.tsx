'use client';

import { useEffect } from 'react';
import { getAction } from '@/lib/shortcuts/registry';
import { getPlatform } from '@/lib/shortcuts/platform';
import { subscribe } from '@platform/tauri/event-bus';

const SELECT_ALL_EVENT = 'flownote://editor-select-all';
const UNDO_EVENT = 'flownote://editor-undo';
const REDO_EVENT = 'flownote://editor-redo';

function selectFocusedNativeField(): boolean {
  const focused = document.activeElement;
  if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) {
    focused.select();
    return true;
  }
  return false;
}

function runNativeEditCommand(command: 'undo' | 'redo'): boolean {
  const focused = document.activeElement;
  const isNativeTextField = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement;
  const isContentEditableTitle = focused instanceof HTMLElement
    && focused.isContentEditable
    && focused.closest('.memo-title-editor--document-selection') !== null;
  if (!isNativeTextField && !isContentEditableTitle) {
    return false;
  }
  if (typeof document.execCommand !== 'function') return false;
  return document.execCommand(command);
}

function runEditorAction(actionId: 'editor.undo' | 'editor.redo'): void {
  const action = getAction(actionId);
  if (!action) return;
  void action.run({ scope: 'editor', source: 'menu', platform: getPlatform() });
}

/** Routes native edit-menu accelerators that macOS consumes before the DOM. */
export function NativeEditMenuBridge() {
  useEffect(() => {
    const unsubscribes = [
      subscribe(SELECT_ALL_EVENT, () => {
        if (selectFocusedNativeField()) return;
        const action = getAction('editor.selectAll');
        if (!action) return;
        void action.run({ scope: 'editor', source: 'menu', platform: getPlatform() });
      }),
      subscribe(UNDO_EVENT, () => {
        if (!runNativeEditCommand('undo')) runEditorAction('editor.undo');
      }),
      subscribe(REDO_EVENT, () => {
        if (!runNativeEditCommand('redo')) runEditorAction('editor.redo');
      }),
    ];
    return () => unsubscribes.forEach(unsubscribe => unsubscribe());
  }, []);

  return null;
}
