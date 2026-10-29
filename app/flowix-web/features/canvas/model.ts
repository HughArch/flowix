/**
 * `.flowix-canvas` document model.
 *
 * A canvas file is plain JSON so the FNS file channel syncs it without any
 * special casing. The schema mirrors docs/INFINITE-CANVAS-FEASIBILITY.md §15:
 * `elements` is the Excalidraw drawing layer; `cards`/`shapes`/`ink`/`edges`/
 * `frames` form the Phase 2 board layer, and a document with cards renders as
 * a card board instead of a drawing surface. Image bitmaps are referenced
 * through the scene `files` map; both are size-capped on save so a single
 * canvas cannot silently exceed the sync attachment limit.
 */

export const CANVAS_FILE_EXTENSION = 'flowix-canvas';
export const CANVAS_DOCUMENT_TYPE = 'flowix/canvas';
export const CANVAS_DOCUMENT_VERSION = 1;

/** Excalidraw `BinaryFileData` values are data URLs; keep them far below the sync attachment cap. */
export const MAX_CANVAS_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_CANVAS_FILES_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_CANVAS_ELEMENTS = 5000;
/** Board-layer guard: cards/edges/frames are far lighter than elements but still need a ceiling. */
export const MAX_CANVAS_CARDS = 2000;
export const MAX_CANVAS_INK_STROKES = 2000;
export const MAX_CANVAS_INK_POINTS = 4000;

export interface FlowixCanvasMeta {
  createdAt: string;
  updatedAt: string;
}

/** Persisted slice of the Excalidraw app state; session state (scroll/selection) is dropped. */
export interface PersistedCanvasAppState {
  viewBackgroundColor?: string;
  gridSize?: number | null;
  gridModeEnabled?: boolean;
  /** Board-layer viewport, persisted so reopening a board restores the camera. */
  viewport?: BoardViewport;
}

/** Board-layer card node. Note identity follows the note-link convention
 * (`notebookId` + notebook-relative `path`); `title` is a snapshot used when
 * the note cannot be resolved and as a rebind hint. */
export interface BoardCard {
  id: string;
  kind: 'note' | 'text' | 'image' | 'canvas';
  x: number;
  y: number;
  w: number;
  h: number;
  notebookId?: string;
  path?: string;
  title?: string;
  text?: string;
  /** Image cards reference the canvas `files` map by id. */
  fileId?: string;
}

export interface BoardEdge {
  id: string;
  from: string;
  to: string;
  label?: string | null;
}

export interface BoardFrame {
  id: string;
  title?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color?: string;
}

export interface BoardViewport {
  x: number;
  y: number;
  zoom: number;
}

/** Freehand stroke in board (flow) coordinates. */
export interface BoardInkStroke {
  id: string;
  points: number[][];
  color: string;
  width: number;
}

export type BoardShapeKind = 'rect' | 'ellipse' | 'diamond';

/** Diagram shape in board (flow) coordinates; `text` is the inline label. */
export interface BoardShape {
  id: string;
  shape: BoardShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  stroke?: string;
  text?: string;
}

/**
 * Persisted image reference. New content stores a notebook-relative
 * `storageKey` (resolved through the attachments directory on each device);
 * `dataURL` remains readable for canvases written before externalization.
 */
export interface CanvasFileEntry {
  id: string;
  mimeType: string;
  storageKey?: string;
  dataURL?: string;
}

export interface FlowixCanvasDocument {
  type: 'flowix/canvas';
  version: 1;
  meta: FlowixCanvasMeta;
  /** Excalidraw element objects; schema is owned by the editor layer. */
  elements: unknown[];
  /** Board-layer card nodes. A document with cards renders as a card board. */
  cards: unknown[];
  /** Board-layer shape nodes (rect/ellipse/diamond); Phase 2.3 writes these. */
  shapes: unknown[];
  /** Board-layer freehand strokes; Phase 2.3 writes these. */
  ink: unknown[];
  /** Board-layer edges between cards/shapes. */
  edges: unknown[];
  /** Board-layer grouping frames. */
  frames: unknown[];
  /** Excalidraw binary files (image bitmaps), keyed by file id. */
  files: Record<string, unknown>;
  appState?: PersistedCanvasAppState;
}

export class CanvasParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanvasParseError';
  }
}

export function isCanvasFilePath(path: string): boolean {
  return path.trim().toLowerCase().endsWith(`.${CANVAS_FILE_EXTENSION}`);
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createCanvasDocument(): FlowixCanvasDocument {
  const timestamp = nowIso();
  return {
    type: CANVAS_DOCUMENT_TYPE,
    version: CANVAS_DOCUMENT_VERSION,
    meta: { createdAt: timestamp, updatedAt: timestamp },
    elements: [],
    cards: [],
    shapes: [],
    ink: [],
    edges: [],
    frames: [],
    files: {},
  };
}

export function createCanvasDocumentText(): string {
  return `${JSON.stringify(createCanvasDocument(), null, 2)}\n`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse stored text; throws `CanvasParseError` for content the editor cannot open. */
export function parseCanvasDocument(text: string): FlowixCanvasDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CanvasParseError('画布文件不是有效的 JSON');
  }
  if (!isPlainObject(raw) || raw.type !== CANVAS_DOCUMENT_TYPE) {
    throw new CanvasParseError('画布文件类型不正确');
  }
  const version = raw.version;
  if (version !== CANVAS_DOCUMENT_VERSION) {
    throw new CanvasParseError(`不支持的画布版本: ${String(version)}`);
  }
  const meta = isPlainObject(raw.meta) ? raw.meta : {};
  // Board arrays pass through untouched (entries are kept by reference) so a
  // parse -> serialize round-trip stays byte-stable for fields the reading
  // surface has not edited yet; the board view swaps in normalized values on
  // its first real change.
  const passthrough = (value: unknown): unknown[] =>
    Array.isArray(value) ? value.filter(isPlainObject).slice(0, MAX_CANVAS_CARDS) : [];
  const document: FlowixCanvasDocument = {
    type: CANVAS_DOCUMENT_TYPE,
    version: CANVAS_DOCUMENT_VERSION,
    meta: {
      createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : nowIso(),
      updatedAt: typeof meta.updatedAt === 'string' ? meta.updatedAt : nowIso(),
    },
    elements: Array.isArray(raw.elements)
      ? raw.elements.filter(isPlainObject).slice(0, MAX_CANVAS_ELEMENTS)
      : [],
    cards: passthrough(raw.cards),
    shapes: passthrough(raw.shapes),
    ink: passthrough(raw.ink),
    edges: passthrough(raw.edges),
    frames: passthrough(raw.frames),
    files: isPlainObject(raw.files) ? raw.files : {},
  };
  const appState = pickPersistedAppState(raw.appState);
  if (Object.keys(appState).length > 0) document.appState = appState;
  return document;
}

const DATA_URL_RE = /^data:([^;,]+)?(?:;[^,]*)?;base64,/i;

/** Normalize the persisted `files` map into typed entries. */
export function readCanvasFileEntries(files: Record<string, unknown>): CanvasFileEntry[] {
  const entries: CanvasFileEntry[] = [];
  for (const [id, value] of Object.entries(files)) {
    if (!isPlainObject(value)) continue;
    const mimeType = typeof value.mimeType === 'string' ? value.mimeType : 'image/png';
    const storageKey = typeof value.storageKey === 'string' && value.storageKey.trim()
      ? value.storageKey
      : undefined;
    const dataURL = typeof value.dataURL === 'string' && DATA_URL_RE.test(value.dataURL)
      ? value.dataURL
      : undefined;
    if (storageKey || dataURL) entries.push({ id, mimeType, ...(storageKey ? { storageKey } : {}), ...(dataURL ? { dataURL } : {}) });
  }
  return entries;
}

/** `data:image/png;base64,AAAA` -> `AAAA`. */
export function dataUrlPayload(dataURL: string): string | null {
  const match = DATA_URL_RE.exec(dataURL);
  if (!match) return null;
  return dataURL.slice(match[0].length);
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
};

/** File name used when persisting a canvas bitmap into attachments/. */
export function canvasFileNameFor(id: string, mimeType: string): string {
  const extension = EXTENSION_BY_MIME[mimeType] ?? 'png';
  return `${id}.${extension}`;
}

/**
 * Merge live editor state into a document and serialize it.
 * Returns the JSON text plus how many oversized bitmaps were dropped; the view
 * surfaces that count so users know why an image disappeared after reload.
 */
export function serializeCanvasDocument(
  document: FlowixCanvasDocument,
  elements: readonly unknown[],
  appState: PersistedCanvasAppState | null | undefined,
  files: Record<string, unknown> | null | undefined,
  storageKeys?: ReadonlyMap<string, string>,
  options?: { touchUpdatedAt?: boolean },
): { text: string; droppedFileCount: number } {
  const keptElements = elements.filter(isPlainObject).slice(0, MAX_CANVAS_ELEMENTS);
  const keptFiles: Record<string, unknown> = {};
  let totalBytes = 0;
  let droppedFileCount = 0;
  // Persisted references always survive serialization. A device that could not
  // hydrate an image (attachment not synced yet, transient read failure) still
  // has the reference in its scene; dropping it here would erase the image for
  // every other device on the next sync.
  for (const entry of readCanvasFileEntries(document.files)) {
    if (!storageKeys?.has(entry.id)) keptFiles[entry.id] = document.files[entry.id];
  }
  for (const [id, file] of Object.entries(files ?? {})) {
    const mimeType = isPlainObject(file) && typeof file.mimeType === 'string' ? file.mimeType : 'image/png';
    // Externalized bitmaps live in attachments/; only their key is persisted.
    const storageKey = storageKeys?.get(id);
    if (storageKey) {
      keptFiles[id] = { id, mimeType, storageKey };
      continue;
    }
    const size = dataUrlByteLength(file);
    if (size > MAX_CANVAS_FILE_BYTES || totalBytes + size > MAX_CANVAS_FILES_TOTAL_BYTES) {
      droppedFileCount += 1;
      continue;
    }
    totalBytes += size;
    keptFiles[id] = file;
  }
  const next: FlowixCanvasDocument = {
    ...document,
    // Callers compare an untouchable serialization against what is on disk
    // first: touching updatedAt unconditionally made every open look like an
    // edit, which rewrote the file and re-sorted it in the tree.
    meta: { ...document.meta, updatedAt: options?.touchUpdatedAt === false ? document.meta.updatedAt : nowIso() },
    elements: keptElements,
    cards: document.cards,
    files: keptFiles,
  };
  const persistedAppState = appState ?? {};
  const text = JSON.stringify({ ...next, appState: persistedAppState }, null, 2);
  return { text: `${text}\n`, droppedFileCount };
}

function dataUrlByteLength(file: unknown): number {
  if (!isPlainObject(file) || typeof file.dataURL !== 'string') return 0;
  // data URLs are ASCII; string length is a close-enough byte proxy for the cap.
  return file.dataURL.length;
}

/** Keep only the whitelisted app-state fields the editor persists. */
function pickPersistedAppState(stored: unknown): PersistedCanvasAppState {
  if (!isPlainObject(stored)) return {};
  const state: PersistedCanvasAppState = {};
  if (typeof stored.viewBackgroundColor === 'string') state.viewBackgroundColor = stored.viewBackgroundColor;
  if (typeof stored.gridSize === 'number' || stored.gridSize === null) state.gridSize = stored.gridSize as number | null;
  if (typeof stored.gridModeEnabled === 'boolean') state.gridModeEnabled = stored.gridModeEnabled;
  const viewport = pickBoardViewport(stored.viewport);
  if (viewport) state.viewport = viewport;
  return state;
}

function pickBoardViewport(value: unknown): BoardViewport | null {
  if (!isPlainObject(value)) return null;
  const x = value.x;
  const y = value.y;
  const zoom = value.zoom;
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  if (typeof y !== 'number' || !Number.isFinite(y)) return null;
  if (typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom <= 0) return null;
  return { x, y, zoom };
}

/** Restore only the whitelisted app-state fields the editor persists. */
export function readPersistedAppState(document: FlowixCanvasDocument): PersistedCanvasAppState {
  return document.appState ?? {};
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function coerceBoardCard(raw: Record<string, unknown>): BoardCard | null {
  const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
  const x = readFiniteNumber(raw.x);
  const y = readFiniteNumber(raw.y);
  const w = readFiniteNumber(raw.w);
  const h = readFiniteNumber(raw.h);
  if (!id || x === null || y === null || w === null || h === null) return null;
  const kind = raw.kind === 'text' || raw.kind === 'image' || raw.kind === 'canvas' ? raw.kind : 'note';
  const optionalText = (value: unknown): string | undefined =>
    typeof value === 'string' && value ? value : undefined;
  return {
    id,
    kind,
    x,
    y,
    w: Math.max(16, w),
    h: Math.max(16, h),
    ...(optionalText(raw.notebookId) ? { notebookId: optionalText(raw.notebookId) } : {}),
    ...(optionalText(raw.path) ? { path: optionalText(raw.path) } : {}),
    ...(optionalText(raw.title) ? { title: optionalText(raw.title) } : {}),
    ...(optionalText(raw.text) ? { text: optionalText(raw.text) } : {}),
    ...(optionalText(raw.fileId) ? { fileId: optionalText(raw.fileId) } : {}),
  };
}

/** Normalized board cards; malformed entries are skipped instead of failing the file. */
export function readBoardCards(document: FlowixCanvasDocument): BoardCard[] {
  const cards: BoardCard[] = [];
  for (const raw of document.cards) {
    if (!isPlainObject(raw)) continue;
    const card = coerceBoardCard(raw);
    if (card) cards.push(card);
  }
  return cards;
}

export function readBoardEdges(document: FlowixCanvasDocument): BoardEdge[] {
  const edges: BoardEdge[] = [];
  for (const raw of document.edges) {
    if (!isPlainObject(raw)) continue;
    const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
    const from = typeof raw.from === 'string' && raw.from ? raw.from : null;
    const to = typeof raw.to === 'string' && raw.to ? raw.to : null;
    if (!id || !from || !to) continue;
    edges.push({
      id,
      from,
      to,
      ...(typeof raw.label === 'string' && raw.label ? { label: raw.label } : {}),
    });
  }
  return edges;
}

export function readBoardFrames(document: FlowixCanvasDocument): BoardFrame[] {
  const frames: BoardFrame[] = [];
  for (const raw of document.frames) {
    if (!isPlainObject(raw)) continue;
    const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
    const x = readFiniteNumber(raw.x);
    const y = readFiniteNumber(raw.y);
    const w = readFiniteNumber(raw.w);
    const h = readFiniteNumber(raw.h);
    if (!id || x === null || y === null || w === null || h === null) continue;
    frames.push({
      id,
      x,
      y,
      w: Math.max(16, w),
      h: Math.max(16, h),
      ...(typeof raw.title === 'string' && raw.title ? { title: raw.title } : {}),
      ...(typeof raw.color === 'string' && raw.color ? { color: raw.color } : {}),
    });
  }
  return frames;
}

export function readBoardViewport(document: FlowixCanvasDocument): BoardViewport | null {
  return readPersistedAppState(document).viewport ?? null;
}

export function readBoardShapes(document: FlowixCanvasDocument): BoardShape[] {
  const shapes: BoardShape[] = [];
  for (const raw of document.shapes.slice(0, MAX_CANVAS_CARDS)) {
    if (!isPlainObject(raw)) continue;
    const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
    const x = readFiniteNumber(raw.x);
    const y = readFiniteNumber(raw.y);
    const w = readFiniteNumber(raw.w);
    const h = readFiniteNumber(raw.h);
    if (!id || x === null || y === null || w === null || h === null) continue;
    const shape = raw.shape === 'ellipse' || raw.shape === 'diamond' ? raw.shape : 'rect';
    const text = typeof raw.text === 'string' && raw.text ? raw.text : undefined;
    const fill = typeof raw.fill === 'string' && raw.fill ? raw.fill : undefined;
    const stroke = typeof raw.stroke === 'string' && raw.stroke ? raw.stroke : undefined;
    shapes.push({
      id,
      shape,
      x,
      y,
      w: Math.max(16, w),
      h: Math.max(16, h),
      ...(fill ? { fill } : {}),
      ...(stroke ? { stroke } : {}),
      ...(text ? { text } : {}),
    });
  }
  return shapes;
}

export function readBoardInk(document: FlowixCanvasDocument): BoardInkStroke[] {
  const strokes: BoardInkStroke[] = [];
  for (const raw of document.ink.slice(0, MAX_CANVAS_INK_STROKES)) {
    if (!isPlainObject(raw)) continue;
    const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
    const color = typeof raw.color === 'string' && raw.color ? raw.color : null;
    const width = readFiniteNumber(raw.width);
    if (!id || !color || width === null || width <= 0) continue;
    const rawPoints = Array.isArray(raw.points) ? raw.points.slice(0, MAX_CANVAS_INK_POINTS) : [];
    const points: number[][] = [];
    for (const point of rawPoints) {
      if (!Array.isArray(point)) continue;
      const x = readFiniteNumber(point[0]);
      const y = readFiniteNumber(point[1]);
      if (x === null || y === null) continue;
      points.push([x, y]);
    }
    if (points.length < 2) continue;
    strokes.push({ id, points, color, width });
  }
  return strokes;
}
