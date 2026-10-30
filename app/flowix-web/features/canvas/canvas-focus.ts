/**
 * Which canvas surface owns keyboard input right now.
 *
 * Obsidian (and Excalidraw) bind bare single-letter keys to canvas tools — `V`
 * select, `H` hand, `R` rectangle. A bare key is only safe while the canvas is
 * the thing the user is interacting with, so the board marks itself active on
 * pointer/focus entry and drops the mark when the pointer lands anywhere else.
 *
 * Kept as a tiny module-level flag (no React state) because the shortcut
 * registry asks this question from a keydown handler, outside any component.
 */

let activeSurfaceId: string | null = null;
/** Surface id -> number of mounted boards claiming it (StrictMode double-mount). */
const claims = new Map<string, number>();

/** Mark a surface as the canvas that should receive tool shortcuts. */
export function setActiveCanvasSurface(surfaceId: string | null): void {
  activeSurfaceId = surfaceId;
}

export function getActiveCanvasSurface(): string | null {
  return activeSurfaceId;
}

/** True while any board is the active surface — used by action `when` hooks. */
export function isCanvasSurfaceActive(): boolean {
  return activeSurfaceId !== null;
}

/** Claim a surface on mount; the last claim wins as the active surface. */
export function claimCanvasSurface(surfaceId: string): void {
  claims.set(surfaceId, (claims.get(surfaceId) ?? 0) + 1);
  activeSurfaceId = surfaceId;
}

/** Release on unmount; the flag is cleared when no board is left. */
export function releaseCanvasSurface(surfaceId: string): void {
  const remaining = (claims.get(surfaceId) ?? 1) - 1;
  if (remaining > 0) {
    claims.set(surfaceId, remaining);
    return;
  }
  claims.delete(surfaceId);
  if (activeSurfaceId === surfaceId) activeSurfaceId = null;
}
