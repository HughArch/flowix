import type { SurfaceLifecycle, SurfacePresentationUpdate } from '@features/workspace/public/surface-api';

/** Props shared by the canvas board renderer and its hosts. */
export interface CanvasSurfaceViewProps {
  filePath: string;
  notebookPath: string | null;
  readOnly?: boolean;
  onSurfaceLifecycleReady?: (lifecycle: SurfaceLifecycle | null) => void;
  reportPresentation?: (update: SurfacePresentationUpdate) => void;
}
