'use client';

/**
 * Canvas surface entry. All `.flowix-canvas` documents render as the Phase 2
 * card board (react-flow); the Phase 1 Excalidraw drawing surface is retired
 * — legacy test files keep their `elements` on disk but no longer render it.
 */

export { CanvasBoardView as CanvasSurfaceView, type CanvasBoardViewProps as CanvasSurfaceViewProps } from './canvas-board-view';
