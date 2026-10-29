'use client';

/**
 * Canvas surface entry: routes a `.flowix-canvas` file by content.
 * Documents with board cards open in the react-flow board renderer; drawing
 * documents keep the Phase 1 Excalidraw surface unchanged. The sniffing read
 * is handed over to the chosen renderer so the file is read from disk once.
 */

import { useCallback, useEffect, useState } from 'react';
import { files } from '@platform/tauri/client';
import { useI18n } from '@/lib/i18n';
import { parseCanvasDocument, readBoardCards } from './model';
import { CanvasBoardView } from './canvas-board-view';
import { CanvasDrawSurface } from './canvas-draw-surface';
import { type CanvasSurfaceViewProps } from './surface-props';

export type { CanvasSurfaceViewProps } from './surface-props';

type CanvasRoute =
  | { status: 'loading' }
  | { status: 'draw'; text: string }
  | { status: 'board'; text: string }
  | { status: 'error'; message: string };

export function CanvasSurfaceView({ filePath, notebookPath, readOnly = false, onSurfaceLifecycleReady, reportPresentation }: CanvasSurfaceViewProps) {
  const { t } = useI18n();
  const [route, setRoute] = useState<CanvasRoute>({ status: 'loading' });
  const [retryToken, setRetryToken] = useState(0);

  const retryLoad = useCallback(() => setRetryToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    setRoute({ status: 'loading' });
    void (async () => {
      const text = await files.read(filePath, notebookPath ?? undefined);
      if (cancelled) return;
      if (text == null) {
        setRoute({ status: 'error', message: t('canvas.load.missing') });
        return;
      }
      const document = parseCanvasDocument(text);
      if (cancelled) return;
      setRoute(readBoardCards(document).length > 0
        ? { status: 'board', text }
        : { status: 'draw', text });
    })().catch((error) => {
      if (!cancelled) setRoute({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [filePath, notebookPath, retryToken, t]);

  useEffect(() => {
    if (route.status !== 'loading' && route.status !== 'error') return;
    const title = filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
    const surfaceState = route.status === 'loading'
      ? { status: 'loading' as const, loadingMode: 'blocking' as const, retainContent: true }
      : {
          status: 'error' as const,
          message: { key: 'document.file.unavailable', fallbackText: route.message },
          actions: [{ id: 'retry', label: { key: 'error.retry' }, enabled: true, run: retryLoad }],
        };
    reportPresentation?.({ title, state: surfaceState });
    return () => onSurfaceLifecycleReady?.(null);
  }, [filePath, onSurfaceLifecycleReady, reportPresentation, retryLoad, route]);

  if (route.status === 'loading' || route.status === 'error') return null;
  if (route.status === 'board') {
    return (
      <CanvasBoardView
        filePath={filePath}
        notebookPath={notebookPath}
        readOnly={readOnly}
        initialText={route.text}
        onSurfaceLifecycleReady={onSurfaceLifecycleReady}
        reportPresentation={reportPresentation}
      />
    );
  }
  return (
    <CanvasDrawSurface
      filePath={filePath}
      notebookPath={notebookPath}
      readOnly={readOnly}
      initialText={route.text}
      onSurfaceLifecycleReady={onSurfaceLifecycleReady}
      reportPresentation={reportPresentation}
    />
  );
}
