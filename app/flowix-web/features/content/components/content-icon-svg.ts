/**
 * Inline SVG twins of the shared `ContentIcon` glyphs, for the plain-DOM
 * renderers (composer menus, ProseMirror node views) that cannot mount React.
 * Keep the shapes in sync with `content-icon.tsx`.
 */

/** Lucide Frame — the canvas board glyph (file tree, @ dropdown, badges). */
export const CANVAS_FILE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 6H4a2 2 0 0 0-.4 3.95L6.8 11a1 1 0 0 1 0 1.9l-3.2 1.05A2 2 0 0 0 4 18h18"/><line x1="6" x2="6" y1="3" y2="7"/><line x1="10" x2="10" y1="3" y2="7"/><line x1="14" x2="14" y1="3" y2="7"/><line x1="18" x2="18" y1="3" y2="7"/><line x1="6" x2="6" y1="17" y2="21"/><line x1="10" x2="10" y1="17" y2="21"/><line x1="14" x2="14" y1="17" y2="21"/><line x1="18" x2="18" y1="17" y2="21"/></svg>`;

/** Phosphor-style document glyph for Markdown notes. */
export const NOTE_FILE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 18 18" fill="none" aria-hidden="true"><g transform="matrix(0.6923077 0 0 0.6923077 0.6923077 0.6923077)"><line x1="7.6666" y1="11.36" x2="10.3333" y2="11.36" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.2" vector-effect="non-scaling-stroke"/><line x1="7.6666" y1="15.18" x2="16.3333" y2="15.18" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.2" vector-effect="non-scaling-stroke"/><path d="M 3.6667 19 V 5 c 0 -1.4733 1.1933 -2.6667 2.6667 -2.6667 h 7.448 c 0.3533 0 0.6933 0.14 0.9427 0.3907 l 5.2187 5.2187 c 0.2507 0.2507 0.3907 0.5893 0.3907 0.9427 v 10.1146 c 0 1.4733 -1.1933 2.6667 -2.6667 2.6667 H 6.3333 c -1.4733 0 -2.6667 -1.1933 -2.6667 -2.6667 Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.2" vector-effect="non-scaling-stroke"/><path d="M 20.2133 8.3333 h -4.5467 c -0.736 0 -1.3333 -0.5973 -1.3333 -1.3333 V 2.4693" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.2" vector-effect="non-scaling-stroke"/></g></svg>`;

/** Right glyph for a notebook-relative path; falls back to the note glyph. */
export function fileIconSvgForPath(path: string): string {
  return /\.flowix-canvas$/i.test(path) ? CANVAS_FILE_ICON_SVG : NOTE_FILE_ICON_SVG;
}
