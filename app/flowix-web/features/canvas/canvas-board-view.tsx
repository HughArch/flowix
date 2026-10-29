'use client';

/**
 * Card board canvas renderer (Phase 2.1 skeleton) — the only `.flowix-canvas`
 * renderer since the Excalidraw drawing surface was retired.
 *
 * react-flow owns the viewport, cards render as custom nodes, and every
 * mutation (drag, pan) flows through a byte-compare flush so opening a board
 * is never an edit. Card summaries are title snapshots for now; the batch
 * excerpt IPC lands in the next chunk.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type NodeProps,
  type OnNodesChange,
  type Viewport,
} from '@xyflow/react';
import { getStroke } from 'perfect-freehand';
import '@xyflow/react/dist/style.css';
import { Eraser, FileText, Frame as FrameIcon, Image as ImageIcon, MousePointer2, Pencil } from 'lucide-react';
import { files, notebookAssets } from '@platform/tauri/client';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { openNoteByNotebookPath } from '@features/memo/public/note-navigation-api';
import { subscribeExternalDocumentChanges } from '@features/document/store/external-document-watch';
import { createLogger } from '@/lib/logger';
import {
  CanvasParseError,
  parseCanvasDocument,
  readBoardCards,
  readBoardEdges,
  readBoardFrames,
  readBoardInk,
  readBoardViewport,
  readCanvasFileEntries,
  readPersistedAppState,
  serializeCanvasDocument,
  type BoardCard,
  type BoardInkStroke,
  type FlowixCanvasDocument,
} from './model';
import { type CanvasSurfaceViewProps } from './surface-props';

const SAVE_DEBOUNCE_MS = 800;
const logger = createLogger('canvas-board');
/** Retry cadence for image cards whose attachment had not synced on open. */
const IMAGE_RETRY_DELAYS_MS = [3_000, 8_000, 15_000];

interface BoardNodeData extends Record<string, unknown> {
  card: BoardCard;
  dataUrl: string | null;
}

type BoardNode = Node<BoardNodeData>;

function cardTitle(card: BoardCard): string {
  if (card.title) return card.title;
  if (card.path) {
    const leaf = card.path.split('/').pop() ?? card.path;
    return leaf.replace(/\.md$/i, '');
  }
  return card.id;
}

/** Shared card chrome: hidden handles let future edges anchor on any render. */
function CardHandles() {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} className="!opacity-0" />
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="!opacity-0" />
    </>
  );
}

function NoteCardNode({ data }: NodeProps<BoardNode>) {
  const { t } = useI18n();
  const { card } = data;
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--card)] shadow-sm">
      <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
        <FileText className="h-3 w-3 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
        <span className="truncate text-xs font-semibold text-[var(--foreground)]">{cardTitle(card)}</span>
      </div>
      <div className="flex flex-1 items-center justify-center px-2.5 text-[11px] leading-relaxed text-[var(--muted-foreground)]">
        {t('canvas.board.doubleClickOpen')}
      </div>
      {card.path ? (
        <div className="truncate border-t border-[var(--border)] px-2.5 py-1 text-[10px] text-[var(--muted-foreground)]">
          {card.path}
        </div>
      ) : null}
      <CardHandles />
    </div>
  );
}

function StickyNode({ data }: NodeProps<BoardNode>) {
  const { card } = data;
  return (
    <div className="h-full w-full overflow-hidden rounded-[10px] border border-amber-300/60 bg-amber-50 p-2 shadow-sm dark:border-amber-500/30 dark:bg-amber-950/40">
      <div className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--foreground)]">
        {card.text || ''}
      </div>
      <CardHandles />
    </div>
  );
}

function ImageCardNode({ data }: NodeProps<BoardNode>) {
  const { t } = useI18n();
  const { dataUrl } = data;
  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--muted)] shadow-sm">
      {dataUrl
        ? <img src={dataUrl} alt={cardTitle(data.card)} className="h-full w-full object-cover" draggable={false} />
        : (
          <div className="flex flex-col items-center gap-1 text-[var(--muted-foreground)]">
            <ImageIcon className="h-4 w-4" aria-hidden="true" />
            <span className="text-[10px]">{t('canvas.board.imageMissing')}</span>
          </div>
        )}
      <CardHandles />
    </div>
  );
}

function CanvasRefNode({ data }: NodeProps<BoardNode>) {
  const { t } = useI18n();
  const { card } = data;
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--card)] shadow-sm">
      <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
        <FrameIcon className="h-3 w-3 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
        <span className="truncate text-xs font-semibold text-[var(--foreground)]">{cardTitle(card)}</span>
      </div>
      <div className="flex flex-1 items-center justify-center px-2.5 text-[11px] text-[var(--muted-foreground)]">
        {t('canvas.board.doubleClickOpen')}
      </div>
      <CardHandles />
    </div>
  );
}

function FrameNode({ data }: NodeProps<BoardNode>) {
  const { card } = data;
  return (
    <div
      className="h-full w-full rounded-xl border-2 border-dashed bg-[var(--muted)]/30"
      style={{ borderColor: 'color-mix(in srgb, var(--muted-foreground) 45%, transparent)' }}
    >
      {card.title ? (
        <div className="absolute -top-6 left-0 flex items-center gap-1 whitespace-nowrap text-[11px] font-medium text-[var(--muted-foreground)]">
          <FrameIcon className="h-3 w-3" aria-hidden="true" />
          {card.title}
        </div>
      ) : null}
    </div>
  );
}

const NODE_TYPES = {
  note: NoteCardNode,
  sticky: StickyNode,
  image: ImageCardNode,
  canvasref: CanvasRefNode,
  frame: FrameNode,
};

type BoardTool = 'select' | 'pen' | 'eraser';

const INK_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#a855f7', '#64748b'];
const INK_WIDTHS = [2, 5, 10];
/** Ink renders above cards: annotation strokes cross card bodies like on a whiteboard. */
const INK_Z_INDEX = 20;
const INK_ERASE_PADDING = 8;

function freehandOptions(width: number) {
  return { size: width * 2, thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: true };
}

/** perfect-freehand outline points -> filled SVG path (README helper). */
function svgPathFromStroke(stroke: number[][], closed = true): string {
  const length = stroke.length;
  if (length < 4) return '';
  const avg = (a: number, b: number) => (a + b) / 2;
  let [a, b, c] = stroke;
  let result = `M${a[0]},${a[1]} Q${b[0]},${b[1]} ${avg(b[0], c[0])},${avg(b[1], c[1])} T`;
  for (let i = 2; i < length - 1; i += 1) {
    a = stroke[i];
    b = stroke[i + 1];
    result += `${avg(a[0], b[0])},${avg(a[1], b[1])} `;
  }
  return closed ? `${result}Z` : result;
}

function inkPathFor(stroke: BoardInkStroke): string {
  return svgPathFromStroke(getStroke(stroke.points, freehandOptions(stroke.width)));
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Stroke eraser hit test: sample the polyline, not the rendered outline. */
function inkStrokeHit(stroke: BoardInkStroke, x: number, y: number, zoom: number): boolean {
  const threshold = stroke.width / 2 + INK_ERASE_PADDING / Math.max(0.1, zoom);
  const points = stroke.points;
  if (points.length === 1) return Math.hypot(x - points[0][0], y - points[0][1]) <= threshold;
  for (let i = 0; i < points.length - 1; i += 1) {
    if (distanceToSegment(x, y, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]) <= threshold) return true;
  }
  return false;
}

function inkStrokeId(): string {
  return `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nodeKindForCard(card: BoardCard): BoardNode['type'] {
  if (card.kind === 'text') return 'sticky';
  if (card.kind === 'image') return 'image';
  if (card.kind === 'canvas') return 'canvasref';
  return 'note';
}

function buildBoardGraph(
  document: FlowixCanvasDocument,
  dataUrls: ReadonlyMap<string, string>,
): { nodes: BoardNode[]; edges: Edge[] } {
  const nodes: BoardNode[] = [];
  for (const frame of readBoardFrames(document)) {
    nodes.push({
      id: frame.id,
      type: 'frame',
      position: { x: frame.x, y: frame.y },
      zIndex: 0,
      data: { card: { id: frame.id, kind: 'text', x: frame.x, y: frame.y, w: frame.w, h: frame.h, title: frame.title }, dataUrl: null },
      style: { width: frame.w, height: frame.h },
    });
  }
  for (const card of readBoardCards(document)) {
    nodes.push({
      id: card.id,
      type: nodeKindForCard(card),
      position: { x: card.x, y: card.y },
      zIndex: 10,
      data: { card, dataUrl: card.fileId ? dataUrls.get(card.fileId) ?? null : null },
      style: { width: card.w, height: card.h },
    });
  }
  const cardIds = new Set(nodes.filter((node) => node.zIndex === 10).map((node) => node.id));
  const edges: Edge[] = [];
  for (const edge of readBoardEdges(document)) {
    if (!cardIds.has(edge.from) || !cardIds.has(edge.to)) continue;
    edges.push({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      ...(edge.label ? { label: edge.label } : {}),
      style: { stroke: 'color-mix(in srgb, var(--muted-foreground) 55%, transparent)', strokeWidth: 1.5 },
    });
  }
  return { nodes, edges };
}

/** Map of canvas file id -> resolved data URL for image cards. */
async function hydrateImageCards(
  document: FlowixCanvasDocument,
  notebookPath: string | null,
): Promise<Map<string, string>> {
  const dataUrls = new Map<string, string>();
  const fileEntries = new Map(readCanvasFileEntries(document.files).map((entry) => [entry.id, entry]));
  for (const card of readBoardCards(document)) {
    if (card.kind !== 'image' || !card.fileId) continue;
    const entry = fileEntries.get(card.fileId);
    if (!entry) continue;
    if (entry.dataURL) {
      dataUrls.set(entry.id, entry.dataURL);
      continue;
    }
    if (!entry.storageKey) continue;
    const dataURL = await notebookAssets
      .readContent({ storageKey: entry.storageKey, notePath: notebookPath ?? undefined })
      .catch(() => null);
    if (dataURL) dataUrls.set(entry.id, dataURL);
  }
  return dataUrls;
}

export interface CanvasBoardViewProps extends CanvasSurfaceViewProps {}

type BoardLoadState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string };

export function CanvasBoardView(props: CanvasBoardViewProps) {
  return (
    <ReactFlowProvider>
      <BoardSurface {...props} />
    </ReactFlowProvider>
  );
}

function BoardSurface({ filePath, notebookPath, readOnly = false, onSurfaceLifecycleReady, reportPresentation }: CanvasBoardViewProps) {
  const { t } = useI18n();
  const reactFlow = useReactFlow();
  const [state, setState] = useState<BoardLoadState>({ status: 'loading' });
  const [retryToken, setRetryToken] = useState(0);
  const [nodes, setNodes] = useState<BoardNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [initialViewport, setInitialViewport] = useState<Viewport | null>(null);
  const [ink, setInk] = useState<BoardInkStroke[]>([]);
  const [livePoints, setLivePoints] = useState<number[][] | null>(null);
  const [tool, setTool] = useState<BoardTool>('select');
  const [penColor, setPenColor] = useState(INK_COLORS[3]);
  const [penWidth, setPenWidth] = useState(INK_WIDTHS[1]);
  const documentRef = useRef<FlowixCanvasDocument | null>(null);
  const cardsRef = useRef<BoardCard[]>([]);
  const inkRef = useRef<BoardInkStroke[]>([]);
  const liveStrokeRef = useRef<number[][] | null>(null);
  const dataUrlsRef = useRef<Map<string, string>>(new Map());
  const dirtyRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const lastSavedTextRef = useRef<string | null>(null);
  /** Canvas file id -> notebook-relative attachment key, for reference-safe serialization. */
  const storageKeysRef = useRef<Map<string, string>>(new Map());
  const imageRetryRef = useRef<number | null>(null);
  /** Viewport seen at load; the first move-end after a fitView mount is
   * programmatic and must not look like an edit (an open would rewrite the
   * file and re-sort the tree, the same trap the drawing surface hit). */
  const moveSeedRef = useRef<Viewport | null>(null);

  const retryLoad = useCallback(() => setRetryToken((token) => token + 1), []);

  const applyGraph = useCallback((document: FlowixCanvasDocument) => {
    const { nodes: nextNodes, edges: nextEdges } = buildBoardGraph(document, dataUrlsRef.current);
    setNodes(nextNodes);
    setEdges(nextEdges);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    documentRef.current = null;
    cardsRef.current = [];
    inkRef.current = [];
    liveStrokeRef.current = null;
    setTool('select');
    setLivePoints(null);
    dataUrlsRef.current = new Map();
    void (async () => {
      const text = await files.read(filePath, notebookPath ?? undefined);
      if (cancelled) return;
      if (text == null) {
        setState({ status: 'error', message: t('canvas.load.missing') });
        return;
      }
      const document = parseCanvasDocument(text);
      const dataUrls = await hydrateImageCards(document, notebookPath);
      if (cancelled) return;
      documentRef.current = document;
      cardsRef.current = readBoardCards(document);
      inkRef.current = readBoardInk(document);
      setInk(inkRef.current);
      dataUrlsRef.current = dataUrls;
      storageKeysRef.current = new Map(
        readCanvasFileEntries(document.files)
          .filter((entry) => entry.storageKey)
          .map((entry) => [entry.id, entry.storageKey as string]),
      );
      lastSavedTextRef.current = text;
      const storedViewport = readBoardViewport(document) ?? null;
      moveSeedRef.current = storedViewport;
      setInitialViewport(storedViewport);
      applyGraph(document);
      setState({ status: 'ready' });
    })().catch((error) => {
      if (!cancelled) setState({ status: 'error', message: error instanceof CanvasParseError ? error.message : error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [applyGraph, filePath, notebookPath, retryToken, t]);

  const flush = useCallback(async (): Promise<boolean> => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const document = documentRef.current;
    if (!document || !dirtyRef.current) return true;
    const build = () => serializeCanvasDocument(
      document,
      document.elements,
      readPersistedAppState(document),
      document.files,
      storageKeysRef.current,
      { touchUpdatedAt: false },
    );
    const stable = build();
    if (stable.text === lastSavedTextRef.current) {
      dirtyRef.current = false;
      return true;
    }
    document.meta = { ...document.meta, updatedAt: new Date().toISOString() };
    const { text } = build();
    try {
      const saved = await files.write(filePath, text, undefined, notebookPath ?? undefined);
      if (!saved) throw new Error('write_file returned false');
      dirtyRef.current = false;
      lastSavedTextRef.current = text;
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
    if (imageRetryRef.current !== null) window.clearTimeout(imageRetryRef.current);
  }, []);

  const handleNodesChange: OnNodesChange<BoardNode> = useCallback((changes: NodeChange<BoardNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const syncPositionsToDocument = useCallback((dragged: BoardNode[]) => {
    const document = documentRef.current;
    if (!document) return;
    let changed = false;
    for (const node of dragged) {
      const card = cardsRef.current.find((item) => item.id === node.id);
      if (card && (card.x !== node.position.x || card.y !== node.position.y)) {
        card.x = node.position.x;
        card.y = node.position.y;
        changed = true;
      }
    }
    if (!changed) return;
    // First real edit swaps the passthrough arrays for normalized values.
    document.cards = cardsRef.current;
    scheduleFlush();
  }, [scheduleFlush]);

  const handleNodeDragStop = useCallback(
    (event: unknown, node: BoardNode, dragged: BoardNode[]) => {
      void event;
      syncPositionsToDocument(dragged.length > 0 ? dragged : [node]);
    },
    [syncPositionsToDocument],
  );

  const handleMoveEnd = useCallback((event: unknown, viewport: Viewport) => {
    void event;
    const document = documentRef.current;
    if (!document) return;
    const seeded = moveSeedRef.current;
    const same = (a: Viewport | null, b: Viewport) =>
      !!a && a.x === b.x && a.y === b.y && a.zoom === b.zoom;
    if (same(seeded, viewport)) return;
    if (!seeded) {
      // Programmatic fitView on a board without a stored viewport.
      moveSeedRef.current = viewport;
      return;
    }
    const persisted = readBoardViewport(document);
    if (same(persisted, viewport)) return;
    document.appState = {
      ...readPersistedAppState(document),
      viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom },
    };
    moveSeedRef.current = { ...viewport };
    scheduleFlush();
  }, [scheduleFlush]);

  const handleNodeDoubleClick = useCallback<NodeMouseHandler<BoardNode>>(async (event, node) => {
    void event;
    if (tool !== 'select') return;
    const card = cardsRef.current.find((item) => item.id === node.id);
    if (!card || (card.kind !== 'note' && card.kind !== 'canvas')) return;
    if (!card.notebookId || !card.path) return;
    try {
      await openNoteByNotebookPath(card.notebookId, card.path);
    } catch (error) {
      logger.warn('canvas board open card failed', { path: card.path, error: String(error) });
      toast.error(t('canvas.board.openFailed'));
    }
  }, [t, tool]);

  const flowPositionOf = useCallback(
    (event: { clientX: number; clientY: number }): number[] => {
      const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      return [position.x, position.y];
    },
    [reactFlow],
  );

  const syncInkToDocument = useCallback((strokes: BoardInkStroke[]) => {
    const document = documentRef.current;
    if (!document) return;
    inkRef.current = strokes;
    setInk(strokes);
    // First real edit swaps the passthrough array for normalized values.
    document.ink = strokes;
    scheduleFlush();
  }, [scheduleFlush]);

  const eraseInkAt = useCallback((position: number[]) => {
    const zoom = reactFlow.getViewport().zoom;
    const kept = inkRef.current.filter((stroke) => !inkStrokeHit(stroke, position[0], position[1], zoom));
    if (kept.length !== inkRef.current.length) syncInkToDocument(kept);
  }, [reactFlow, syncInkToDocument]);

  const handleBoardPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (readOnly || tool === 'select' || event.button !== 0) return;
    if ((event.target as Element).closest('[data-board-toolbar]')) return;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic pointers cannot capture */ }
    if (tool === 'pen') {
      liveStrokeRef.current = [flowPositionOf(event)];
      setLivePoints(liveStrokeRef.current);
      return;
    }
    eraseInkAt(flowPositionOf(event));
  }, [eraseInkAt, flowPositionOf, readOnly, tool]);

  const handleBoardPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (readOnly || tool === 'select') return;
    const stroke = liveStrokeRef.current;
    if (tool === 'pen' && stroke) {
      const position = flowPositionOf(event);
      const last = stroke[stroke.length - 1];
      if (Math.hypot(position[0] - last[0], position[1] - last[1]) < 1) return;
      stroke.push(position);
      setLivePoints([...stroke]);
      return;
    }
    if (tool === 'eraser' && event.buttons % 2 === 1) eraseInkAt(flowPositionOf(event));
  }, [eraseInkAt, flowPositionOf, readOnly, tool]);

  const handleBoardPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const stroke = liveStrokeRef.current;
    liveStrokeRef.current = null;
    setLivePoints(null);
    if (!stroke) return;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    if (stroke.length === 1) stroke.push([stroke[0][0] + 0.01, stroke[0][1] + 0.01]);
    syncInkToDocument([...inkRef.current, {
      id: inkStrokeId(),
      points: stroke,
      color: penColor,
      width: penWidth,
    }]);
  }, [penColor, penWidth, syncInkToDocument]);

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
        if (timerRef.current !== null) return await flush();
        return dirtyRef.current ? await flush() : true;
      },
    });
    return () => onSurfaceLifecycleReady?.(null);
  }, [flush, onSurfaceLifecycleReady, state.status]);

  // Late-arriving attachments for image cards: retry a few times, then rebuild
  // the nodes so hydrated bitmaps render without a manual reopen.
  useEffect(() => {
    if (state.status !== 'ready') return;
    const document = documentRef.current;
    if (!document) return;
    let cancelled = false;
    let delayIndex = 0;
    const pendingImageIds = () => new Set(
      readBoardCards(document)
        .filter((card) => card.kind === 'image' && card.fileId && !dataUrlsRef.current.has(card.fileId))
        .map((card) => card.fileId as string),
    );
    if (pendingImageIds().size === 0) return;
    const run = async (): Promise<boolean> => {
      if (cancelled) return true;
      const pending = pendingImageIds();
      if (pending.size === 0) return true;
      const hydrated = await hydrateImageCards(document, notebookPath);
      const fresh = [...pending].filter((id) => hydrated.has(id));
      if (cancelled || fresh.length === 0) return false;
      for (const id of fresh) dataUrlsRef.current.set(id, hydrated.get(id) as string);
      applyGraph(document);
      return true;
    };
    const scheduleNext = () => {
      if (cancelled || delayIndex >= IMAGE_RETRY_DELAYS_MS.length) return;
      const delay = IMAGE_RETRY_DELAYS_MS[delayIndex++];
      imageRetryRef.current = window.setTimeout(() => {
        imageRetryRef.current = null;
        void run().then((done) => { if (!done && !cancelled) scheduleNext(); });
      }, delay);
    };
    scheduleNext();
    return () => {
      cancelled = true;
      if (imageRetryRef.current !== null) window.clearTimeout(imageRetryRef.current);
    };
  }, [applyGraph, notebookPath, state.status]);

  // Live refresh on FNS-delivered external writes; skipped while local edits
  // are pending, same contract as the drawing surface.
  useEffect(() => {
    if (state.status !== 'ready') return;
    return subscribeExternalDocumentChanges(filePath, notebookPath, async (payload, context) => {
      if (payload.kind !== 'modified') return;
      if (dirtyRef.current) {
        logger.info('canvas board external change skipped: local edits pending', { filePath: payload.path });
        return;
      }
      await context.runOnce(`canvas-board-reload:${filePath}`, async () => {
        const text = await files.read(filePath, notebookPath ?? undefined).catch(() => null);
        if (text == null || text === lastSavedTextRef.current) return;
        const document = parseCanvasDocument(text);
        const dataUrls = await hydrateImageCards(document, notebookPath);
        documentRef.current = document;
        cardsRef.current = readBoardCards(document);
        inkRef.current = readBoardInk(document);
        setInk(inkRef.current);
        dataUrlsRef.current = dataUrls;
        storageKeysRef.current = new Map(
          readCanvasFileEntries(document.files)
            .filter((entry) => entry.storageKey)
            .map((entry) => [entry.id, entry.storageKey as string]),
        );
        lastSavedTextRef.current = text;
        moveSeedRef.current = readBoardViewport(document);
        applyGraph(document);
      });
    });
  }, [applyGraph, filePath, notebookPath, state.status]);

  const defaultViewport = useMemo<Viewport>(
    () => initialViewport ?? { x: 0, y: 0, zoom: 1 },
    [initialViewport],
  );

  const inkPaths = useMemo(() => ink.map(inkPathFor), [ink]);
  const livePath = useMemo(
    () => (livePoints && livePoints.length >= 2 ? svgPathFromStroke(getStroke(livePoints, freehandOptions(penWidth))) : ''),
    [livePoints, penWidth],
  );
  // WebView2 does not paint content overflowing a tiny SVG root (even with
  // `overflow: visible`), so the ink SVG is sized to the stroke bounding box
  // and a group translate maps flow coordinates into it.
  const inkBounds = useMemo(() => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const grow = (points: number[][]) => {
      for (const [x, y] of points) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    };
    for (const stroke of ink) grow(stroke.points);
    if (livePoints && livePoints.length > 0) grow(livePoints);
    if (!Number.isFinite(minX)) return null;
    const padding = 60;
    return {
      x: Math.floor(minX - padding),
      y: Math.floor(minY - padding),
      w: Math.ceil(maxX - minX + padding * 2),
      h: Math.ceil(maxY - minY + padding * 2),
    };
  }, [ink, livePoints]);

  if (state.status !== 'ready') {
    return reportPresentation
      ? null
      : <div className="flex h-full w-full items-center justify-center text-sm text-[var(--muted-foreground)]">
          {state.status === 'error' ? state.message : t('canvas.loading')}
        </div>;
  }

  const toolButtonClass = (active: boolean) =>
    `flex h-7 w-7 items-center justify-center rounded-md ${active ? 'bg-[var(--foreground)] text-[var(--background)]' : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)]'}`;

  return (
    <div
      className={`h-full min-h-0 w-full ${tool !== 'select' ? 'cursor-crosshair' : ''}`}
      data-canvas-surface={filePath}
      // The board owns pan/zoom gestures; the shell's swipe-down must not steal them.
      data-mobile-swipe-ignore="true"
      onPointerDown={handleBoardPointerDown}
      onPointerMove={handleBoardPointerMove}
      onPointerUp={handleBoardPointerUp}
      onPointerCancel={handleBoardPointerUp}
    >
      <div data-board-toolbar className="absolute left-3 top-3 z-30 flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--card)] p-1 shadow-sm">
        <button type="button" aria-label={t('canvas.board.tool.select')} className={toolButtonClass(tool === 'select')} onClick={() => setTool('select')}>
          <MousePointer2 className="h-3.5 w-3.5" />
        </button>
        <button type="button" aria-label={t('canvas.board.tool.pen')} className={toolButtonClass(tool === 'pen')} onClick={() => setTool('pen')}>
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button type="button" aria-label={t('canvas.board.tool.eraser')} className={toolButtonClass(tool === 'eraser')} onClick={() => setTool('eraser')}>
          <Eraser className="h-3.5 w-3.5" />
        </button>
        {tool === 'pen' ? (
          <>
            <div className="mx-1 h-5 w-px bg-[var(--border)]" />
            {INK_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={`${t('canvas.board.tool.pen')} ${color}`}
                onClick={() => setPenColor(color)}
                className={`h-5 w-5 rounded-full border ${penColor === color ? 'border-[var(--foreground)] ring-2 ring-[var(--foreground)]/30' : 'border-transparent'}`}
                style={{ backgroundColor: color }}
              />
            ))}
            <div className="mx-1 h-5 w-px bg-[var(--border)]" />
            {INK_WIDTHS.map((width) => (
              <button
                key={width}
                type="button"
                aria-label={`${t('canvas.board.tool.pen')} ${width}`}
                onClick={() => setPenWidth(width)}
                className={toolButtonClass(penWidth === width)}
              >
                <span className="block rounded-full bg-current" style={{ width: width + 3, height: width + 3 }} />
              </button>
            ))}
          </>
        ) : null}
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={handleNodesChange}
        onNodeDragStop={handleNodeDragStop}
        onMoveEnd={handleMoveEnd}
        onNodeDoubleClick={handleNodeDoubleClick}
        defaultViewport={defaultViewport}
        fitView={!initialViewport}
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.05}
        maxZoom={4}
        panOnDrag={tool === 'select'}
        nodesDraggable={!readOnly && tool === 'select'}
        nodesConnectable={false}
        elementsSelectable={tool === 'select'}
        onlyRenderVisibleElements
        deleteKeyCode={null}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <ViewportPortal>
          {inkBounds ? (
            <svg
              style={{
                position: 'absolute',
                left: inkBounds.x,
                top: inkBounds.y,
                zIndex: INK_Z_INDEX,
                width: inkBounds.w,
                height: inkBounds.h,
                pointerEvents: 'none',
              }}
            >
              <g transform={`translate(${-inkBounds.x},${-inkBounds.y})`}>
                {ink.map((stroke, index) => (
                  <path key={stroke.id} d={inkPaths[index] ?? ''} fill={stroke.color} />
                ))}
                {livePath ? <path d={livePath} fill={penColor} /> : null}
              </g>
            </svg>
          ) : null}
        </ViewportPortal>
      </ReactFlow>
    </div>
  );
}
