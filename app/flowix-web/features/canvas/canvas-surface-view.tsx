'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFileData, BinaryFiles } from '@excalidraw/excalidraw/types';
import { resolveAttachmentStorageKey } from '@features/editor/extensions/attachment-link/utils';
import { files, notebookAssets } from '@platform/tauri/client';
import type { SurfaceLifecycle, SurfacePresentationUpdate } from '@features/workspace/public/surface-api';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { useAppLanguage } from '@features/preferences/public/runtime-api';
import {
  CanvasParseError,
  canvasFileNameFor,
  dataUrlPayload,
  parseCanvasDocument,
  readCanvasFileEntries,
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
  | { status: 'ready'; document: FlowixCanvasDocument; files: BinaryFiles }
  | { status: 'error'; message: string };

interface PersistedScene {
  elements: readonly ExcalidrawElement[];
  appState: PersistedCanvasAppState;
  files: BinaryFiles;
}

export function CanvasSurfaceView({ filePath, notebookPath, readOnly = false, onSurfaceLifecycleReady, reportPresentation }: CanvasSurfaceViewProps) {
  const { t } = useI18n();
  const appLanguage = useAppLanguage();
  // Excalidraw ships its own locale bundles; follow the app language so the
  // canvas chrome matches the note UI (zh-CN / en).
  const excalidrawLangCode = appLanguage === 'zh-CN' ? 'zh-CN' : 'en';
  const [state, setState] = useState<CanvasLoadState>({ status: 'loading' });
  const [retryToken, setRetryToken] = useState(0);
  const documentRef = useRef<FlowixCanvasDocument | null>(null);
  const sceneRef = useRef<PersistedScene | null>(null);
  const dirtyRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const lastSavedTextRef = useRef<string | null>(null);
  /** Excalidraw file id -> notebook-relative attachment key. */
  const fileKeysRef = useRef<Map<string, string>>(new Map());
  const pendingUploadsRef = useRef<Set<string>>(new Set());
  const uploadChainRef = useRef<Promise<void>>(Promise.resolve());

  const retryLoad = useCallback(() => setRetryToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    documentRef.current = null;
    sceneRef.current = null;
    fileKeysRef.current = new Map();
    pendingUploadsRef.current = new Set();
    void (async () => {
      const text = await files.read(filePath, notebookPath ?? undefined);
      if (cancelled) return;
      if (text == null) {
        setState({ status: 'error', message: t('canvas.load.missing') });
        return;
      }
      const document = parseCanvasDocument(text);
      // Bitmaps live in attachments/; hydrate Excalidraw with data URLs from
      // this device so the scene renders before the first interaction.
      const sceneFiles: BinaryFiles = {};
      for (const entry of readCanvasFileEntries(document.files)) {
        if (entry.storageKey) {
          fileKeysRef.current.set(entry.id, entry.storageKey);
          const absolute = resolveAttachmentStorageKey(entry.storageKey, notebookPath);
          const dataURL = await files.readImage(absolute, notebookPath ?? undefined).catch(() => null);
          if (cancelled) return;
          if (!dataURL) continue;
          sceneFiles[entry.id] = {
            id: entry.id as BinaryFileData['id'], dataURL: dataURL as BinaryFileData['dataURL'],
            mimeType: entry.mimeType as BinaryFileData['mimeType'], created: Date.now(),
          };
        } else if (entry.dataURL) {
          sceneFiles[entry.id] = {
            id: entry.id as BinaryFileData['id'], dataURL: entry.dataURL as BinaryFileData['dataURL'],
            mimeType: entry.mimeType as BinaryFileData['mimeType'], created: Date.now(),
          };
        }
      }
      documentRef.current = document;
      sceneRef.current = {
        elements: document.elements as ExcalidrawElement[],
        appState: readPersistedAppState(document),
        files: sceneFiles,
      };
      lastSavedTextRef.current = text;
      setState({ status: 'ready', document, files: sceneFiles });
    })().catch((error) => {
      if (!cancelled) setState({ status: 'error', message: error instanceof CanvasParseError ? error.message : error instanceof Error ? error.message : String(error) });
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
    const { text, droppedFileCount } = serializeCanvasDocument(
      document, scene.elements, scene.appState, scene.files, fileKeysRef.current,
    );
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

  // New bitmaps are persisted into attachments/ and only their key is written
  // to the canvas JSON; uploads run sequentially so a burst of pastes does not
  // exhaust the attachment quota.
  const queueFileUploads = useCallback((sceneFiles: BinaryFiles) => {
    if (readOnly) return;
    for (const [id, file] of Object.entries(sceneFiles)) {
      if (fileKeysRef.current.has(id) || pendingUploadsRef.current.has(id)) continue;
      const payload = dataUrlPayload(file.dataURL ?? '');
      if (!payload) continue;
      pendingUploadsRef.current.add(id);
      const mimeType = file.mimeType ?? 'image/png';
      uploadChainRef.current = uploadChainRef.current.then(async () => {
        try {
          const saved = await notebookAssets.saveContent({
            content: payload,
            fileName: canvasFileNameFor(id, mimeType),
            notePath: filePath,
          });
          if (saved?.key) {
            fileKeysRef.current.set(id, saved.key);
            scheduleFlush();
          }
        } catch (error) {
          console.error('[Canvas] Failed to persist image bitmap:', error);
          toast.error(error instanceof Error ? error.message : t('canvas.save.failed'));
        } finally {
          pendingUploadsRef.current.delete(id);
        }
      });
    }
  }, [filePath, readOnly, scheduleFlush, t]);

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
    queueFileUploads(sceneFiles);
    scheduleFlush();
  }, [queueFileUploads, scheduleFlush]);

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
      files: state.files,
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
    <div
      className="h-full min-h-0 w-full"
      data-canvas-surface={filePath}
      // Excalidraw owns pan/zoom; the shell's swipe-down must not steal drags.
      data-mobile-swipe-ignore="true"
    >
      <LazyExcalidraw
        initialData={initialData}
        onChange={handleSceneChange}
        langCode={excalidrawLangCode}
        viewModeEnabled={readOnly}
        UIOptions={{ canvasActions: { export: false, loadScene: false } }}
      />
    </div>
  );
}
