/**
 * `.flowix-canvas` document model.
 *
 * A canvas file is plain JSON so the FNS file channel syncs it without any
 * special casing. The schema mirrors the decisions in
 * docs/INFINITE-CANVAS-FEASIBILITY.md §2: Excalidraw-compatible `elements`
 * today, a reserved `cards` array for note-card nodes later. Image bitmaps are
 * referenced through the scene `files` map; both are size-capped on save so a
 * single drawing cannot silently exceed the sync attachment limit.
 */

export const CANVAS_FILE_EXTENSION = 'flowix-canvas';
export const CANVAS_DOCUMENT_TYPE = 'flowix/canvas';
export const CANVAS_DOCUMENT_VERSION = 1;

/** Excalidraw `BinaryFileData` values are data URLs; keep them far below the sync attachment cap. */
export const MAX_CANVAS_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_CANVAS_FILES_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_CANVAS_ELEMENTS = 5000;

export interface FlowixCanvasMeta {
  createdAt: string;
  updatedAt: string;
}

/** Persisted slice of the Excalidraw app state; session state (scroll/selection) is dropped. */
export interface PersistedCanvasAppState {
  viewBackgroundColor?: string;
  gridSize?: number | null;
  gridModeEnabled?: boolean;
}

export interface FlowixCanvasDocument {
  type: 'flowix/canvas';
  version: 1;
  meta: FlowixCanvasMeta;
  /** Excalidraw element objects; schema is owned by the editor layer. */
  elements: unknown[];
  /** Phase 2 note-card nodes. Reserved and always empty in v1. */
  cards: unknown[];
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
    cards: Array.isArray(raw.cards) ? raw.cards.filter(isPlainObject) : [],
    files: isPlainObject(raw.files) ? raw.files : {},
  };
  const appState = pickPersistedAppState(raw.appState);
  if (Object.keys(appState).length > 0) document.appState = appState;
  return document;
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
): { text: string; droppedFileCount: number } {
  const keptElements = elements.filter(isPlainObject).slice(0, MAX_CANVAS_ELEMENTS);
  const keptFiles: Record<string, unknown> = {};
  let totalBytes = 0;
  let droppedFileCount = 0;
  for (const [id, file] of Object.entries(files ?? {})) {
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
    meta: { ...document.meta, updatedAt: nowIso() },
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
  return state;
}

/** Restore only the whitelisted app-state fields the editor persists. */
export function readPersistedAppState(document: FlowixCanvasDocument): PersistedCanvasAppState {
  return document.appState ?? {};
}
