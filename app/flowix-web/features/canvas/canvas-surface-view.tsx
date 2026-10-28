'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types';
import { files } from '@platform/tauri/client';
import type { SurfaceLifecycle, SurfacePresentationUpdate } from '@features/workspace/public/surface-api';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import {
  CanvasParseError,
  parseCanvasDocument,
  readPersistedAppState,
  serializeCanvasDocument,
  type FlowixCanvasDocument,
  type PersistedCanvasAppState,
} from './model';
import { LazyExcalidraw } from './excalidraw-lazy';

const SAVE_DEBOUNCE_MS = 800;

export interface CanvasSurfaceViewProps {
  filePath: string;
  notebookPath: string | null;
  readOnly?: boolean;
  onSurfaceLifecycleReady?: (lifecycle: SurfaceLifecycle | null) => void;
  reportPresentation?: (update: SurfacePresentationUpdate) => void;
}

type CanvasLoadState =
  | { status: 'loading' }
  | { status: 'ready'; document: FlowixCanvasDocument }
  | { status: 'error'; message: string };

interface PersistedScene {
  elements: readonly ExcalidrawElement[];
  appState: PersistedCanvasAppState;
  files: BinaryFiles;
}

export function CanvasSurfaceView({ filePath, notebookPath, readOnly = false, onSurfaceLifecycleReady, reportPresentation }: CanvasSurfaceViewProps) {
  const { t } = useI18n();
  const [state, setState] = useState<CanvasLoadState>({ status: 'loading' });
  const [retryToken, setRetryToken] = useState(0);
  const documentRef = useRef<FlowixCanvasDocument | null>(null);
  const sceneRef = useRef<PersistedScene | null>(null);
  const dirtyRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const lastSavedTextRef = useRef<string | null>(null);

  const retryLoad = useCallback(() => setRetryToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    documentRef.current = null;
    sceneRef.current = null;
    void files.read(filePath, notebookPath ?? undefined).then((text) => {
      if (cancelled) return;
      if (text == null) {
        setState({ status: 'error', message: t('canvas.load.missing') });
        return;
      }
      try {
        const document = parseCanvasDocument(text);
        documentRef.current = document;
        sceneRef.current = {
          elements: document.elements as ExcalidrawElement[],
          appState: readPersistedAppState(document),
          files: document.files as BinaryFiles,
        };
        lastSavedTextRef.current = text;
        setState({ status: 'ready', document });
      } catch (error) {
        setState({ status: 'error', message: error instanceof CanvasParseError ? error.message : String(error) });
      }
    }).catch((error) => {
      if (!cancelled) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [filePath, notebookPath, retryToken, t]);

  const flush = useCallback(async (): Promise<boolean> => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const document = documentRef.current;
    const scene = sceneRef.current;
    if (!document || !scene || !dirtyRef.current) return true;
    const { text, droppedFileCount } = serializeCanvasDocument(document, scene.elements, scene.appState, scene.files);
    // Excalidraw fires onChange on mount and for selection-only tweaks; skip
    // the write when the serialized bytes match what is already on disk so an
    // opened-but-unedited canvas never touches the sync channel.
    if (text === lastSavedTextRef.current) {
      dirtyRef.current = false;
      return true;
    }
    try {
      const saved = await files.write(filePath, text, undefined, notebookPath ?? undefined);
      if (!saved) throw new Error('write_file returned false');
      dirtyRef.current = false;
      lastSavedTextRef.current = text;
      if (droppedFileCount > 0) toast.warning(t('canvas.save.filesDropped', { count: droppedFileCount }));
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('canvas.save.failed'));
      return false;
    }
  }, [filePath, notebookPath, t]);

  const scheduleFlush = useCallback(() => {
    dirtyRef.current = true;
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void flush();
    }, SAVE_DEBOUNCE_MS);
  }, [flush]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const handleSceneChange = useCallback((elements: readonly ExcalidrawElement[], appState: AppState, sceneFiles: BinaryFiles) => {
    sceneRef.current = {
      elements,
      appState: {
        viewBackgroundColor: appState.viewBackgroundColor,
        gridSize: appState.gridSize ?? null,
        gridModeEnabled: appState.gridModeEnabled,
      },
      files: sceneFiles,
    };
    scheduleFlush();
  }, [scheduleFlush]);

  const initialData = useMemo(() => {
    if (state.status !== 'ready') return null;
    const persisted = readPersistedAppState(state.document);
    return {
      elements: state.document.elements as ExcalidrawElement[],
      // Excalidraw's own AppState treats gridSize as `number | undefined`;
      // drop the persisted null so the partial is accepted verbatim.
      appState: {
        viewBackgroundColor: persisted.viewBackgroundColor,
        ...(persisted.gridSize != null ? { gridSize: persisted.gridSize } : {}),
        gridModeEnabled: persisted.gridModeEnabled,
      },
      files: state.document.files as BinaryFiles,
    };
  }, [state]);

  useEffect(() => {
    const title = filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
    const surfaceState = state.status === 'loading'
      ? { status: 'loading' as const, loadingMode: 'blocking' as const, retainContent: true }
      : state.status === 'error'
        ? {
            status: 'error' as const,
            message: { key: 'document.file.unavailable', fallbackText: state.message },
            actions: [{ id: 'retry', label: { key: 'error.retry' }, enabled: true, run: retryLoad }],
          }
        : ({ status: 'ready' as const });
    reportPresentation?.({ title, state: surfaceState });
  }, [filePath, reportPresentation, retryLoad, state]);

  useEffect(() => {
    if (state.status !== 'ready') return;
    onSurfaceLifecycleReady?.({
      status: 'ready',
      flush: async () => {
        // A scheduled debounce counts as pending work even before it fires.
        if (timerRef.current !== null) return await flush();
        return dirtyRef.current ? await flush() : true;
      },
    });
    return () => onSurfaceLifecycleReady?.(null);
  }, [flush, onSurfaceLifecycleReady, state.status]);

  if (state.status !== 'ready' || !initialData) {
    return reportPresentation
      ? null
      : <div className="flex h-full w-full items-center justify-center text-sm text-[var(--muted-foreground)]">
          {state.status === 'error' ? state.message : t('canvas.loading')}
        </div>;
  }

  return (
    <div className="h-full min-h-0 w-full" data-canvas-surface={filePath}>
      <LazyExcalidraw
        initialData={initialData}
        onChange={handleSceneChange}
        viewModeEnabled={readOnly}
        UIOptions={{ canvasActions: { export: false, loadScene: false } }}
      />
    </div>
  );
}
