import { forwardRef, lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';
import type { MarkdownEditorHandle } from '@features/editor/markdown-editor';
import { recordOpenPerfNote } from '@/lib/document-open-perf';

type DocumentEditorProps = ComponentProps<
  typeof import('@features/editor/markdown-editor').MarkdownEditor
>;

type MarkdownEditorModule = typeof import('@features/editor/markdown-editor');

let markdownEditorModulePromise: Promise<MarkdownEditorModule> | null = null;

function loadMarkdownEditor(): Promise<MarkdownEditorModule> {
  if (!markdownEditorModulePromise) {
    recordOpenPerfNote('lazy-editor:import-start');
    markdownEditorModulePromise = import('@features/editor/markdown-editor').then((module) => {
      recordOpenPerfNote('lazy-editor:import-end');
      return module;
    }).catch((error) => {
      markdownEditorModulePromise = null;
      throw error;
    });
  }
  return markdownEditorModulePromise;
}

export function preloadDocumentEditor(): void {
  void loadMarkdownEditor().catch(() => {
    // The lazy boundary will retry the import when the editor is rendered.
  });
}

const LazyMarkdownEditor = lazy(() =>
  loadMarkdownEditor().then((module) => ({
    default: module.MarkdownEditor,
  }))
);

export const LazyDocumentEditor = forwardRef<MarkdownEditorHandle, DocumentEditorProps>(function LazyDocumentEditor(props, ref) {
  return (
    <Suspense fallback={null}>
      <LazyMarkdownEditor {...props} ref={ref} />
    </Suspense>
  );
});
