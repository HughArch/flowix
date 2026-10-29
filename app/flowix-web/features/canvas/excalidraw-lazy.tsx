import { lazy } from 'react';

// The stylesheet rides the same chunk as the component so the main bundle never
// carries Excalidraw CSS for sessions that never open a canvas.
import '@excalidraw/excalidraw/index.css';

/** Single lazy boundary for Excalidraw; keep it stable so the chunk loads once per session. */
export const LazyExcalidraw = lazy(async () => {
  const module = await import('@excalidraw/excalidraw');
  return { default: module.Excalidraw };
});
