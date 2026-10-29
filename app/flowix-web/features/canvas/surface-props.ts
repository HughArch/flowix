import type { SurfaceLifecycle, SurfacePresentationUpdate } from '@features/workspace/public/surface-api';

/** Props shared by both canvas renderers (drawing surface and card board). */
export interface CanvasSurfaceViewProps {
  filePath: string;
  notebookPath: string | null;
  readOnly?: boolean;
  onSurfaceLifecycleReady?: (lifecycle: SurfaceLifecycle | null) => void;
  reportPresentation?: (update: SurfacePresentationUpdate) => void;
}

/** Parsed file text handed over by the routing surface so children skip a duplicate read. */
export interface InitialTextSource {
  /** Consumed on the first load only; retries re-read from disk. */
  initialText?: string | null;
}
