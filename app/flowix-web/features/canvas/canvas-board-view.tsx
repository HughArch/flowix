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
  Handle,
  Position,
  ReactFlow,
  NodeResizer,
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
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter, AlignStartHorizontal, AlignStartVertical, AlignVerticalDistributeCenter, ArrowUpRight, Circle, Diamond, Download, Eraser, Hand, FileText, Frame as FrameIcon, Image as ImageIcon, Lock, LockOpen, Maximize2, MousePointer2, Pencil, Redo2, Square, Type, Undo2 } from 'lucide-react';
import { dialogs, files, notebookAssets, notes as notesClient } from '@platform/tauri/client';
import type { NoteCardSummary } from '@platform/tauri/client/notes';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { useNoteStore } from '@features/memo/store/note-store';
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
  readBoardShapes,
  readBoardViewport,
  readCanvasFileEntries,
  readPersistedAppState,
  serializeCanvasDocument,
  type BoardCard,
  type BoardInkStroke,
  type BoardShape,
  type BoardShapeKind,
  type FlowixCanvasDocument,
} from './model';
import { type CanvasSurfaceViewProps } from './surface-props';
import { boardToSvg, svgToPngBase64 } from './board-export';
import { cachedRoughPaths, roughLinePath } from './board-rough';
import { alignShapes, distributeShapes, type BoardAlignMode } from './board-align';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';

const SAVE_DEBOUNCE_MS = 800;
const logger = createLogger('canvas-board');
/** Retry cadence for image cards whose attachment had not synced on open. */
const IMAGE_RETRY_DELAYS_MS = [3_000, 8_000, 15_000];

interface BoardNodeData extends Record<string, unknown> {
  card: BoardCard;
  dataUrl: string | null;
  summary: NoteCardSummary | null;
  shape: BoardShape | null;
  onShapeTextCommit?: (shapeId: string, text: string) => void;
  onShapeResize?: (nodeId: string, box: { x: number; y: number; width: number; height: number }) => void;
  initialEditing?: boolean;
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

/**
 * Connection anchors. The target handle is always present (invisible) so a
 * dragged connector can land on any node; the source handle only appears on
 * the selected node, keeping the resting board clean.
 */
function CardHandles({ visible = false }: { visible?: boolean }) {
  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className={visible
          ? '!h-2.5 !w-2.5 !border-0 !bg-[var(--muted-foreground)]/60'
          : '!h-3 !w-3 !border-0 !bg-transparent'}
      />
      {visible ? (
        <Handle type="source" position={Position.Bottom} className="!h-2.5 !w-2.5 !border-0 !bg-[var(--muted-foreground)]/60" />
      ) : null}
    </>
  );
}

/** Compact relative timestamp for card footers. */
function relativeTime(ms: number): string {
  if (!ms) return '';
  const delta = Date.now() - ms;
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function NoteCardNode({ data, selected }: NodeProps<BoardNode>) {
  const { t } = useI18n();
  const { card, summary } = data;
  const tags = summary?.tags.slice(0, 2) ?? [];
  const extraTags = (summary?.tags.length ?? 0) - tags.length;
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--card)] shadow-sm">
      <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
        <FileText className="h-3 w-3 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
        <span className="truncate text-xs font-semibold text-[var(--foreground)]">
          {summary?.title || cardTitle(card)}
        </span>
      </div>
      {summary?.excerpt ? (
        <div className="flex-1 overflow-hidden px-2.5 py-1.5">
          <p className="whitespace-pre-wrap break-words text-[11px] leading-[1.6] text-[var(--muted-foreground)] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:5]">
            {summary.excerpt}
          </p>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-2.5 text-[11px] leading-relaxed text-[var(--muted-foreground)]">
          {t('canvas.board.emptyNote')}
        </div>
      )}
      <div className="flex items-center gap-1.5 px-2.5 pb-1.5 pt-0.5">
        {tags.map((tag) => (
          <span key={tag} className="truncate rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
            #{tag}
          </span>
        ))}
        {extraTags > 0 ? (
          <span className="text-[10px] text-[var(--muted-foreground)]">+{extraTags}</span>
        ) : null}
        {summary?.modifiedAt ? (
          <span className="ml-auto shrink-0 text-[10px] text-[var(--muted-foreground)]">{relativeTime(summary.modifiedAt)}</span>
        ) : null}
      </div>
      <CardHandles visible={selected} />
    </div>
  );
}

function StickyNode({ data, selected }: NodeProps<BoardNode>) {
  const { card } = data;
  return (
    <div className="h-full w-full overflow-hidden rounded-[10px] border border-amber-300/60 bg-amber-50 p-2 shadow-sm dark:border-amber-500/30 dark:bg-amber-950/40">
      <div className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--foreground)]">
        {card.text || ''}
      </div>
      <CardHandles visible={selected} />
    </div>
  );
}

function ImageCardNode({ data, selected }: NodeProps<BoardNode>) {
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
      <CardHandles visible={selected} />
    </div>
  );
}

function CanvasRefNode({ data, selected }: NodeProps<BoardNode>) {
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
      <CardHandles visible={selected} />
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

/** Rect/ellipse/diamond with an inline text label, resizable when selected. */
function ShapeNode({ data, selected }: NodeProps<BoardNode>) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(Boolean(data.initialEditing));
  const [draft, setDraft] = useState(data.shape?.text ?? '');
  const shape = data.shape;
  if (!shape) return null;
  const stroke = shape.stroke ?? '#64748b';
  const strokeWidth = shape.strokeWidth ?? 2;
  const fontSize = shape.fontSize ?? 16;
  const origin = shape.shape === 'arrow' ? arrowBox(shape) : { x: shape.x, y: shape.y };

  const sketch = shape.shape === 'text' ? null : (
    <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none' }}>
      <g transform={`translate(${-origin.x},${-origin.y})`}>
        {shape.shape === 'arrow' ? (
          (() => {
            const x2 = shape.x2 ?? shape.x + shape.w;
            const y2 = shape.y2 ?? shape.y + shape.h;
            const angle = Math.atan2(y2 - shape.y, x2 - shape.x);
            const head = 10 + strokeWidth * 2;
            const spread = Math.PI / 7;
            const h1 = [x2 - head * Math.cos(angle - spread), y2 - head * Math.sin(angle - spread)];
            const h2 = [x2 - head * Math.cos(angle + spread), y2 - head * Math.sin(angle + spread)];
            return (
              <>
                <path
                  d={roughLinePath(shape.x, shape.y, x2, y2, shape)}
                  stroke={stroke}
                  strokeWidth={strokeWidth}
                  strokeLinecap="round"
                  fill="none"
                />
                <polygon points={`${x2},${y2} ${h1[0]},${h1[1]} ${h2[0]},${h2[1]}`} fill={stroke} />
              </>
            );
          })()
        ) : cachedRoughPaths(shape).map((path, index) => (
          <path
            key={index}
            d={path.d}
            stroke={path.stroke}
            strokeWidth={path.strokeWidth}
            fill={path.fill ?? 'none'}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </g>
    </svg>
  );

  return (
    <div className="relative h-full w-full" style={{ opacity: (shape.opacity ?? 100) / 100 }}>
      <NodeResizer
        isVisible={selected && shape.shape !== 'arrow'}
        minWidth={40}
        minHeight={30}
        onResizeEnd={(_, params) => data.onShapeResize?.(shape.id, params)}
        lineClassName="!border-[var(--foreground)]/40"
        handleClassName="!bg-[var(--card)] !border-[var(--foreground)]/60"
      />
      {sketch}
      <div
        className="absolute inset-0 flex items-center justify-center px-2 text-center"
        onDoubleClick={(event) => {
          event.stopPropagation();
          setDraft(shape.text ?? '');
          setEditing(true);
        }}
      >
        {editing ? (
          <textarea
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => { setEditing(false); data.onShapeTextCommit?.(shape.id, draft); }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Escape') { setEditing(false); }
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); setEditing(false); data.onShapeTextCommit?.(shape.id, draft); }
            }}
            style={{ fontSize, color: shape.shape === 'text' ? stroke : undefined, fontFamily: HAND_FONT }}
            className="h-full w-full resize-none bg-transparent text-center leading-snug text-[var(--foreground)] outline-none"
          />
        ) : shape.text ? (
          <span
            className="pointer-events-none whitespace-pre-wrap break-words leading-snug"
            style={{ color: shape.shape === 'text' ? stroke : 'var(--foreground)', fontSize, fontFamily: HAND_FONT }}
          >
            {shape.text}
          </span>
        ) : selected ? (
          <span className="pointer-events-none text-[10px] text-[var(--muted-foreground)]">{t('canvas.board.shape.labelHint')}</span>
        ) : null}
      </div>
      <CardHandles visible={selected} />
    </div>
  );
}

const NODE_TYPES = {
  note: NoteCardNode,
  sticky: StickyNode,
  image: ImageCardNode,
  canvasref: CanvasRefNode,
  frame: FrameNode,
  shape: ShapeNode,
};

type BoardTool = 'select' | 'hand' | 'pen' | 'eraser' | BoardShapeKind;
/** Handwriting stack: CJK brushes first, then Latin sketch fonts. */
const HAND_FONT = "'Xiaolai SC','Kaiti SC',KaiTi,STKaiti,'Segoe Print','Comic Sans MS',cursive";
const SHAPE_TOOLS: BoardShapeKind[] = ['rect', 'ellipse', 'diamond', 'text', 'arrow'];
const isShapeTool = (tool: BoardTool): tool is BoardShapeKind =>
  tool === 'rect' || tool === 'ellipse' || tool === 'diamond' || tool === 'text' || tool === 'arrow';

const INK_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#a855f7', '#64748b'];
/** Background tints for shapes, matching the stroke palette order. */
const FILL_COLORS = ['#fee2e2', '#fef3c7', '#d1fae5', '#dbeafe', '#f3e8ff', '#e2e8f0'];
const STROKE_WIDTHS = [1, 2, 4];
const STROKE_STYLES = ['solid', 'dashed', 'dotted'] as const;
const FONT_SIZES = [14, 20, 28, 36];
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

/** Node under a flow-space point, for arrow endpoint snapping. */
function nodeAtPoint(
  cards: BoardCard[],
  shapes: BoardShape[],
  x: number,
  y: number,
): { id: string } | null {
  for (const card of cards) {
    if (x >= card.x && x <= card.x + card.w && y >= card.y && y <= card.y + card.h) return card;
  }
  for (const shape of shapes) {
    if (shape.shape === 'arrow' || shape.shape === 'text') continue;
    if (x >= shape.x && x <= shape.x + shape.w && y >= shape.y && y <= shape.y + shape.h) return shape;
  }
  return null;
}

function normalizeRect(a: number[], b: number[]): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.min(a[0], b[0]),
    y: Math.min(a[1], b[1]),
    w: Math.abs(b[0] - a[0]),
    h: Math.abs(b[1] - a[1]),
  };
}

function shapeId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** One react-flow node for a shape; shared by graph rebuild and live creation. */
function shapeNodeFor(
  shape: BoardShape,
  onShapeTextCommit?: (shapeId: string, text: string) => void,
  onShapeResize?: (nodeId: string, box: { x: number; y: number; width: number; height: number }) => void,
  initialEditing = false,
): BoardNode {
  const arrow = shape.shape === 'arrow' && shape.x2 !== undefined && shape.y2 !== undefined;
  const box = arrow
    ? arrowBox(shape)
    : { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
  return {
    id: shape.id,
    type: 'shape',
    position: { x: box.x, y: box.y },
    zIndex: 5,
    data: {
      card: { id: shape.id, kind: 'text', x: box.x, y: box.y, w: box.w, h: box.h },
      dataUrl: null,
      summary: null,
      shape,
      ...(onShapeTextCommit ? { onShapeTextCommit } : {}),
      ...(onShapeResize ? { onShapeResize } : {}),
      ...(initialEditing ? { initialEditing } : {}),
    },
    style: { width: box.w, height: box.h },
  };
}

const ARROW_PADDING = 14;

/** Node box for an arrow: the endpoint bounding box plus padding for the head. */
function arrowBox(shape: BoardShape): { x: number; y: number; w: number; h: number } {
  const x2 = shape.x2 ?? shape.x + shape.w;
  const y2 = shape.y2 ?? shape.y + shape.h;
  const minX = Math.min(shape.x, x2);
  const minY = Math.min(shape.y, y2);
  const maxX = Math.max(shape.x, x2);
  const maxY = Math.max(shape.y, y2);
  return {
    x: minX - ARROW_PADDING,
    y: minY - ARROW_PADDING,
    w: maxX - minX + ARROW_PADDING * 2,
    h: maxY - minY + ARROW_PADDING * 2,
  };
}

function buildBoardGraph(
  document: FlowixCanvasDocument,
  dataUrls: ReadonlyMap<string, string>,
  summaries: ReadonlyMap<string, NoteCardSummary>,
  absolutePathOf: (card: BoardCard) => string | null,
  onShapeTextCommit?: (shapeId: string, text: string) => void,
  onShapeResize?: (nodeId: string, box: { x: number; y: number; width: number; height: number }) => void,
): { nodes: BoardNode[]; edges: Edge[] } {
  const nodes: BoardNode[] = [];
  for (const frame of readBoardFrames(document)) {
    nodes.push({
      id: frame.id,
      type: 'frame',
      position: { x: frame.x, y: frame.y },
      zIndex: 0,
      data: {
        card: { id: frame.id, kind: 'text', x: frame.x, y: frame.y, w: frame.w, h: frame.h, title: frame.title },
        dataUrl: null,
        summary: null,
        shape: null,
      },
      style: { width: frame.w, height: frame.h },
    });
  }
  for (const shape of readBoardShapes(document)) {
    nodes.push(shapeNodeFor(shape, onShapeTextCommit, onShapeResize));
  }
  for (const card of readBoardCards(document)) {
    const absolute = card.kind === 'note' ? absolutePathOf(card) : null;
    nodes.push({
      id: card.id,
      type: nodeKindForCard(card),
      position: { x: card.x, y: card.y },
      zIndex: 10,
      data: {
        card,
        dataUrl: card.fileId ? dataUrls.get(card.fileId) ?? null : null,
        summary: absolute ? summaries.get(absolute) ?? null : null,
        shape: null,
      },
      style: { width: card.w, height: card.h },
    });
  }
  const cardIds = new Set(nodes.filter((node) => node.zIndex === 10 || node.zIndex === 5).map((node) => node.id));
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
  const [shapePreview, setShapePreview] = useState<{ start: number[]; end: number[] } | null>(null);
  const [selectedShapeIds, setSelectedShapeIds] = useState<string[]>([]);
  const selectedIdsRef = useRef<string[]>([]);
  /** Linear undo stack of serialized documents; index points at the current one. */
  const historyRef = useRef<{ stack: string[]; index: number }>({ stack: [], index: -1 });
  const [historyDepth, setHistoryDepth] = useState({ index: -1, length: 0 });
  const [tool, setTool] = useState<BoardTool>('select');
  /** Excalidraw-style lock: keep the drawing tool active after each stroke. */
  const [toolLocked, setToolLocked] = useState(false);
  const [penColor, setPenColor] = useState(INK_COLORS[3]);
  const [penWidth, setPenWidth] = useState(INK_WIDTHS[1]);
  const documentRef = useRef<FlowixCanvasDocument | null>(null);
  const cardsRef = useRef<BoardCard[]>([]);
  const inkRef = useRef<BoardInkStroke[]>([]);
  const shapesRef = useRef<BoardShape[]>([]);
  const shapeDraftRef = useRef<{ start: number[]; current: number[] } | null>(null);
  const handleShapeResizeRef = useRef<(nodeId: string, box: { x: number; y: number; width: number; height: number }) => void>(() => {});
  /** Filled after `scheduleFlush` exists; card/shape callbacks may run earlier. */
  const scheduleFlushRef = useRef<() => void>(() => {});
  const pushHistoryRef = useRef<() => void>(() => {});
  const clipboardRef = useRef<{ cards: BoardCard[]; shapes: BoardShape[] } | null>(null);
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
  /** Absolute note path -> summary; fetched in one batch per board open. */
  const summariesRef = useRef<Map<string, NoteCardSummary>>(new Map());
  /** Notebook id -> root, so cards referencing another notebook still resolve. */
  const notebooksRef = useRef<Array<{ id: string; path: string }>>([]);

  const retryLoad = useCallback(() => setRetryToken((token) => token + 1), []);

  const absolutePathOf = useCallback((card: BoardCard): string | null => {
    if (!card.path) return null;
    const root = card.notebookId
      ? notebooksRef.current.find((notebook) => notebook.id === card.notebookId)?.path
      : notebooksRef.current[0]?.path;
    if (!root) return null;
    return `${root.replace(/[\\/]+$/, '')}/${card.path.replace(/^[\\/]+/, '')}`;
  }, []);

  const commitShapeText = useCallback((shapeId: string, text: string) => {
    const document = documentRef.current;
    if (!document) return;
    const shape = shapesRef.current.find((item) => item.id === shapeId);
    if (!shape) return;
    const next = text.trim();
    if ((shape.text ?? '') === next) return;
    shape.text = next || undefined;
    document.shapes = shapesRef.current;
    scheduleFlushRef.current();
    pushHistoryRef.current();
  }, []);

  const applyGraph = useCallback((document: FlowixCanvasDocument) => {
    const { nodes: nextNodes, edges: nextEdges } = buildBoardGraph(
      document,
      dataUrlsRef.current,
      summariesRef.current,
      absolutePathOf,
      commitShapeText,
      handleShapeResizeRef.current,
    );
    // Rebuilding the graph must not drop the user's selection: react-flow reads
    // `selected` off the node objects we hand it.
    const selected = selectedIdsRef.current;
    setNodes(selected.length === 0
      ? nextNodes
      : nextNodes.map((node) => (selected.includes(node.id) ? { ...node, selected: true } : node)));
    setEdges(nextEdges);
  }, [absolutePathOf, commitShapeText]);

  const snapshotDocument = useCallback((): string | null => {
    const document = documentRef.current;
    if (!document) return null;
    return serializeCanvasDocument(
      document,
      document.elements,
      readPersistedAppState(document),
      document.files,
      storageKeysRef.current,
      { touchUpdatedAt: false },
    ).text;
  }, []);

  /** Record the post-mutation document; forward entries are dropped. */
  const pushHistory = useCallback(() => {
    const text = snapshotDocument();
    if (!text) return;
    const history = historyRef.current;
    if (history.stack[history.index] === text) return;
    history.stack = [...history.stack.slice(0, history.index + 1), text].slice(-100);
    history.index = history.stack.length - 1;
    setHistoryDepth({ index: history.index, length: history.stack.length });
  }, [snapshotDocument]);

  const applySnapshot = useCallback((text: string) => {
    const document = parseCanvasDocument(text);
    documentRef.current = document;
    cardsRef.current = readBoardCards(document);
    shapesRef.current = readBoardShapes(document);
    inkRef.current = readBoardInk(document);
    setInk(inkRef.current);
    storageKeysRef.current = new Map(
      readCanvasFileEntries(document.files)
        .filter((entry) => entry.storageKey)
        .map((entry) => [entry.id, entry.storageKey as string]),
    );
    applyGraph(document);
    scheduleFlushRef.current();
  }, [applyGraph]);

  const undo = useCallback(() => {
    const history = historyRef.current;
    if (history.index <= 0) return;
    history.index -= 1;
    setHistoryDepth({ index: history.index, length: history.stack.length });
    applySnapshot(history.stack[history.index]);
  }, [applySnapshot]);

  const redo = useCallback(() => {
    const history = historyRef.current;
    if (history.index >= history.stack.length - 1) return;
    history.index += 1;
    setHistoryDepth({ index: history.index, length: history.stack.length });
    applySnapshot(history.stack[history.index]);
  }, [applySnapshot]);

  /** Load every note-card summary in one IPC round-trip. */
  const loadCardSummaries = useCallback(async (document: FlowixCanvasDocument): Promise<boolean> => {
    const paths = readBoardCards(document)
      .filter((card) => card.kind === 'note')
      .map((card) => absolutePathOf(card))
      .filter((path): path is string => Boolean(path));
    if (paths.length === 0) return false;
    const summaries = await notesClient.readCardSummaries([...new Set(paths)]).catch(() => []);
    if (summaries.length === 0) return false;
    for (const summary of summaries) summariesRef.current.set(summary.filePath, summary);
    return true;
  }, [absolutePathOf]);

  const notebooks = useNoteStore((state) => state.notebooks);
  useEffect(() => {
    notebooksRef.current = notebooks.map((notebook) => ({ id: notebook.id, path: notebook.path }));
  }, [notebooks]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    documentRef.current = null;
    cardsRef.current = [];
    inkRef.current = [];
    shapesRef.current = [];
    shapeDraftRef.current = null;
    setShapePreview(null);
    liveStrokeRef.current = null;
    setTool('select');
    setLivePoints(null);
    dataUrlsRef.current = new Map();
    summariesRef.current = new Map();
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
      shapesRef.current = readBoardShapes(document);
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
      historyRef.current = { stack: [snapshotDocument() ?? ''], index: 0 };
      setHistoryDepth({ index: 0, length: 1 });
      setState({ status: 'ready' });
      // Card bodies arrive after the board paints; the graph rebuilds with them.
      const loaded = await loadCardSummaries(document);
      if (!cancelled && loaded) applyGraph(document);
    })().catch((error) => {
      if (!cancelled) setState({ status: 'error', message: error instanceof CanvasParseError ? error.message : error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [applyGraph, filePath, loadCardSummaries, notebookPath, retryToken, t]);

  // Notebook roots can arrive after the board paints; resolve card paths again
  // once they are known so summaries are not silently missing.
  useEffect(() => {
    if (state.status !== 'ready') return;
    const document = documentRef.current;
    if (!document) return;
    let cancelled = false;
    void loadCardSummaries(document).then((loaded) => {
      if (!cancelled && loaded) applyGraph(document);
    });
    return () => { cancelled = true; };
  }, [applyGraph, loadCardSummaries, notebooks, state.status]);

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

  useEffect(() => {
    scheduleFlushRef.current = scheduleFlush;
    pushHistoryRef.current = pushHistory;
  }, [pushHistory, scheduleFlush]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (imageRetryRef.current !== null) window.clearTimeout(imageRetryRef.current);
  }, []);

  const handleNodesChange: OnNodesChange<BoardNode> = useCallback((changes: NodeChange<BoardNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const handleSelectionChange = useCallback(({ nodes: selected }: { nodes: BoardNode[] }) => {
    const ids = selected.map((node) => node.id);
    selectedIdsRef.current = ids;
    setSelectedShapeIds(selected.filter((node) => node.type === 'shape').map((node) => node.id));
  }, []);

  /** Apply a style patch to every selected shape (Excalidraw-style panel).
   * `record: false` skips the undo entry so a slider can stream changes and
   * record once when the gesture ends. */
  const patchSelectedShapes = useCallback((patch: Partial<BoardShape>, record = true) => {
    const document = documentRef.current;
    if (!document || selectedShapeIds.length === 0) return;
    const ids = new Set(selectedShapeIds);
    for (const shape of shapesRef.current) {
      if (ids.has(shape.id)) Object.assign(shape, patch);
    }
    document.shapes = shapesRef.current;
    applyGraph(document);
    scheduleFlush();
    if (record) pushHistory();
  }, [applyGraph, pushHistory, scheduleFlush, selectedShapeIds]);

  /** Align selected shapes inside their common bounding box. */
  const alignSelectedShapes = useCallback((mode: BoardAlignMode) => {
    const document = documentRef.current;
    if (!document || selectedShapeIds.length < 2) return;
    const ids = new Set(selectedShapeIds);
    const shapes = shapesRef.current.filter((shape) => ids.has(shape.id));
    alignShapes(shapes, mode);
    document.shapes = shapesRef.current;
    applyGraph(document);
    scheduleFlush();
    pushHistory();
  }, [applyGraph, pushHistory, scheduleFlush, selectedShapeIds]);

  /** Even spacing between the outermost selected shapes on one axis. */
  const distributeSelectedShapes = useCallback((axis: 'h' | 'v') => {
    const document = documentRef.current;
    if (!document || selectedShapeIds.length < 3) return;
    const ids = new Set(selectedShapeIds);
    const shapes = shapesRef.current.filter((shape) => ids.has(shape.id));
    distributeShapes(shapes, axis);
    document.shapes = shapesRef.current;
    applyGraph(document);
    scheduleFlush();
    pushHistory();
  }, [applyGraph, pushHistory, scheduleFlush, selectedShapeIds]);
  const syncPositionsToDocument = useCallback((dragged: BoardNode[]) => {
    const document = documentRef.current;
    if (!document) return;
    let cardsChanged = false;
    let shapesChanged = false;
    for (const node of dragged) {
      const card = cardsRef.current.find((item) => item.id === node.id);
      if (card && (card.x !== node.position.x || card.y !== node.position.y)) {
        card.x = node.position.x;
        card.y = node.position.y;
        cardsChanged = true;
      }
      const shape = shapesRef.current.find((item) => item.id === node.id);
      if (shape && (shape.x !== node.position.x || shape.y !== node.position.y)) {
        shape.x = node.position.x;
        shape.y = node.position.y;
        shapesChanged = true;
      }
    }
    if (!cardsChanged && !shapesChanged) return;
    // First real edit swaps the passthrough arrays for normalized values.
    if (cardsChanged) document.cards = cardsRef.current;
    if (shapesChanged) document.shapes = shapesRef.current;
    scheduleFlush();
    pushHistory();
  }, [scheduleFlush]);

  /** Resize handles write the new box straight back into the document. */
  const handleShapeResize = useCallback((nodeId: string, box: { x: number; y: number; width: number; height: number }) => {
    const document = documentRef.current;
    if (!document) return;
    const shape = shapesRef.current.find((item) => item.id === nodeId);
    if (!shape) return;
    if (shape.x === box.x && shape.y === box.y && shape.w === box.width && shape.h === box.height) return;
    shape.x = box.x;
    shape.y = box.y;
    shape.w = box.width;
    shape.h = box.height;
    document.shapes = shapesRef.current;
    scheduleFlush();
    pushHistory();
  }, [pushHistory, scheduleFlush]);

  // No dependency array: the callback runs after the handler's declaration is
  // initialized, so it can be assigned without a TDZ read during render.
  useEffect(() => {
    handleShapeResizeRef.current = handleShapeResize;
  });

  /** Drag a handle between two nodes to add a connector. */
  const handleConnect = useCallback((connection: { source: string | null; target: string | null }) => {
    const document = documentRef.current;
    if (!document || !connection.source || !connection.target) return;
    if (connection.source === connection.target) return;
    const edges = readBoardEdges(document);
    if (edges.some((edge) => edge.from === connection.source && edge.to === connection.target)) return;
    document.edges = [...edges, {
      id: `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      from: connection.source,
      to: connection.target,
    }];
    applyGraph(document);
    scheduleFlush();
    pushHistory();
  }, [applyGraph, pushHistory, scheduleFlush]);

  /** Selection clipboard; paste clones with fresh ids and a small offset. */
  const copySelection = useCallback(() => {
    const ids = new Set(selectedIdsRef.current);
    if (ids.size === 0) return;
    clipboardRef.current = {
      cards: cardsRef.current.filter((card) => ids.has(card.id)).map((card) => ({ ...card })),
      shapes: shapesRef.current.filter((shape) => ids.has(shape.id)).map((shape) => ({ ...shape })),
    };
  }, []);

  const pasteClipboard = useCallback(() => {
    const clipboard = clipboardRef.current;
    const document = documentRef.current;
    if (!clipboard || !document) return;
    if (clipboard.cards.length === 0 && clipboard.shapes.length === 0) return;
    const offset = 28;
    const newIds: string[] = [];
    const nextCards = [...cardsRef.current, ...clipboard.cards.map((card) => {
      const clone = { ...card, id: `${card.id.split('_')[0]}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, x: card.x + offset, y: card.y + offset };
      newIds.push(clone.id);
      return clone;
    })];
    const nextShapes = [...shapesRef.current, ...clipboard.shapes.map((shape) => {
      const id = shapeId();
      newIds.push(id);
      return {
        ...shape,
        id,
        x: shape.x + offset,
        y: shape.y + offset,
        ...(shape.x2 !== undefined ? { x2: shape.x2 + offset } : {}),
        ...(shape.y2 !== undefined ? { y2: shape.y2 + offset } : {}),
      };
    })];
    cardsRef.current = nextCards;
    shapesRef.current = nextShapes;
    document.cards = nextCards;
    document.shapes = nextShapes;
    selectedIdsRef.current = newIds;
    setSelectedShapeIds(nextShapes.filter((shape) => newIds.includes(shape.id)).map((shape) => shape.id));
    applyGraph(document);
    scheduleFlush();
    pushHistory();
  }, [applyGraph, pushHistory, scheduleFlush]);

  const duplicateSelection = useCallback(() => {
    copySelection();
    pasteClipboard();
  }, [copySelection, pasteClipboard]);

  /** Double-click on empty canvas drops a text element and starts editing. */
  const handleSurfaceDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (readOnly || tool !== 'select') return;
    if ((event.target as Element).closest('.react-flow__node, [data-board-toolbar]')) return;
    const document = documentRef.current;
    if (!document) return;
    const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const shape: BoardShape = {
      id: shapeId(),
      shape: 'text',
      x: position.x,
      y: position.y - 12,
      w: 240,
      h: 40,
      stroke: penColor,
      fontSize: 20,
      text: '',
    };
    shapesRef.current = [...shapesRef.current, shape];
    document.shapes = shapesRef.current;
    setNodes((current) => [...current, shapeNodeFor(shape, commitShapeText, handleShapeResizeRef.current, true)]);
    scheduleFlush();
    pushHistory();
  }, [commitShapeText, penColor, pushHistory, reactFlow, readOnly, scheduleFlush, tool]);

  /** Delete key on a selected card/shape edits the document, not just the view. */
  const handleNodesDelete = useCallback((deleted: BoardNode[]) => {
    const document = documentRef.current;
    if (!document || deleted.length === 0) return;
    const ids = new Set(deleted.map((node) => node.id));
    const nextShapes = shapesRef.current.filter((shape) => !ids.has(shape.id));
    const nextCards = cardsRef.current.filter((card) => !ids.has(card.id));
    const shapesChanged = nextShapes.length !== shapesRef.current.length;
    const cardsChanged = nextCards.length !== cardsRef.current.length;
    if (!shapesChanged && !cardsChanged) return;
    if (shapesChanged) {
      shapesRef.current = nextShapes;
      document.shapes = nextShapes;
    }
    if (cardsChanged) {
      cardsRef.current = nextCards;
      document.cards = nextCards;
    }
    selectedIdsRef.current = selectedIdsRef.current.filter((id) => !ids.has(id));
    scheduleFlush();
    pushHistory();
  }, [pushHistory, scheduleFlush]);

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
    pushHistory();
  }, [pushHistory, scheduleFlush]);

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
    if (isShapeTool(tool)) {
      const start = flowPositionOf(event);
      shapeDraftRef.current = { start, current: start };
      setShapePreview({ start, end: start });
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
    if (isShapeTool(tool) && shapeDraftRef.current) {
      const current = flowPositionOf(event);
      const { start } = shapeDraftRef.current;
      shapeDraftRef.current.current = current;
      setShapePreview({ start, end: current });
      return;
    }
    if (tool === 'eraser' && event.buttons % 2 === 1) eraseInkAt(flowPositionOf(event));
  }, [eraseInkAt, flowPositionOf, readOnly, tool]);

  const handleBoardPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const draft = shapeDraftRef.current;
    shapeDraftRef.current = null;
    setShapePreview(null);
    if (draft) {
      try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
      const rect = normalizeRect(draft.start, draft.current);
      const isLabel = tool === 'text';
      // A click without a drag still drops a default-sized shape; labels are
      // always click-placed and start in edit mode like Excalidraw text.
      const box = isLabel
        ? { x: draft.start[0], y: draft.start[1] - 12, w: 240, h: 40 }
        : rect.w < 24 || rect.h < 24
          ? { x: draft.start[0] - 80, y: draft.start[1] - 50, w: 160, h: 100 }
          : rect;
      const document = documentRef.current;
      if (!document) return;
      const isArrow = tool === 'arrow';
      if (isArrow) {
        const fromNode = nodeAtPoint(cardsRef.current, shapesRef.current, draft.start[0], draft.start[1]);
        const toNode = nodeAtPoint(cardsRef.current, shapesRef.current, draft.current[0], draft.current[1]);
        if (fromNode && toNode && fromNode.id !== toNode.id) {
          const edges = readBoardEdges(document);
          if (!edges.some((edge) => edge.from === fromNode.id && edge.to === toNode.id)) {
            document.edges = [...edges, {
              id: `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
              from: fromNode.id,
              to: toNode.id,
            }];
            applyGraph(document);
            scheduleFlush();
            pushHistory();
          }
          setTool('select');
          return;
        }
      }
      const arrowStart = draft.start;
      const arrowEnd = rect.w < 24 && rect.h < 24
        ? [draft.start[0] + 160, draft.start[1]]
        : draft.current;
      const shape: BoardShape = isArrow
        ? {
          id: shapeId(),
          shape: 'arrow',
          x: arrowStart[0],
          y: arrowStart[1],
          x2: arrowEnd[0],
          y2: arrowEnd[1],
          w: Math.abs(arrowEnd[0] - arrowStart[0]),
          h: Math.abs(arrowEnd[1] - arrowStart[1]),
          stroke: penColor,
        }
        : {
          id: shapeId(),
          shape: tool as BoardShapeKind,
          x: box.x,
          y: box.y,
          w: box.w,
          h: box.h,
          stroke: penColor,
          ...(isLabel ? { fontSize: 20, text: '' } : {}),
        };
      shapesRef.current = [...shapesRef.current, shape];
      document.shapes = shapesRef.current;
      setNodes((current) => [...current, shapeNodeFor(shape, commitShapeText, handleShapeResizeRef.current, isLabel)]);
      scheduleFlush();
      pushHistory();
      if (!toolLocked) setTool('select');
      return;
    }
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
  }, [applyGraph, commitShapeText, penColor, penWidth, pushHistory, scheduleFlush, syncInkToDocument, tool]);

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
        await loadCardSummaries(document);
        applyGraph(document);
      });
    });
  }, [applyGraph, filePath, loadCardSummaries, notebookPath, state.status]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z' && event.key.toLowerCase() !== 'y') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))) return;
      event.preventDefault();
      if (event.key.toLowerCase() === 'y' || event.shiftKey) redo();
      else undo();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [redo, undo]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))) return;
      const key = event.key.toLowerCase();
      if (key === 'c') { event.preventDefault(); copySelection(); return; }
      if (key === 'v') { event.preventDefault(); pasteClipboard(); return; }
      if (key === 'd') { event.preventDefault(); duplicateSelection(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [copySelection, duplicateSelection, pasteClipboard]);

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

  const handleExport = useCallback(async (format: 'svg' | 'png') => {
    const document = documentRef.current;
    if (!document) return;
    try {
      const stem = (filePath.split(/[\/]/).pop() ?? 'canvas').replace(/\.flowix-canvas$/i, '');
      const svg = boardToSvg(document, summariesRef.current, absolutePathOf);
      if (format === 'svg') {
        const target = await dialogs.saveFile(`${stem}.svg`, [{ name: 'SVG', extensions: ['svg'] }]);
        if (!target) return;
        if (!(await dialogs.writeExportFile(target, svg))) throw new Error('write failed');
      } else {
        const base64 = await svgToPngBase64(svg);
        const target = await dialogs.saveFile(`${stem}.png`, [{ name: 'PNG', extensions: ['png'] }]);
        if (!target) return;
        if (!(await dialogs.writeExportBytes(target, base64))) throw new Error('write failed');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('canvas.export.failed'));
    }
  }, [absolutePathOf, filePath, t]);

  const previewShape: BoardShape | null = (() => {
    if (!shapePreview || !isShapeTool(tool)) return null;
    const [sx, sy] = shapePreview.start;
    const [ex, ey] = shapePreview.end;
    const minX = Math.min(sx, ex);
    const minY = Math.min(sy, ey);
    return {
      id: 'preview',
      shape: tool,
      x: tool === 'arrow' ? sx : minX,
      y: tool === 'arrow' ? sy : minY,
      w: Math.abs(ex - sx),
      h: Math.abs(ey - sy),
      ...(tool === 'arrow' ? { x2: ex, y2: ey } : {}),
      stroke: penColor,
    };
  })();

  const selectedShapes = nodes
    .filter((node) => node.type === 'shape' && selectedShapeIds.includes(node.id))
    .map((node) => node.data.shape)
    .filter((shape): shape is BoardShape => Boolean(shape));
  const selectedShapeCount = selectedShapes.length;
  const firstSelected = selectedShapes[0] ?? null;
  const activeStroke = firstSelected?.stroke ?? '#64748b';
  const activeFill = firstSelected?.fill ?? 'transparent';
  const activeStrokeWidth = firstSelected?.strokeWidth ?? 2;
  const activeStrokeStyle = firstSelected?.strokeStyle ?? 'solid';
  const activeFontSize = firstSelected?.fontSize ?? 20;
  const activeOpacity = firstSelected?.opacity ?? 100;
  const allSelectedLabel = selectedShapeCount > 0 && selectedShapes.every((shape) => shape.shape === 'text');

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
      className={`h-full min-h-0 w-full ${tool === 'hand' ? 'cursor-grab' : tool !== 'select' ? 'cursor-crosshair' : ''}`}
      data-canvas-surface={filePath}
      // The board owns pan/zoom gestures; the shell's swipe-down must not steal them.
      data-mobile-swipe-ignore="true"
      onPointerDown={handleBoardPointerDown}
      onPointerMove={handleBoardPointerMove}
      onPointerUp={handleBoardPointerUp}
      onPointerCancel={handleBoardPointerUp}
      onDoubleClick={handleSurfaceDoubleClick}
    >
      <div data-board-toolbar className="absolute left-3 top-3 z-30 flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--card)] p-1 shadow-sm">
        <button type="button" aria-label={t('canvas.board.tool.select')} className={toolButtonClass(tool === 'select')} onClick={() => setTool('select')}>
          <MousePointer2 className="h-3.5 w-3.5" />
        </button>
        <button type="button" aria-label={t('canvas.board.tool.hand')} className={toolButtonClass(tool === 'hand')} onClick={() => setTool('hand')}>
          <Hand className="h-3.5 w-3.5" />
        </button>
        <button type="button" aria-label={t('canvas.board.tool.pen')} className={toolButtonClass(tool === 'pen')} onClick={() => setTool('pen')}>
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button type="button" aria-label={t('canvas.board.tool.eraser')} className={toolButtonClass(tool === 'eraser')} onClick={() => setTool('eraser')}>
          <Eraser className="h-3.5 w-3.5" />
        </button>
        {SHAPE_TOOLS.map((shapeKind) => (
          <button
            key={shapeKind}
            type="button"
            aria-label={t(`canvas.board.tool.${shapeKind}`)}
            className={toolButtonClass(tool === shapeKind)}
            onClick={() => setTool(shapeKind)}
          >
            {shapeKind === 'rect' ? <Square className="h-3.5 w-3.5" />
              : shapeKind === 'ellipse' ? <Circle className="h-3.5 w-3.5" />
                : shapeKind === 'diamond' ? <Diamond className="h-3.5 w-3.5" />
                  : shapeKind === 'arrow' ? <ArrowUpRight className="h-3.5 w-3.5" />
                    : <Type className="h-3.5 w-3.5" />}
          </button>
        ))}
        <div className="mx-1 h-5 w-px bg-[var(--border)]" />
        <button
          type="button"
          aria-label={t('canvas.board.tool.undo')}
          className={toolButtonClass(false)}
          disabled={historyDepth.index <= 0}
          onClick={undo}
        >
          <Undo2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label={t('canvas.board.tool.redo')}
          className={toolButtonClass(false)}
          disabled={historyDepth.index >= historyDepth.length - 1}
          onClick={redo}
        >
          <Redo2 className="h-3.5 w-3.5" />
        </button>
        <div className="mx-1 h-5 w-px bg-[var(--border)]" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={t('canvas.export.menu')} className={toolButtonClass(false)}>
              <Download className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[168px]">
            <DropdownMenuItem onClick={() => { void handleExport('svg'); }}>{t('canvas.export.svg')}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => { void handleExport('png'); }}>{t('canvas.export.png')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          aria-label={t('canvas.board.tool.fit')}
          className={toolButtonClass(false)}
          onClick={() => { void reactFlow.fitView({ padding: 0.2, maxZoom: 1.2 }); }}
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label={t('canvas.board.tool.lock')}
          aria-pressed={toolLocked}
          className={toolButtonClass(toolLocked)}
          onClick={() => setToolLocked((locked) => !locked)}
        >
          {toolLocked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
        </button>
        {tool === 'pen' || isShapeTool(tool) ? (
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
      {tool === 'select' && selectedShapeCount > 0 ? (
        <div
          data-board-toolbar
          className="absolute left-1/2 top-16 z-30 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--card)] p-1.5 shadow-sm"
        >
          {INK_COLORS.map((color) => (
            <button
              key={`stroke-${color}`}
              type="button"
              aria-label={t('canvas.board.style.stroke')}
              onClick={() => patchSelectedShapes({ stroke: color })}
              className={`h-5 w-5 rounded-full border ${activeStroke === color ? 'border-[var(--foreground)] ring-2 ring-[var(--foreground)]/30' : 'border-transparent'}`}
              style={{ backgroundColor: color }}
            />
          ))}
          <div className="mx-1 h-5 w-px bg-[var(--border)]" />
          <button
            type="button"
            aria-label={t('canvas.board.style.backgroundTransparent')}
            onClick={() => patchSelectedShapes({ fill: 'transparent' })}
            className={`h-5 w-5 rounded border ${activeFill === 'transparent' ? 'border-[var(--foreground)] ring-2 ring-[var(--foreground)]/30' : 'border-[var(--border)]'} bg-[var(--card)]`}
            style={{ backgroundImage: 'linear-gradient(135deg, transparent 45%, var(--muted-foreground) 45%, var(--muted-foreground) 55%, transparent 55%)' }}
          />
          {FILL_COLORS.map((color) => (
            <button
              key={`fill-${color}`}
              type="button"
              aria-label={t('canvas.board.style.background')}
              onClick={() => patchSelectedShapes({ fill: color })}
              className={`h-5 w-5 rounded border ${activeFill === color ? 'border-[var(--foreground)] ring-2 ring-[var(--foreground)]/30' : 'border-[var(--border)]'}`}
              style={{ backgroundColor: color }}
            />
          ))}
          <div className="mx-1 h-5 w-px bg-[var(--border)]" />
          {STROKE_WIDTHS.map((width) => (
            <button
              key={`width-${width}`}
              type="button"
              aria-label={t('canvas.board.style.strokeWidth')}
              onClick={() => patchSelectedShapes({ strokeWidth: width })}
              className={toolButtonClass(activeStrokeWidth === width)}
            >
              <span className="block rounded-full bg-current" style={{ width: width * 3 + 4, height: width * 3 + 4 }} />
            </button>
          ))}
          <div className="mx-1 h-5 w-px bg-[var(--border)]" />
          {STROKE_STYLES.map((style) => (
            <button
              key={`style-${style}`}
              type="button"
              aria-label={t(`canvas.board.style.${style}`)}
              onClick={() => patchSelectedShapes({ strokeStyle: style })}
              className={toolButtonClass(activeStrokeStyle === style)}
            >
              <span
                className="block w-4 border-t-2 border-current"
                style={{ borderTopStyle: style }}
              />
            </button>
          ))}
          {selectedShapeCount > 0 && allSelectedLabel ? (
            <>
              <div className="mx-1 h-5 w-px bg-[var(--border)]" />
              {FONT_SIZES.map((size) => (
                <button
                  key={`font-${size}`}
                  type="button"
                  aria-label={t('canvas.board.style.fontSize')}
                  onClick={() => patchSelectedShapes({ fontSize: size })}
                  className={toolButtonClass(activeFontSize === size)}
                >
                  <span style={{ fontSize: Math.max(9, size / 2.4) }}>A</span>
                </button>
              ))}
            </>
          ) : null}
          {selectedShapeCount >= 2 ? (
            <>
              <div className="mx-1 h-5 w-px bg-[var(--border)]" />
              {([
                ['left', AlignStartVertical], ['hcenter', AlignCenterVertical], ['right', AlignEndVertical],
                ['top', AlignStartHorizontal], ['vcenter', AlignCenterHorizontal], ['bottom', AlignEndHorizontal],
              ] as const).map(([mode, Icon]) => (
                <button
                  key={`align-${mode}`}
                  type="button"
                  aria-label={t(`canvas.board.align.${mode}`)}
                  className={toolButtonClass(false)}
                  onClick={() => alignSelectedShapes(mode)}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              ))}
              {selectedShapeCount >= 3 ? (
                <>
                  <button
                    type="button"
                    aria-label={t('canvas.board.distribute.h')}
                    className={toolButtonClass(false)}
                    onClick={() => distributeSelectedShapes('h')}
                  >
                    <AlignHorizontalDistributeCenter className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={t('canvas.board.distribute.v')}
                    className={toolButtonClass(false)}
                    onClick={() => distributeSelectedShapes('v')}
                  >
                    <AlignVerticalDistributeCenter className="h-3.5 w-3.5" />
                  </button>
                </>
              ) : null}
            </>
          ) : null}
          <div className="mx-1 h-5 w-px bg-[var(--border)]" />
          <input
            type="range"
            aria-label={t('canvas.board.style.opacity')}
            min={5}
            max={100}
            step={5}
            value={activeOpacity}
            onChange={(event) => patchSelectedShapes({ opacity: Number(event.target.value) }, false)}
            onPointerUp={() => pushHistory()}
            onKeyUp={() => pushHistory()}
            className="w-20 accent-[var(--foreground)]"
          />
          <span className="w-8 text-[10px] tabular-nums text-[var(--muted-foreground)]">{activeOpacity}%</span>
        </div>
      ) : null}
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
        // Selection tool rubber-bands a multi-select; the hand tool pans.
        panOnDrag={tool === 'hand'}
        selectionOnDrag={tool === 'select'}
        nodesDraggable={!readOnly && tool === 'select'}
        nodesConnectable={!readOnly && tool === 'select'}
        elementsSelectable={tool === 'select'}
        onConnect={handleConnect}
        onlyRenderVisibleElements
        deleteKeyCode={['Delete']}
        onNodesDelete={handleNodesDelete}
        onSelectionChange={handleSelectionChange}
      >
        {/* Plain whiteboard background: the board is a canvas, not a grid sheet. */}
        <ViewportPortal>
          {previewShape && previewShape.w + previewShape.h > 0 ? (
            <svg
              style={{
                position: 'absolute',
                left: Math.min(previewShape.x, previewShape.x2 ?? previewShape.x) - 16,
                top: Math.min(previewShape.y, previewShape.y2 ?? previewShape.y) - 16,
                width: Math.abs((previewShape.x2 ?? previewShape.x + previewShape.w) - previewShape.x) + 32,
                height: Math.abs((previewShape.y2 ?? previewShape.y + previewShape.h) - previewShape.y) + 32,
                zIndex: INK_Z_INDEX + 1,
                pointerEvents: 'none',
                overflow: 'visible',
              }}
            >
              <g transform={`translate(${-Math.min(previewShape.x, previewShape.x2 ?? previewShape.x) + 16},${-Math.min(previewShape.y, previewShape.y2 ?? previewShape.y) + 16})`}>
                {previewShape.shape === 'arrow' ? (
                  <path
                    d={roughLinePath(previewShape.x, previewShape.y, previewShape.x2 ?? previewShape.x, previewShape.y2 ?? previewShape.y, previewShape, { preview: true })}
                    stroke={penColor}
                    strokeWidth={2}
                    fill="none"
                    strokeLinecap="round"
                  />
                ) : cachedRoughPaths(previewShape, true).map((path, index) => (
                  <path key={index} d={path.d} stroke={path.stroke} strokeWidth={path.strokeWidth} fill="none" strokeLinecap="round" />
                ))}
              </g>
            </svg>
          ) : null}
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
