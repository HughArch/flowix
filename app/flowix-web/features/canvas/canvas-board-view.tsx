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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Handle,
  Position,
  ReactFlow,
  NodeResizer,
  ReactFlowProvider,
  useStore,
  ViewportPortal,
  applyNodeChanges,
  useReactFlow,
  MarkerType,
  type Edge,
  type EdgeMouseHandler,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type NodeProps,
  type OnNodesChange,
  type Viewport,
} from '@xyflow/react';
import { getStroke } from 'perfect-freehand';
import '@xyflow/react/dist/style.css';
import '../../styles/canvas-board.css';
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter, AlignStartHorizontal, AlignStartVertical, AlignVerticalDistributeCenter, ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpToLine, ArrowUpRight, ChevronUp, Circle, Copy, Diamond, Download, Eraser, Hand, ImagePlus, Link2, Loader2, Palette, FileText, Frame as FrameIcon, Image as ImageIcon, Lock, LockOpen, Maximize2, Minus, MoreHorizontal, MousePointer2, Pencil, Plus, Redo2, Save, Square, StickyNote, Trash2, Type, Undo2, Waves } from 'lucide-react';
import { Tooltip } from '@shared/ui/tooltip';
import { pushHandler, formatChord } from '@/lib/shortcuts';
import { claimCanvasSurface, getActiveCanvasSurface, releaseCanvasSurface, setActiveCanvasSurface } from './canvas-focus';
import { CANVAS_TOOL_SHORTCUTS } from './canvas-tool-shortcuts';
import { dialogs, files, notebookAssets, notes as notesClient } from '@platform/tauri/client';
import type { NoteCardSummary } from '@platform/tauri/client/notes';
import { formatSyncOutcomeSummary, syncNotebookNow } from '@features/document/public/sync-coordination';
import { resolveNotebookIdForPath } from '@features/document/use-cases/resolve-notebook-id-for-path';
import { parseMarkdownInWorker } from '@features/editor/markdown-parser';
import { renderNoteContentHtml, sliceNoteByHeading } from '@features/editor/read-only/render-note-content';
import { NoteCardContent } from './note-card-content';
import { NoteCardInsertDialog, type NoteCardSelection } from './note-card-insert-dialog';
import { registerDropTarget } from '@shared/drag-drop/drag-drop-coordinator';
import { isMarkdownNoteDragResource, type NotebookDragResource } from '@features/memo/public/drag-resource-api';
import { useIsMobileViewport } from '@features/shell/hooks/use-is-mobile-viewport';
import { toast } from '@/lib/toast';
import { canonicalPath, samePath } from '@/lib/path';
import { subscribeNotebookChanges } from '@platform/tauri/notebook-change-events';
import { useI18n } from '@/lib/i18n';
import { useNoteStore } from '@features/memo/store/note-store';
import { openNoteByNotebookPath } from '@features/memo/public/note-navigation-api';
import { subscribeExternalDocumentChanges } from '@features/document/store/external-document-watch';
import { getBuffer, subscribeDocumentBufferChanges } from '@features/document/store/buffer-registry';
import { createLogger } from '@/lib/logger';
import {
  CanvasParseError,
  dataUrlPayload,
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
  type BoardFontFamily,
  type BoardFrame,
  type BoardInkStroke,
  type BoardShape,
  type BoardShapeKind,
  type BoardStrokeStyle,
  type BoardTextAlign,
  type FlowixCanvasDocument,
} from './model';
import { type CanvasSurfaceViewProps } from './surface-props';
import {
  CanvasBoardContextMenu,
  type BoardContextMenuItem,
  type BoardContextMenuRequest,
  type CanvasBoardContextMenuHandle,
} from './canvas-board-context-menu';
import { boardToSvg, svgToPngBase64 } from './board-export';
import { cachedRoughPaths, roughLineSketch } from './board-rough';
import { alignShapes, distributeShapes, type BoardAlignMode } from './board-align';
import { shapeGrowBoxHeight, shapeLabelWidth } from './shape-label';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';

const SAVE_DEBOUNCE_MS = 800;
const logger = createLogger('canvas-board');
/** Retry cadence for image cards whose attachment had not synced on open. */
const IMAGE_RETRY_DELAYS_MS = [3_000, 8_000, 15_000];
/** Touch long-press duration and the movement slop that cancels it. The slop
 *  doubles as the coarse-pointer nodeDragThreshold, so a stationary press
 *  never starts a node drag — a drag that began before the menu opened would
 *  freeze mid-gesture once the board starts swallowing the gesture's moves. */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 8;

interface BoardNodeData extends Record<string, unknown> {
  card: BoardCard;
  dataUrl: string | null;
  summary: NoteCardSummary | null;
  /** Rendered read-only body for cards that opt out of the excerpt face. */
  contentHtml: string | null;
  shape: BoardShape | null;
  inkStroke: BoardInkStroke | null;
  onShapeTextCommit?: (shapeId: string, text: string) => void;
  /** Sticky-note text commit (kind: 'text' cards edit in place). */
  onCardTextCommit?: (cardId: string, text: string) => void;
  /** Frame label commit; frames are containers, not cards. */
  onFrameTitleCommit?: (frameId: string, title: string) => void;
  onFrameResize?: (nodeId: string, box: ResizeBoxRect, phase: ResizePhase) => void;
  onShapeResize?: (nodeId: string, box: ResizeBoxRect, phase: ResizePhase) => void;
  onCardResize?: (nodeId: string, box: ResizeBoxRect, phase: ResizePhase) => void;
  onInkResize?: (nodeId: string, box: ResizeBoxRect, phase: ResizePhase) => void;
  initialEditing?: boolean;
}

type BoardNode = Node<BoardNodeData>;

/** Resize box in flow coordinates, as reported by NodeResizer. */
type ResizeBoxRect = { x: number; y: number; width: number; height: number };
/** `live` fires on every drag frame (the node must redraw immediately),
 * `end` fires once on release (commit to the document + history), `grow`
 * fires from the label editor when text outgrows the shape (no rescale
 * base, no history — the text commit records the final geometry). */
type ResizePhase = 'live' | 'end' | 'grow';

/** Decoded pixel size of a data URL image. */
function imageSizeOf(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error('image decode failed'));
    image.src = dataUrl;
  });
}

/** True when the event lands inside an active text editor (sticky note, frame
 *  title, shape label). The canvas menu must not swallow right-click /
 *  long-press there — the native text menu (copy/paste/selection) applies. */
function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName);
}

function cardTitle(card: BoardCard): string {
  if (card.title) return card.title;
  if (card.path) {
    const leaf = card.path.split('/').pop() ?? card.path;
    return leaf.replace(/\.md$/i, '');
  }
  return card.id;
}

/** Content cache key: one note can back both a full card and section cards.
 *  Canonicalized so live-buffer paths and IPC paths share one key. */
function cardContentKey(absolutePath: string, heading?: string): string {
  const path = canonicalPath(absolutePath);
  return heading ? `${path}\n${heading}` : path;
}

/**
 * Connection anchors. The target handle is always present (invisible) so a
 * dragged connector can land on any node; the source handle only appears on
 * the selected node, keeping the resting board clean.
 */
/** Connection anchors on all four sides. Edge sides are chosen from geometry
 *  at graph-build time, so every node carries all eight handles (targets are
 *  invisible hit areas; sources show as dots on the selected node). Without
 *  persistent source handles, edges whose chosen side is not the default would
 *  lose their anchor when the node is deselected. */
const CONNECTION_SIDES = [
  ['top', Position.Top],
  ['right', Position.Right],
  ['bottom', Position.Bottom],
  ['left', Position.Left],
] as const;

function CardHandles({ visible = false }: { visible?: boolean }) {
  return (
    <>
      {CONNECTION_SIDES.map(([side, position]) => (
        <Handle
          key={`tgt-${side}`}
          id={`tgt-${side}`}
          type="target"
          position={position}
          // Drops snap to the nearest handle geometrically (`connectionRadius`),
          // so targets never need pointer events: this keeps them from eating
          // node drags near the edge midpoints.
          className="!pointer-events-none !h-3 !w-3 !border-0 !bg-transparent"
        />
      ))}
      {CONNECTION_SIDES.map(([side, position]) => (
        <Handle
          key={`src-${side}`}
          id={`src-${side}`}
          type="source"
          position={position}
          className={visible
            // The dot keeps its original look; the ::after pseudo (hit-tested
            // as part of the element) stretches the grab zone to ~34px so
            // starting a connection no longer needs pixel-perfect aim and a
            // finger has a real target. On nodes whose root clips
            // (sticky/image/note), the outer part of the zone is cut off and
            // the inner half works. z-20 puts the dot above the resizer's
            // edge lines (z-10), which otherwise win exactly at the midpoints
            // where the dots sit.
            ? '!z-20 !h-2.5 !w-2.5 !rounded-full !border !border-[var(--card)] !bg-[var(--muted-foreground)] after:absolute after:-inset-3 after:rounded-full after:content-[""]'
            : '!pointer-events-none !h-3 !w-3 !border-0 !bg-transparent'}
        />
      ))}
    </>
  );
}

/** Programmatic focus drops the caret at the first character; editing an
 *  existing label should resume where the text left off, so park the caret
 *  at the end (no-op for an empty editor). */
function focusTextEditorAtEnd(element: HTMLTextAreaElement | HTMLInputElement | null) {
  if (!element) return;
  element.focus();
  const end = element.value.length;
  element.setSelectionRange(end, end);
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
  const onResizeEnd = (_: unknown, params: { x: number; y: number; width: number; height: number }) =>
    data.onCardResize?.(card.id, params, 'end');
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Keep the reading position across live editor mirroring. */
  const scrollTopRef = useRef(0);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = scrollTopRef.current;
  }, [data.contentHtml]);
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--card)] shadow-sm">
      <ResizeBox visible={selected} onResizeEnd={onResizeEnd} />
      <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
        <FileText className="h-3 w-3 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
        <span className="truncate text-xs font-semibold text-[var(--foreground)]">
          {/* The card header is the note's title, not its first body line:
              `summary.title` is body-derived, so a note whose body starts
              with an H1 would otherwise repeat that H1 in the header. */}
          {cardTitle(card)}
        </span>
      </div>
      {data.contentHtml ? (
        <div
          ref={scrollRef}
          onScroll={(event) => { scrollTopRef.current = event.currentTarget.scrollTop; }}
          // Unselected cards let pointer/wheel gestures fall through to the
          // canvas; selecting a card turns the body into a scrollable reader
          // (and pins it so scrolling never drags or pans the board).
          className={`min-h-0 flex-1 overflow-y-auto ${selected ? 'nodrag nowheel touch-pan-y' : 'pointer-events-none'}`}
        >
          <NoteCardContent html={data.contentHtml} />
        </div>
      ) : summary?.excerpt ? (
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
      {/* Tags are note properties, not card chrome: the canvas card shows only
          the document, so the footer keeps the timestamp alone. */}
      {summary?.modifiedAt ? (
        <div className="flex items-center px-2.5 pb-1.5 pt-0.5">
          <span className="ml-auto shrink-0 text-[10px] text-[var(--muted-foreground)]">{relativeTime(summary.modifiedAt)}</span>
        </div>
      ) : null}
      <CardHandles visible={selected} />
    </div>
  );
}

function StickyNode({ data, selected }: NodeProps<BoardNode>) {
  const { t } = useI18n();
  const { card } = data;
  const [editing, setEditing] = useState(Boolean(data.initialEditing));
  const [draft, setDraft] = useState(card.text ?? '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const onResizeEnd = (_: unknown, params: { x: number; y: number; width: number; height: number }) =>
    data.onCardResize?.(card.id, params, 'end');
  const tint = STICKY_COLORS.find((entry) => entry.value === card.color) ?? STICKY_COLORS[0];
  /** Text tools (字号/字体/对齐/文字颜色) apply to the sticky body text. */
  const fontSize = card.fontSize ?? 12;
  const fontFamilyKey = card.fontFamily ?? 'sans';
  const fontStack = TEXT_FONTS[fontFamilyKey];
  const fontWeight = TEXT_FONT_WEIGHTS[fontFamilyKey];
  const textAlign = card.textAlign ?? 'left';
  const alignClass = textAlign === 'left' ? 'text-left' : textAlign === 'right' ? 'text-right' : 'text-center';
  const textColor = card.textColor ?? tint.foreground;
  const commit = () => {
    setEditing(false);
    data.onCardTextCommit?.(card.id, draft);
  };
  // React Flow refocuses the node wrapper in a microtask after the placing
  // drag, stealing the autofocus — reclaim on a macrotask so typing lands in
  // the note right away.
  useEffect(() => {
    if (!editing) return;
    const focusTimer = window.setTimeout(() => focusTextEditorAtEnd(textareaRef.current), 0);
    return () => window.clearTimeout(focusTimer);
  }, [editing]);
  return (
    <div
      className="relative flex h-full w-full flex-col overflow-hidden rounded-[10px] border p-2 shadow-sm"
      style={{ backgroundColor: tint.background, borderColor: tint.border }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        setDraft(card.text ?? '');
        setEditing(true);
      }}
    >
      <ResizeBox visible={selected} onResizeEnd={onResizeEnd} />
      {editing ? (
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            event.stopPropagation();
            // Esc finishes editing and keeps the text (unmounting a focused
            // element never fires blur, so commit here or the draft is lost).
            if (event.key === 'Escape') { commit(); return; }
            // Enter inserts a line break like Obsidian; Cmd/Ctrl+Enter commits.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); commit(); }
          }}
          placeholder={t('canvas.board.sticky.placeholder')}
          className={`nodrag nowheel h-full w-full resize-none bg-transparent leading-relaxed outline-none placeholder:opacity-50 ${alignClass}`}
          style={{ color: textColor, fontSize, fontFamily: fontStack, fontWeight }}
        />
      ) : card.text ? (
        <div className={`min-h-0 flex-1 whitespace-pre-wrap break-words leading-relaxed ${alignClass}`} style={{ color: textColor, fontSize, fontFamily: fontStack, fontWeight }}>
          {card.text}
        </div>
      ) : (
        <div className="text-[11px] leading-relaxed opacity-60">{t('canvas.board.sticky.placeholder')}</div>
      )}
      <CardHandles visible={selected} />
    </div>
  );
}

function ImageCardNode({ data, selected }: NodeProps<BoardNode>) {
  const onResizeEnd = (_: unknown, params: { x: number; y: number; width: number; height: number }) =>
    data.onCardResize?.(data.card.id, params, 'end');
  const { t } = useI18n();
  const { dataUrl } = data;
  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--muted)] shadow-sm">
      <ResizeBox visible={selected} onResizeEnd={onResizeEnd} />
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
  const onResizeEnd = (_: unknown, params: { x: number; y: number; width: number; height: number }) =>
    data.onCardResize?.(card.id, params, 'end');
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--card)] shadow-sm">
      <ResizeBox visible={selected} onResizeEnd={onResizeEnd} />
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

function FrameNode({ data, selected }: NodeProps<BoardNode>) {
  const { t } = useI18n();
  const { card } = data;
  const [editing, setEditing] = useState(Boolean(data.initialEditing));
  const [draft, setDraft] = useState(card.title ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const onResizeEnd = (_: unknown, params: { x: number; y: number; width: number; height: number }) =>
    data.onFrameResize?.(card.id, params, 'end');
  const commit = () => {
    setEditing(false);
    data.onFrameTitleCommit?.(card.id, draft.trim());
  };
  // Same reclaim as the sticky note: React Flow refocuses the node wrapper in
  // a microtask after the placing drag, so the title input needs a macrotask.
  useEffect(() => {
    if (!editing) return;
    const focusTimer = window.setTimeout(() => focusTextEditorAtEnd(inputRef.current), 0);
    return () => window.clearTimeout(focusTimer);
  }, [editing]);
  return (
    <div
      // The frame is a backdrop: it must never swallow clicks meant for the
      // cards inside it, so only the border/title band is interactive.
      className="pointer-events-none relative h-full w-full rounded-xl border-2 border-dashed bg-[var(--muted)]/20"
      style={{ borderColor: 'color-mix(in srgb, var(--muted-foreground) 45%, transparent)' }}
    >
      <ResizeBox visible={selected} onResizeEnd={onResizeEnd} />
      <div
        className="pointer-events-auto absolute -top-6 left-0 flex max-w-full items-center gap-1 whitespace-nowrap text-[11px] font-medium text-[var(--muted-foreground)]"
        onDoubleClick={(event) => {
          event.stopPropagation();
          setDraft(card.title ?? '');
          setEditing(true);
        }}
      >
        <FrameIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') { event.preventDefault(); commit(); }
              // Esc keeps the typed title (unmount skips blur, so commit here).
              if (event.key === 'Escape') commit();
            }}
            placeholder={t('canvas.board.frame.placeholder')}
            className="nodrag w-40 rounded border border-[var(--border)] bg-[var(--card)] px-1 py-0.5 text-[11px] text-[var(--foreground)] outline-none"
          />
        ) : (
          <span className="truncate">{card.title || t('canvas.board.frame.placeholder')}</span>
        )}
      </div>
    </div>
  );
}

/** Rect/ellipse/diamond with an inline text label, resizable when selected. */
function ShapeNode({ data, selected }: NodeProps<BoardNode>) {
  const [editing, setEditing] = useState(Boolean(data.initialEditing));
  const [draft, setDraft] = useState(data.shape?.text ?? '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const shape = data.shape;
  // Same reclaim as sticky/frame: React Flow refocuses the node wrapper in a
  // microtask, so autofocus loses to it after a placing drag or double-click.
  useEffect(() => {
    if (!editing) return;
    const focusTimer = window.setTimeout(() => focusTextEditorAtEnd(textareaRef.current), 0);
    return () => window.clearTimeout(focusTimer);
  }, [editing]);
  // Auto-fit while editing: the textarea is sized to its content (the flex
  // container keeps it vertically centered, so the caret starts in the middle
  // of the shape), and content that outgrows the box expands it around its
  // center through the 'grow' resize phase (per-shape factors and the
  // convergence slack live in shape-label.ts).
  useLayoutEffect(() => {
    if (!editing) return;
    const element = textareaRef.current;
    const current = data.shape;
    if (!element || !current) return;
    element.style.height = '0px';
    const contentH = element.scrollHeight;
    element.style.height = `${contentH}px`;
    const nextBoxH = shapeGrowBoxHeight(current.shape, current.h, contentH, SHAPE_PADDING);
    if (nextBoxH === null) return;
    const cy = current.y + current.h / 2;
    data.onShapeResize?.(current.id, {
      x: current.x - SHAPE_PADDING,
      y: cy - nextBoxH / 2,
      width: current.w + SHAPE_PADDING * 2,
      height: nextBoxH,
    }, 'grow');
  }, [editing, draft, data]);
  if (!shape) return null;
  const stroke = shape.stroke ?? '#64748b';
  const strokeWidth = shape.strokeWidth ?? 2;
  const fontSize = shape.fontSize ?? 16;
  const fontFamilyKey = shape.fontFamily ?? 'hand';
  const fontStack = TEXT_FONTS[fontFamilyKey];
  const fontWeight = shape.shape === 'text' ? TEXT_FONT_WEIGHTS[fontFamilyKey] : 400;
  const textAlign = shape.textAlign ?? 'center';
  const alignClass = textAlign === 'left' ? 'text-left' : textAlign === 'right' ? 'text-right' : 'text-center';
  // Node boxes are padded, so paths must be translated by the padded origin.
  const origin = shape.shape === 'arrow' || shape.shape === 'line' ? arrowBox(shape) : shapeBoxWithPadding(shape);
  // Double-click edits the label: closed shapes and text elements start from
  // empty too; arrows and lines only re-edit an existing label.
  const canEditLabel = Boolean(shape.text)
    || shape.shape === 'rect' || shape.shape === 'ellipse' || shape.shape === 'diamond'
    || shape.shape === 'text';
  // Ellipse/diamond labels wrap inside the inscribed rectangle so they never
  // cross the outline; everything else wraps at the node container.
  const labelWidth = shapeLabelWidth(shape);

  const sketch = shape.shape === 'text' ? null : (
    <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none' }}>
      <g transform={`translate(${-origin.x},${-origin.y})`}>
        {shape.shape === 'arrow' || shape.shape === 'line' ? (
          (() => {
            const x2 = shape.x2 ?? shape.x + shape.w;
            const y2 = shape.y2 ?? shape.y + shape.h;
            const sketch = roughLineSketch(shape.x, shape.y, x2, y2, shape);
            const line = (
              <path
                d={sketch.d}
                strokeDasharray={sketch.dash}
                stroke={stroke}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                fill="none"
              />
            );
            if (shape.shape === 'line') return line;
            const angle = Math.atan2(y2 - shape.y, x2 - shape.x);
            const head = 10 + strokeWidth * 2;
            const spread = Math.PI / 7;
            const h1 = [x2 - head * Math.cos(angle - spread), y2 - head * Math.sin(angle - spread)];
            const h2 = [x2 - head * Math.cos(angle + spread), y2 - head * Math.sin(angle + spread)];
            return (
              <>
                {line}
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
            strokeDasharray={path.strokeDash}
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
      <ResizeBox
        visible={selected && shape.shape !== 'arrow' && shape.shape !== 'line'}
        onResize={(_, params) => data.onShapeResize?.(shape.id, params, 'live')}
        onResizeEnd={(_, params) => data.onShapeResize?.(shape.id, params, 'end')}
      />
      {sketch}
      <div
        className={`absolute inset-0 flex items-center px-2 ${alignClass} ${textAlign === 'center' ? 'justify-center' : ''}`}
        onDoubleClick={(event) => {
          // On the bare pane a double-click is the global "drop a text
          // element" gesture; on a shape it edits the label instead.
          if (!canEditLabel) return;
          event.stopPropagation();
          setDraft(shape.text ?? '');
          setEditing(true);
        }}
      >
        {editing ? (
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => { setEditing(false); data.onShapeTextCommit?.(shape.id, draft); }}
            onKeyDown={(event) => {
              event.stopPropagation();
              // Esc keeps the typed text (unmounting a focused element never
              // fires blur, so commit here or the draft is lost).
              if (event.key === 'Escape') { data.onShapeTextCommit?.(shape.id, draft); setEditing(false); }
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); setEditing(false); data.onShapeTextCommit?.(shape.id, draft); }
            }}
            style={{
              fontSize,
              color: shape.shape === 'text' ? stroke : undefined,
              fontFamily: fontStack,
              fontWeight,
              ...(labelWidth ? { width: labelWidth } : {}),
            }}
            className={`${labelWidth ? 'mx-auto' : 'w-full'} resize-none overflow-hidden bg-transparent p-0 ${alignClass} leading-snug text-[var(--foreground)] outline-none`}
          />
        ) : shape.text ? (
          <span
            className={`pointer-events-none whitespace-pre-wrap break-words leading-snug ${alignClass} ${labelWidth ? 'mx-auto' : ''}`}
            style={{
              color: shape.shape === 'text' ? stroke : 'var(--foreground)',
              fontSize,
              fontFamily: fontStack,
              fontWeight,
              ...(labelWidth ? { width: labelWidth } : {}),
            }}
          >
            {shape.text}
          </span>
        ) : null}
      </div>
      <CardHandles visible={selected} />
    </div>
  );
}

function InkNode({ data, selected }: NodeProps<BoardNode>) {
  const stroke = data.inkStroke;
  if (!stroke) return null;
  const box = inkBox(stroke);
  const onResize = (_: unknown, params: ResizeBoxRect) => data.onInkResize?.(stroke.id, params, 'live');
  const onResizeEnd = (_: unknown, params: ResizeBoxRect) => data.onInkResize?.(stroke.id, params, 'end');
  return (
    <div
      className="relative h-full w-full"
      style={selected
        ? { outline: '1px solid color-mix(in srgb, var(--muted-foreground) 55%, transparent)' }
        : undefined}
    >
      <ResizeBox visible={selected} onResize={onResize} onResizeEnd={onResizeEnd} />
      <svg className="pointer-events-none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}>
        <g transform={`translate(${-box.x},${-box.y})`}>
          <path d={inkPathFor(stroke)} fill={stroke.color} />
        </g>
      </svg>
    </div>
  );
}

/** Obsidian-style resize controls shared by every resizable node type. */
function ResizeBox({ visible, onResize, onResizeEnd }: {
  visible: boolean;
  /** Fires on every drag frame; the node redraws its content immediately. */
  onResize?: (_: unknown, params: ResizeBoxRect) => void;
  onResizeEnd: (_: unknown, params: ResizeBoxRect) => void;
}) {
  return (
    <NodeResizer
      isVisible={visible}
      minWidth={40}
      minHeight={30}
      {...(onResize ? { onResize } : {})}
      onResizeEnd={onResizeEnd}
      // z-10 lifts the controls above the node's own content layers (the
      // absolute text div paints after them and otherwise steals half of each
      // handle), so the whole handle grabs instead of only the quadrant that
      // pokes outside the node box.
      lineClassName="!z-10 !border-[var(--muted-foreground)]/60"
      handleClassName="!z-10 !h-2.5 !w-2.5 !rounded-[3px] !bg-[var(--card)] !border !border-[var(--muted-foreground)] !shadow-sm"
    />
  );
}

const NODE_TYPES = {
  note: NoteCardNode,
  sticky: StickyNode,
  image: ImageCardNode,
  canvasref: CanvasRefNode,
  frame: FrameNode,
  shape: ShapeNode,
  ink: InkNode,
};

type BoardTool = 'select' | 'hand' | 'pen' | 'eraser' | 'sticky' | 'frame' | BoardShapeKind;
/** Handwriting stack: CJK brushes first, then Latin sketch fonts. */
/** Font faces for the text panel row, matching Obsidian's five slots. */
const TEXT_FONTS: Record<'hand' | 'sans' | 'mono' | 'bold' | 'serif', string> = {
  // Bundled Virgil with a CJK handwriting fallback (楷体).
  hand: "'Flowix Canvas Excalifont', 'Flowix Canvas Xiaolai', 'Xiaolai SC', 'Kaiti SC', KaiTi, STKaiti, 'Segoe Print', cursive",
  sans: "'Flowix Canvas Sans', system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "'Flowix Canvas Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  bold: "'Flowix Canvas Lilita', 'Flowix Canvas Sans', system-ui, -apple-system, sans-serif",
  serif: "Georgia, 'Times New Roman', 'Songti SC', 'SimSun', serif",
};
/** Extra weight for the bold slot. */
const TEXT_FONT_WEIGHTS: Record<'hand' | 'sans' | 'mono' | 'bold' | 'serif', number> = {
  hand: 400, sans: 400, mono: 400, bold: 800, serif: 400,
};
const SHAPE_TOOLS: BoardShapeKind[] = ['rect', 'ellipse', 'diamond', 'text', 'arrow', 'line'];
const isShapeTool = (tool: BoardTool): tool is BoardShapeKind =>
  tool === 'rect' || tool === 'ellipse' || tool === 'diamond' || tool === 'text' || tool === 'arrow' || tool === 'line';
/** Tools drawn by dragging a box: shapes plus sticky notes and frames. */
const isBoxTool = (tool: BoardTool): boolean => isShapeTool(tool) || tool === 'sticky' || tool === 'frame';

const INK_COLORS = ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00'];
/** Sticky-note tints, mirroring Obsidian's colour row (yellow / red / green / blue / purple).
 *  The default yellow is Obsidian's canvas card yellow (#ffdf6b). */
const STICKY_COLORS = [
  { value: 'yellow', background: '#ffdf6b', border: '#e3c24a', foreground: '#4a3b00' },
  { value: 'red', background: '#ffe3e3', border: '#f5c2c2', foreground: '#5c1a1a' },
  { value: 'green', background: '#d8f5dd', border: '#a9dcb4', foreground: '#14432a' },
  { value: 'blue', background: '#dceafd', border: '#b3cdf2', foreground: '#123a63' },
  { value: 'purple', background: '#ece1fb', border: '#cdb8ef', foreground: '#3a1f63' },
] as const;
type StickyColor = (typeof STICKY_COLORS)[number]['value'];
const DEFAULT_STICKY_SIZE = { w: 220, h: 180 };
const DEFAULT_FRAME_SIZE = { w: 480, h: 360 };
/** Background tints for shapes, matching the stroke palette order. */
const FILL_COLORS = ['#ffffff', '#ffe3e3', '#d3f9d8', '#d0ebff', '#fff3bf'];
const STROKE_WIDTHS = [1, 2, 4, 8, 16];
const STROKE_STYLES = ['solid', 'dashed', 'dotted'] as const;
const FILL_STYLES = ['hachure', 'solid', 'cross-hatch'] as const;
const ROUGHNESS_LEVELS = [0, 1, 2.5] as const;
const FONT_SIZES = [12, 16, 20, 28, 36];
const FONT_SIZE_LABELS = ['XS', 'S', 'M', 'L', 'XL'] as const;
const TEXT_ALIGNS = ['left', 'center', 'right'] as const;
const TEXT_FONT_KEYS = ['hand', 'sans', 'mono', 'bold', 'serif'] as const;
/** Menu labels for the font row (Obsidian lists the faces by name). */
const FONT_LABEL_KEYS: Record<(typeof TEXT_FONT_KEYS)[number], 'canvas.board.style.fontHand' | 'canvas.board.style.fontSans' | 'canvas.board.style.fontMono' | 'canvas.board.style.fontBold' | 'canvas.board.style.fontSerif'> = {
  hand: 'canvas.board.style.fontHand',
  sans: 'canvas.board.style.fontSans',
  mono: 'canvas.board.style.fontMono',
  bold: 'canvas.board.style.fontBold',
  serif: 'canvas.board.style.fontSerif',
};
const INK_WIDTHS = [2, 5, 10];
/** Ink renders above cards: annotation strokes cross card bodies like on a whiteboard. */
const INK_Z_INDEX = 20;
const INK_ERASE_PADDING = 8;

function freehandOptions(width: number, pressure = true) {
  return { size: width * 2, thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: pressure };
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
  return svgPathFromStroke(getStroke(stroke.points, freehandOptions(stroke.width, stroke.pressure ?? true)));
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

/** Bounding box of clipboard contents (cards, shapes incl. endpoints, ink),
 *  used to centre a paste that targets an explicit point. */
function clipboardBounds(clipboard: { cards: BoardCard[]; shapes: BoardShape[]; ink: BoardInkStroke[] }): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x: number, y: number, w: number, h: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };
  for (const card of clipboard.cards) grow(card.x, card.y, card.w, card.h);
  for (const shape of clipboard.shapes) {
    const x2 = shape.x2 ?? shape.x + shape.w;
    const y2 = shape.y2 ?? shape.y + shape.h;
    grow(Math.min(shape.x, x2), Math.min(shape.y, y2), Math.abs(x2 - shape.x), Math.abs(y2 - shape.y));
  }
  for (const stroke of clipboard.ink) {
    const box = inkBox(stroke);
    grow(box.x, box.y, box.w, box.h);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
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
  const twoPoint = (shape.shape === 'arrow' || shape.shape === 'line')
    && shape.x2 !== undefined && shape.y2 !== undefined;
  // Node boxes carry padding so the selection ring sits outside the drawing
  // (Obsidian-style) instead of overlapping the shape outline.
  const box = twoPoint
    ? arrowBox(shape)
    : shapeBoxWithPadding(shape);
  return {
    id: shape.id,
    type: 'shape',
    position: { x: box.x, y: box.y },
    zIndex: shape.z ?? 5,
    data: {
      card: { id: shape.id, kind: 'text', x: box.x, y: box.y, w: box.w, h: box.h },
      dataUrl: null,
      summary: null,
      contentHtml: null,
      shape,
      inkStroke: null,
      ...(onShapeTextCommit ? { onShapeTextCommit } : {}),
      ...(onShapeResize ? { onShapeResize } : {}),
      ...(initialEditing ? { initialEditing } : {}),
    },
    style: { width: box.w, height: box.h },
  };
}

const ARROW_PADDING = 14;
/** Selection ring padding around shapes; the node box is the shape plus this. */
const SHAPE_PADDING = 12;
/** Zoom bounds; mirrored by the ReactFlow min/max props. */
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 4;

/** Node box for a plain shape: the shape inflated by the selection padding. */
function shapeBoxWithPadding(shape: BoardShape): { x: number; y: number; w: number; h: number } {
  return {
    x: shape.x - SHAPE_PADDING,
    y: shape.y - SHAPE_PADDING,
    w: shape.w + SHAPE_PADDING * 2,
    h: shape.h + SHAPE_PADDING * 2,
  };
}

/** Geometry for a fresh text element whose caret lands on an anchor point.
 *  The editor sizes the textarea to one line and centers it in the node box
 *  (shape + ring padding), so centering the box on the point puts the caret
 *  on it vertically; horizontally the box shifts by alignment because the
 *  caret hugs the left edge, the center, or the right edge of the textarea
 *  (which sits `SHAPE_PADDING - px-2` = 4px inside the shape origin). */
function textShapeAt(point: number[], align: 'left' | 'center' | 'right'): { x: number; y: number; w: number; h: number } {
  const [px, py] = point;
  const w = 240;
  const h = 40;
  const inset = SHAPE_PADDING - 8;
  return {
    x: align === 'left' ? px + inset : align === 'right' ? px - w - inset : px - w / 2,
    y: py - h / 2,
    w,
    h,
  };
}

/** Bounding box of an ink stroke, padded for selection/hit area. */
function inkBox(stroke: BoardInkStroke): { x: number; y: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of stroke.points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 1, h: 1 };
  const padding = 16;
  return {
    x: Math.floor(minX - padding),
    y: Math.floor(minY - padding),
    w: Math.ceil(maxX - minX + padding * 2),
    h: Math.ceil(maxY - minY + padding * 2),
  };
}

/** One react-flow node for an ink stroke (selectable, layerable). */
function inkNodeFor(stroke: BoardInkStroke): BoardNode {
  const box = inkBox(stroke);
  return {
    id: stroke.id,
    type: 'ink',
    position: { x: box.x, y: box.y },
    zIndex: stroke.z ?? 20,
    data: {
      card: { id: stroke.id, kind: 'text', x: box.x, y: box.y, w: box.w, h: box.h },
      dataUrl: null,
      summary: null,
      contentHtml: null,
      shape: null,
      inkStroke: stroke,
    },
    style: { width: box.w, height: box.h },
  };
}

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
  contentHtml: ReadonlyMap<string, string>,
  absolutePathOf: (card: BoardCard) => string | null,
  callbacks: {
    onShapeTextCommit?: (shapeId: string, text: string) => void;
    onShapeResize?: (nodeId: string, box: { x: number; y: number; width: number; height: number }) => void;
    onCardResize?: (nodeId: string, box: { x: number; y: number; width: number; height: number }) => void;
    onCardTextCommit?: (cardId: string, text: string) => void;
    onFrameTitleCommit?: (frameId: string, title: string) => void;
    onFrameResize?: (nodeId: string, box: { x: number; y: number; width: number; height: number }) => void;
    onInkResize?: (nodeId: string, box: { x: number; y: number; width: number; height: number }) => void;
  },
): { nodes: BoardNode[]; edges: Edge[] } {
  const nodes: BoardNode[] = [];
  for (const frame of readBoardFrames(document)) {
    nodes.push({
      id: frame.id,
      type: 'frame',
      position: { x: frame.x, y: frame.y },
      zIndex: 0,
      // Frames sit under every other layer: a frame is a backdrop, not content.
      selectable: true,
      data: {
        card: { id: frame.id, kind: 'text', x: frame.x, y: frame.y, w: frame.w, h: frame.h, title: frame.title },
        dataUrl: null,
        summary: null,
        contentHtml: null,
        shape: null,
        inkStroke: null,
        ...(callbacks.onFrameTitleCommit ? { onFrameTitleCommit: callbacks.onFrameTitleCommit } : {}),
        ...(callbacks.onFrameResize ? { onFrameResize: callbacks.onFrameResize } : {}),
      },
      style: { width: frame.w, height: frame.h },
    });
  }
  for (const shape of readBoardShapes(document)) {
    nodes.push(shapeNodeFor(shape, callbacks.onShapeTextCommit, callbacks.onShapeResize));
  }
  for (const stroke of readBoardInk(document)) {
    const inkNode = inkNodeFor(stroke);
    nodes.push({ ...inkNode, data: { ...inkNode.data, onInkResize: callbacks.onInkResize } });
  }
  for (const card of readBoardCards(document)) {
    const absolute = card.kind === 'note' ? absolutePathOf(card) : null;
    nodes.push({
      id: card.id,
      type: nodeKindForCard(card),
      position: { x: card.x, y: card.y },
      zIndex: card.z ?? 10,
      data: {
        card,
        dataUrl: card.fileId ? dataUrls.get(card.fileId) ?? null : null,
        summary: absolute ? summaries.get(absolute) ?? null : null,
        contentHtml: absolute ? contentHtml.get(cardContentKey(absolute, card.heading)) ?? null : null,
        shape: null,
        inkStroke: null,
        ...(callbacks.onCardResize ? { onCardResize: callbacks.onCardResize } : {}),
        ...(callbacks.onCardTextCommit ? { onCardTextCommit: callbacks.onCardTextCommit } : {}),
      },
      style: { width: card.w, height: card.h },
    });
  }
  const cardIds = new Set(nodes.filter((node) => node.type !== 'frame' && node.type !== 'ink').map((node) => node.id));
  const boundsById = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const node of nodes) {
    const width = typeof node.style?.width === 'number' ? node.style.width : node.width;
    const height = typeof node.style?.height === 'number' ? node.style.height : node.height;
    if (typeof width === 'number' && typeof height === 'number') {
      boundsById.set(node.id, { x: node.position.x, y: node.position.y, w: width, h: height });
    }
  }
  const EDGE_COLOR = 'var(--muted-foreground)';
  const edges: Edge[] = [];
  for (const edge of readBoardEdges(document)) {
    if (!cardIds.has(edge.from) || !cardIds.has(edge.to)) continue;
    const fromBox = boundsById.get(edge.from);
    const toBox = boundsById.get(edge.to);
    const [fromSide, toSide] = fromBox && toBox
      ? connectionSides(fromBox, toBox)
      : ['bottom', 'top'] as const;
    edges.push({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      sourceHandle: `src-${fromSide}`,
      targetHandle: `tgt-${toSide}`,
      ...(edge.label ? { label: edge.label } : {}),
      // Solid, high-contrast stroke plus an arrow head: the old 55%-opacity
      // hairline read as a dashed line at normal zoom.
      style: { stroke: EDGE_COLOR, strokeWidth: 2, opacity: 0.85 },
      markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLOR, width: 18, height: 18 },
    });
  }
  return { nodes, edges };
}

/** Selected connectors use the brand colour so the delete affordance is
 *  visible at a glance. */
function markEdgeSelected(edge: Edge, selected: boolean): Edge {
  if (!selected) return edge;
  return {
    ...edge,
    selected: true,
    style: { ...edge.style, stroke: 'var(--brand)', strokeWidth: 2.5 },
    markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--brand)', width: 18, height: 18 },
  };
}

/** Pick the pair of node sides that face each other. */
function connectionSides(
  from: { x: number; y: number; w: number; h: number },
  to: { x: number; y: number; w: number; h: number },
): readonly ['top' | 'right' | 'bottom' | 'left', 'top' | 'right' | 'bottom' | 'left'] {
  const dx = (to.x + to.w / 2) - (from.x + from.w / 2);
  const dy = (to.y + to.h / 2) - (from.y + from.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
  return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
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

function PanelRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] leading-none text-[var(--muted-foreground)]">{label}</div>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
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

function BoardSurface({ filePath, notebookPath, readOnly = false, workspaceHost = 'main-third', onSurfaceLifecycleReady, reportPresentation }: CanvasBoardViewProps) {
  const { t } = useI18n();
  const reactFlow = useReactFlow();
  const isNarrowViewport = useIsMobileViewport();
  const boardRef = useRef<HTMLDivElement>(null);
  const zoom = useStore((state) => state.transform[2]);
  const [state, setState] = useState<BoardLoadState>({ status: 'loading' });
  const [retryToken, setRetryToken] = useState(0);
  const [nodes, setNodes] = useState<BoardNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [initialViewport, setInitialViewport] = useState<Viewport | null>(null);
  const [livePoints, setLivePoints] = useState<number[][] | null>(null);
  const [shapePreview, setShapePreview] = useState<{ start: number[]; end: number[] } | null>(null);
  const [selectedShapeIds, setSelectedShapeIds] = useState<string[]>([]);
  const [selectedInkIds, setSelectedInkIds] = useState<string[]>([]);
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([]);
  const selectedIdsRef = useRef<string[]>([]);
  /** Linear undo stack of serialized documents; index points at the current one. */
  const historyRef = useRef<{ stack: string[]; index: number }>({ stack: [], index: -1 });
  const [historyDepth, setHistoryDepth] = useState({ index: -1, length: 0 });
  const [tool, setTool] = useState<BoardTool>('select');
  /** Manual rubber-band for select-mode pane drags. React Flow's own user
   *  selection cannot coexist with two-finger pan/pinch on touch — its d3
   *  filter rejects the whole touch stream once panOnDrag is off — so the
   *  marquee and the two-finger pan/pinch are implemented by hand and RF's
   *  gesture props stay off in select mode. */
  const [marquee, setMarquee] = useState<{ start: number[]; end: number[] } | null>(null);
  /** Sticky defaults for the next sticky note (Obsidian keeps the last used). */
  const [stickyColor, setStickyColor] = useState<StickyColor>('yellow');
  const [stickyFontSize, setStickyFontSize] = useState(FONT_SIZES[2]);
  const [stickyFontFamily, setStickyFontFamily] = useState<BoardFontFamily>('sans');
  const [stickyTextAlign, setStickyTextAlign] = useState<BoardTextAlign>('left');
  const [stickyTextColor, setStickyTextColor] = useState(INK_COLORS[0]);
  /** Obsidian: the sticky font row keeps a hand shortcut plus an "A" menu. */
  const [stickyFontMenuOpen, setStickyFontMenuOpen] = useState(false);
  /** Node that should mount in text-edit mode (a freshly placed sticky/frame). */
  const pendingEditingRef = useRef<string | null>(null);
  /** Excalidraw-style lock: keep the drawing tool active after each stroke. */
  const [toolLocked, setToolLocked] = useState(false);
  const [penColor, setPenColor] = useState(INK_COLORS[0]);
  const [penWidth, setPenWidth] = useState(INK_WIDTHS[1]);
  /** Defaults for the next drawn shape (Excalidraw keeps these per-tool too). */
  const [toolFill, setToolFill] = useState('transparent');
  const [toolStrokeStyle, setToolStrokeStyle] = useState<BoardStrokeStyle>('solid');
  const [toolFontSize, setToolFontSize] = useState(20);
  const [toolFontFamily, setToolFontFamily] = useState<'hand' | 'sans' | 'mono' | 'bold' | 'serif'>('hand');
  /** Obsidian: the font row keeps a hand shortcut plus an "A" menu button. */
  const [fontMenuOpen, setFontMenuOpen] = useState(false);
  const [toolTextAlign, setToolTextAlign] = useState<'left' | 'center' | 'right'>('center');
  const [toolOpacity, setToolOpacity] = useState(100);
  const [toolPressure, setToolPressure] = useState(true);
  const [toolFillStyle, setToolFillStyle] = useState<'hachure' | 'solid' | 'cross-hatch'>('hachure');
  const [toolRoughness, setToolRoughness] = useState(1);
  const [toolEdges, setToolEdges] = useState<'sharp' | 'round'>('sharp');
  const [linkEditing, setLinkEditing] = useState(false);
  /** Obsidian: the properties dashboard can be collapsed via its menu button. */
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [insertDialogOpen, setInsertDialogOpen] = useState(false);
  /** Cascade successive inserts instead of stacking them on one point. */
  const insertCascadeRef = useRef(0);
  /** Connectors are not nodes: their selection is tracked separately so the
   *  Delete key and the toolbar button can remove them. */
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const selectedEdgeIdRef = useRef<string | null>(null);
  /** A panel-opening select must be a click on an element, never a drag. */
  const pressRef = useRef<{ x: number; y: number; onElement: boolean } | null>(null);
  const [linkDraft, setLinkDraft] = useState('');
  const documentRef = useRef<FlowixCanvasDocument | null>(null);
  const cardsRef = useRef<BoardCard[]>([]);
  const inkRef = useRef<BoardInkStroke[]>([]);
  const shapesRef = useRef<BoardShape[]>([]);
  const shapeDraftRef = useRef<{ start: number[]; current: number[] } | null>(null);
  /** Geometry captured at the start of a resize gesture (shapes / ink). */
  const resizeBaseRef = useRef<{
    id: string;
    kind: 'shape' | 'ink';
    x: number;
    y: number;
    w: number;
    h: number;
    fontSize?: number;
    points?: number[][];
  } | null>(null);
  const handleShapeResizeRef = useRef<(nodeId: string, box: ResizeBoxRect, phase?: ResizePhase) => void>(() => {});
  const applyGraphRef = useRef<(document: FlowixCanvasDocument) => void>(() => {});
  const handleCardResizeRef = useRef<(nodeId: string, box: ResizeBoxRect, phase?: ResizePhase) => void>(() => {});
  const handleFrameResizeRef = useRef<(nodeId: string, box: ResizeBoxRect, phase?: ResizePhase) => void>(() => {});
  const handleInkResizeRef = useRef<(nodeId: string, box: ResizeBoxRect, phase?: ResizePhase) => void>(() => {});
  /** Late-bound card/frame commits: `applyGraph` runs before they are defined. */
  const commitCardTextRef = useRef<(cardId: string, text: string) => void>(() => {});
  const commitFrameTitleRef = useRef<(frameId: string, title: string) => void>(() => {});
  /** Filled after `scheduleFlush` exists; card/shape callbacks may run earlier. */
  const scheduleFlushRef = useRef<() => void>(() => {});
  const pushHistoryRef = useRef<() => void>(() => {});
  const clipboardRef = useRef<{ cards: BoardCard[]; shapes: BoardShape[]; ink: BoardInkStroke[] } | null>(null);
  /** Ink geometry captured at drag start so a move translates the points. */
  const inkDragStartRef = useRef<Map<string, { boxX: number; boxY: number; points: number[][] }>>(new Map());
  const lastPointerTypeRef = useRef<string>('mouse');
  /** Set when a rubber-band drag ends: the click the browser synthesizes on
   *  the pane right after would clear the selection React Flow just received
   *  (d3's own click suppression never engages because its gesture filter
   *  rejected the press), so the capture-phase listener below swallows it. */
  const suppressPaneClickRef = useRef(false);
  /** Right-click / long-press menu: one shell instance serves all modes. */
  const contextMenuRef = useRef<CanvasBoardContextMenuHandle>(null);
  /** Pending touch long-press; fires the context menu unless the finger moves
   *  beyond the slop or the gesture ends first. */
  const longPressRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    nodeElement: Element | null;
    timer: number;
  } | null>(null);
  /** Pointer whose long-press already opened the menu: the rest of that
   *  gesture (moves, lift, synthesized click) is swallowed so the open menu
   *  is never dragged around or click-activated by the lifting finger. */
  const longPressFiredRef = useRef<number | null>(null);
  /** Android fires a synthetic `contextmenu` at the end of a long-press;
   *  swallow the one that immediately follows our own menu open. Auto-expires
   *  so a stale flag never eats the next real right-click. */
  const suppressNextContextMenuRef = useRef(false);
  /** Pointer handlers hold stable closures; this always points at the latest
   *  long-press fire (same late-binding pattern as applyGraphRef below). */
  const fireLongPressRef = useRef<() => void>(() => {});
  /** Coarse pointers get the long-press slop as nodeDragThreshold (see the
   *  LONG_PRESS_SLOP_PX comment); fine pointers keep React Flow's precise 1px. */
  const isCoarsePointer = useMemo(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches,
    [],
  );
  /** Active select-mode gesture: one pointer rubber-bands, two pan/pinch. */
  const marqueeRef = useRef<{
    pointers: Map<number, { x: number; y: number }>;
    mode: 'select' | 'pan';
    startFlow: number[];
    startScreen: { x: number; y: number };
    startMid: { x: number; y: number };
    startDist: number;
    startViewport: Viewport;
    additive: boolean;
  } | null>(null);
  /** True while a touch drag is moving a node — the panel stays hidden. */
  const touchDraggingRef = useRef(false);
  const liveStrokeRef = useRef<number[][] | null>(null);
  const dataUrlsRef = useRef<Map<string, string>>(new Map());
  const dirtyRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  /** Re-render mirror of `dirtyRef` driving the save button's unsaved dot. */
  const [saveDirty, setSaveDirty] = useState(false);
  /** True while the explicit save-and-sync run is in flight (button spinner). */
  const [saveBusy, setSaveBusy] = useState(false);
  const saveBusyRef = useRef(false);
  const lastSavedTextRef = useRef<string | null>(null);
  /** Canvas file id -> notebook-relative attachment key, for reference-safe serialization. */
  const storageKeysRef = useRef<Map<string, string>>(new Map());
  const imageRetryRef = useRef<number | null>(null);
  /** Viewport seen at load; the first move-end after a fitView mount is
   * programmatic and must not look like an edit (an open would rewrite the
   * file and re-sort the tree, the same trap the drawing surface hit). */
  const moveSeedRef = useRef<Viewport | null>(null);
  /** Absolute note path (+ section anchor) -> rendered read-only body HTML. */
  const contentHtmlRef = useRef<Map<string, string>>(new Map());
  /** Latest live editor buffer per note path; unsaved edits mirror onto cards. */
  const liveContentRef = useRef<Map<string, string>>(new Map());
  /** When the live buffer last changed, so a slow save cannot overwrite it. */
  const liveEditAtRef = useRef<Map<string, number>>(new Map());
  /** Per-path render generation, so out-of-order worker parses are dropped. */
  const liveRenderVersionRef = useRef<Map<string, number>>(new Map());
  /** Absolute note path -> summary; fetched in one batch per board open. */
  const summariesRef = useRef<Map<string, NoteCardSummary>>(new Map());
  /** Notebook id -> root, so cards referencing another notebook still resolve. */
  const notebooksRef = useRef<Array<{ id: string; name: string; path: string }>>([]);

  /** Drop a pending touch long-press (gesture ended, moved, or another press). */
  const cancelLongPress = useCallback(() => {
    const pending = longPressRef.current;
    if (pending) {
      window.clearTimeout(pending.timer);
      longPressRef.current = null;
    }
  }, []);

  /** Switching to a drawing tool drops the selection (Obsidian behaviour),
   * otherwise the panel keeps showing the previously selected element. */
  const selectTool = useCallback((next: BoardTool) => {
    setTool(next);
    if (next === 'select') return;
    // Clear the rendered selection too: the mirror is derived from node.selected.
    selectedIdsRef.current = [];
    setSelectedShapeIds([]);
    setSelectedInkIds([]);
    setNodes((current) => current.some((node) => node.selected)
      ? current.map((node) => (node.selected ? { ...node, selected: false } : node))
      : current);
  }, []);

  const retryLoad = useCallback(() => setRetryToken((token) => token + 1), []);

  /** Notebook ids are per-device: resolve a synced card through its name
   *  snapshot (or the only notebook, when that is unambiguous). */
  const resolveCardNotebook = useCallback((card: BoardCard) => {
    const byId = card.notebookId
      ? notebooksRef.current.find((notebook) => notebook.id === card.notebookId)
      : undefined;
    const byName = !byId && card.notebookName
      ? notebooksRef.current.find((notebook) => notebook.name === card.notebookName)
      : undefined;
    const single = !card.notebookId && !card.notebookName ? notebooksRef.current[0] : undefined;
    return byId ?? byName ?? single ?? null;
  }, []);

  const absolutePathOf = useCallback((card: BoardCard): string | null => {
    if (!card.path) return null;
    const root = resolveCardNotebook(card)?.path;
    if (!root) return null;
    // Always canonical (forward slashes): this string is both the IPC path and
    // the content-cache key, and live buffer paths are canonicalized too.
    return canonicalPath(`${root.replace(/[\\/]+$/, '')}/${card.path.replace(/^[\\/]+/, '')}`);
  }, [resolveCardNotebook]);

  /** Next free stacking slot: new elements land on top of everything. */
  const nextZ = useCallback(() => {
    let max = 0;
    for (const shape of shapesRef.current) max = Math.max(max, shape.z ?? 5);
    for (const card of cardsRef.current) max = Math.max(max, card.z ?? 10);
    for (const stroke of inkRef.current) max = Math.max(max, stroke.z ?? 20);
    return max + 1;
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
      contentHtmlRef.current,
      absolutePathOf,
      {
        onShapeTextCommit: commitShapeText,
        onShapeResize: handleShapeResizeRef.current,
        onCardResize: handleCardResizeRef.current,
        onCardTextCommit: (cardId, text) => commitCardTextRef.current(cardId, text),
        onFrameTitleCommit: (frameId, title) => commitFrameTitleRef.current(frameId, title),
        onFrameResize: handleFrameResizeRef.current,
        onInkResize: handleInkResizeRef.current,
      },
    );
    // Rebuilding the graph must not drop the user's selection: react-flow reads
    // `selected` off the node objects we hand it.
    const selected = selectedIdsRef.current;
    // A freshly placed sticky/frame mounts in text-edit mode (Obsidian drops
    // you straight into typing); the flag is consumed by this rebuild.
    const pendingEditing = pendingEditingRef.current;
    pendingEditingRef.current = null;
    const withEditing = pendingEditing
      ? nextNodes.map((node) => (node.id === pendingEditing
        ? { ...node, data: { ...node.data, initialEditing: true } }
        : node))
      : nextNodes;
    setNodes(selected.length === 0
      ? withEditing
      : withEditing.map((node) => (selected.includes(node.id) ? { ...node, selected: true } : node)));
    const selectedEdge = selectedEdgeIdRef.current;
    setEdges(selectedEdge
      ? nextEdges.map((edge) => (edge.id === selectedEdge ? markEdgeSelected(edge, true) : edge))
      : nextEdges);
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

  /**
   * Render inline bodies for cards that opt out of the excerpt face
   * (`renderScope: 'full' | 'section'`). Content is fetched in one batch,
   * parsed in the markdown worker, and cached per path+heading so viewport
   * remounts never re-render. One note can back several cards (full and
   * section faces), so requests are keyed by path+heading while the IPC is
   * deduplicated per path. A missing section heading falls back to the whole
   * note; unreadable notes keep their excerpt face.
   */
  const loadCardContents = useCallback(async (
    document: FlowixCanvasDocument,
    options: { force?: boolean; onlyPaths?: string[] } = {},
  ): Promise<boolean> => {
    const cards = readBoardCards(document).filter((card) => (
      card.kind === 'note' && (card.renderScope === 'full' || card.renderScope === 'section')
    ));
    if (cards.length === 0) return false;
    const requestsByPath = new Map<string, Array<string | undefined>>();
    for (const card of cards) {
      const absolute = absolutePathOf(card);
      if (!absolute) continue;
      if (options.onlyPaths && !options.onlyPaths.some((path) => samePath(path, absolute))) continue;
      const heading = card.renderScope === 'section' ? card.heading : undefined;
      const variants = requestsByPath.get(absolute) ?? [];
      if (!variants.some((existing) => existing === heading)) variants.push(heading);
      requestsByPath.set(absolute, variants);
    }
    if (requestsByPath.size === 0) return false;
    const results = await notesClient.readCardContents([...requestsByPath.keys()]).catch(() => []);
    if (results.length === 0) return false;
    let rendered = false;
    for (const result of results) {
      if (!result.content) continue;
      const variants = requestsByPath.get(result.filePath);
      if (!variants) continue;
      // A note open in an editor has a newer live buffer than its last save;
      // preferring the disk copy here would regress the card on every autosave.
      const resultPath = canonicalPath(result.filePath);
      const liveContent = liveContentRef.current.get(resultPath);
      const liveAt = liveEditAtRef.current.get(resultPath) ?? 0;
      const source = liveContent != null && liveAt > result.modifiedAt ? liveContent : result.content;
      const parsed = await parseMarkdownInWorker(source)
        .then((reply) => reply.document)
        .catch(() => null);
      if (!parsed) continue;
      for (const heading of variants) {
        const key = cardContentKey(result.filePath, heading);
        if (!options.force && contentHtmlRef.current.has(key)) continue;
        try {
          // A missing heading renders the whole note (product decision), so
          // the card self-heals when the anchor is renamed back.
          const sectionBlocks = heading ? sliceNoteByHeading(parsed, heading) : null;
          const body = sectionBlocks ? { type: 'doc' as const, content: sectionBlocks } : parsed;
          contentHtmlRef.current.set(key, renderNoteContentHtml(body, { notebookPath }));
          rendered = true;
        } catch (error) {
          logger.warn('canvas board note content render failed', { path: result.filePath, error: String(error) });
        }
      }
    }
    return rendered;
  }, [absolutePathOf, notebookPath]);

  /**
   * Re-render every card backed by the given note paths from the live editor
   * buffers. This is the "edit on the right, mirror on the canvas" path: the
   * buffer updates on every keystroke, so a short debounce keeps typing smooth
   * while the card still tracks the editor almost immediately.
   */
  const refreshLiveContents = useCallback(async (paths: string[]) => {
    const document = documentRef.current;
    if (!document || paths.length === 0) return;
    let changed = false;
    for (const path of paths) {
      const content = liveContentRef.current.get(path);
      if (content == null) continue;
      const headings = new Set<string | undefined>();
      for (const card of cardsRef.current) {
        if (card.kind !== 'note' || (card.renderScope !== 'full' && card.renderScope !== 'section')) continue;
        if (!samePath(absolutePathOf(card) ?? '', path)) continue;
        headings.add(card.renderScope === 'section' ? card.heading : undefined);
      }
      if (headings.size === 0) continue;
      const version = (liveRenderVersionRef.current.get(path) ?? 0) + 1;
      liveRenderVersionRef.current.set(path, version);
      const parsed = await parseMarkdownInWorker(content)
        .then((reply) => reply.document)
        .catch(() => null);
      if (!parsed || liveRenderVersionRef.current.get(path) !== version) continue;
      for (const heading of headings) {
        const sectionBlocks = heading ? sliceNoteByHeading(parsed, heading) : null;
        const body = sectionBlocks ? { type: 'doc' as const, content: sectionBlocks } : parsed;
        contentHtmlRef.current.set(cardContentKey(path, heading), renderNoteContentHtml(body, { notebookPath }));
        changed = true;
      }
    }
    if (changed) applyGraphRef.current(document);
  }, [absolutePathOf, notebookPath]);

  // Mirror live edits: any open editor (work column or the browser column's
  // isolated session) that targets a note on this board re-renders the card.
  useEffect(() => {
    if (state.status !== 'ready') return;
    let timer: number | null = null;
    const pending = new Set<string>();
    const flush = () => {
      timer = null;
      const paths = [...pending];
      pending.clear();
      if (paths.length > 0) void refreshLiveContents(paths);
    };
    const unsubscribe = subscribeDocumentBufferChanges((identity) => {
      const content = getBuffer(identity)?.content;
      if (content == null) return;
      const path = canonicalPath(identity.path);
      if (liveContentRef.current.get(path) === content) return;
      liveContentRef.current.set(path, content);
      liveEditAtRef.current.set(path, Date.now());
      // Cheap pre-check before scheduling: only notes on this board matter.
      if (!cardsRef.current.some((card) => (
        card.kind === 'note'
        && (card.renderScope === 'full' || card.renderScope === 'section')
        && samePath(absolutePathOf(card) ?? '', path)
      ))) return;
      pending.add(path);
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(flush, 250);
    });
    return () => {
      unsubscribe();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [absolutePathOf, refreshLiveContents, state.status]);

  // Disk/FNS changes to referenced notes (note closed): force one re-read per
  // changed path and re-render the cards backed by it.
  useEffect(() => {
    if (state.status !== 'ready') return;
    let timer: number | null = null;
    const pending = new Set<string>();
    const flush = () => {
      timer = null;
      const document = documentRef.current;
      const paths = [...pending];
      pending.clear();
      if (!document || paths.length === 0) return;
      void loadCardContents(document, { force: true, onlyPaths: paths }).then((rendered) => {
        if (rendered) applyGraphRef.current(document);
      });
    };
    const unsubscribe = subscribeNotebookChanges((change) => {
      if (!change.notebookId) return;
      // External disk edits arrive as `query-invalidated` (path-only, no note
      // entry); in-app saves carry `resource-updated`. A move leaves the card
      // pointing at a stale path, so only its title snapshot changes.
      if (change.kind === 'path-moved') return;
      const affected = cardsRef.current.filter((card) => (
        card.kind === 'note'
        && (card.renderScope === 'full' || card.renderScope === 'section')
        && resolveCardNotebook(card)?.id === change.notebookId
        && (change.relativePath ? samePath(card.path ?? '', change.relativePath) : true)
      ));
      if (affected.length === 0) return;
      for (const card of affected) {
        const absolute = absolutePathOf(card);
        if (absolute) pending.add(absolute);
      }
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(flush, 400);
    });
    return () => {
      unsubscribe();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [absolutePathOf, loadCardContents, resolveCardNotebook, state.status]);

  const notebooks = useNoteStore((state) => state.notebooks);
  useEffect(() => {
    notebooksRef.current = notebooks.map((notebook) => ({ id: notebook.id, name: notebook.name, path: notebook.path }));
  }, [notebooks]);
  /** Owning notebook for save-and-sync; external-scope boards resolve to none. */
  const notebookId = useMemo(
    () => resolveNotebookIdForPath(filePath, notebooks),
    [filePath, notebooks],
  );

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
    contentHtmlRef.current = new Map();
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
      const contentsLoaded = await loadCardContents(document);
      if (!cancelled && (loaded || contentsLoaded)) applyGraph(document);
    })().catch((error) => {
      if (!cancelled) setState({ status: 'error', message: error instanceof CanvasParseError ? error.message : error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [applyGraph, filePath, loadCardContents, loadCardSummaries, notebookPath, retryToken, t]);

  // Notebook roots can arrive after the board paints; resolve card paths again
  // once they are known so summaries are not silently missing.
  useEffect(() => {
    if (state.status !== 'ready') return;
    const document = documentRef.current;
    if (!document) return;
    let cancelled = false;
    void (async () => {
      const summariesLoaded = await loadCardSummaries(document);
      const contentsLoaded = await loadCardContents(document);
      if (!cancelled && (summariesLoaded || contentsLoaded)) applyGraph(document);
    })();
    return () => { cancelled = true; };
  }, [applyGraph, loadCardContents, loadCardSummaries, notebooks, state.status]);

  const flush = useCallback(async (): Promise<boolean> => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const document = documentRef.current;
    if (!document || !dirtyRef.current) {
      setSaveDirty(false);
      return true;
    }
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
      setSaveDirty(false);
      return true;
    }
    document.meta = { ...document.meta, updatedAt: new Date().toISOString() };
    const { text } = build();
    try {
      const saved = await files.write(filePath, text, undefined, notebookPath ?? undefined);
      if (!saved) throw new Error('write_file returned false');
      dirtyRef.current = false;
      setSaveDirty(false);
      lastSavedTextRef.current = text;
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('canvas.save.failed'));
      return false;
    }
  }, [filePath, notebookPath, t]);

  const scheduleFlush = useCallback(() => {
    dirtyRef.current = true;
    setSaveDirty(true);
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void flush();
    }, SAVE_DEBOUNCE_MS);
  }, [flush]);

  /** 保存按钮 / Ctrl+S (画布 active 时): flush 本板, 再同步所在 notebook。
   *  未绑定 FNS 时 `syncNotebookNow` 返回 null, 静默跳过同步部分。 */
  const saveAndSync = useCallback(async (): Promise<void> => {
    if (readOnly || saveBusyRef.current) return;
    saveBusyRef.current = true;
    setSaveBusy(true);
    try {
      if (!(await flush())) return;
      if (!notebookId) return;
      const outcome = await syncNotebookNow(notebookId);
      if (outcome) toast.success(formatSyncOutcomeSummary(outcome, t));
    } catch (error) {
      toast.error(`${t('sync.panel.failed')}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      saveBusyRef.current = false;
      setSaveBusy(false);
    }
  }, [flush, notebookId, readOnly, t]);

  useEffect(() => {
    scheduleFlushRef.current = scheduleFlush;
    pushHistoryRef.current = pushHistory;
  }, [pushHistory, scheduleFlush]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (imageRetryRef.current !== null) window.clearTimeout(imageRetryRef.current);
  }, []);

  const handleNodesChange: OnNodesChange<BoardNode> = useCallback((changes: NodeChange<BoardNode>[]) => {
    // A touch drag must not summon the properties panel (Obsidian mobile);
    // hiding it at drag start also keeps it from blocking the gesture.
    if (lastPointerTypeRef.current === 'touch' && changes.some((change) => change.type === 'position' && change.dragging)) {
      touchDraggingRef.current = true;
      setPanelCollapsed(true);
    }
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  /**
   * Keep the selection mirror in sync with what react-flow actually renders.
   * Programmatic selection changes (graph rebuilds restoring `selected`,
   * deletes clearing it) never fire onSelectionChange, so deriving the mirror
   * from the node list is the only reliable source of truth.
   */
  const syncSelectionFromNodes = useCallback((nextNodes: BoardNode[]) => {
    const selected = nextNodes.filter((node) => node.selected);
    const ids = selected.map((node) => node.id);
    selectedIdsRef.current = ids;
    setSelectedShapeIds(selected.filter((node) => node.type === 'shape').map((node) => node.id));
    setSelectedInkIds(selected.filter((node) => node.type === 'ink').map((node) => node.id));
    setSelectedCardIds(selected.filter((node) => node.type !== 'frame' && node.type !== 'shape' && node.type !== 'ink').map((node) => node.id));
  }, []);

  /** No-op: the selection mirror is derived from the node list. */
  const handleSelectionChange = useCallback(() => {}, []);

  /** Every nodes update re-derives the selection mirror (idempotent). */
  useEffect(() => {
    syncSelectionFromNodes(nodes);
  }, [nodes, syncSelectionFromNodes]);

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
    // The last style used also becomes the style for newly created elements:
    // editing a selected shape must not fall back to stale tool defaults.
    if (patch.stroke !== undefined) setPenColor(patch.stroke);
    if (patch.fill !== undefined) setToolFill(patch.fill);
    if (patch.fillStyle !== undefined) setToolFillStyle(patch.fillStyle);
    if (patch.strokeStyle !== undefined) setToolStrokeStyle(patch.strokeStyle);
    if (patch.strokeWidth !== undefined) setPenWidth(patch.strokeWidth);
    if (patch.fontSize !== undefined) setToolFontSize(patch.fontSize);
    if (patch.fontFamily !== undefined) setToolFontFamily(patch.fontFamily);
    if (patch.textAlign !== undefined) setToolTextAlign(patch.textAlign);
    if (patch.opacity !== undefined) setToolOpacity(patch.opacity);
    if (patch.roughness !== undefined) setToolRoughness(patch.roughness);
    if (patch.edges !== undefined) setToolEdges(patch.edges);
    applyGraph(document);
    scheduleFlush();
    if (record) pushHistory();
  }, [applyGraph, pushHistory, scheduleFlush, selectedShapeIds]);

  /** Apply colour/width changes to selected ink strokes. */
  const patchSelectedInk = useCallback((patch: Partial<BoardInkStroke>, record = true) => {
    const document = documentRef.current;
    if (!document || selectedInkIds.length === 0) return;
    const ids = new Set(selectedInkIds);
    for (const stroke of inkRef.current) {
      if (ids.has(stroke.id)) Object.assign(stroke, patch);
    }
    document.ink = inkRef.current;
    if (patch.color !== undefined) setPenColor(patch.color);
    if (patch.width !== undefined) setPenWidth(patch.width);
    applyGraph(document);
    scheduleFlush();
    if (record) pushHistory();
  }, [applyGraph, pushHistory, scheduleFlush, selectedInkIds]);

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
  }, [applyGraph, pushHistory, scheduleFlush, selectedInkIds, selectedShapeIds]);

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
    let inkChanged = false;
    for (const node of dragged) {
      const card = cardsRef.current.find((item) => item.id === node.id);
      if (card && (card.x !== node.position.x || card.y !== node.position.y)) {
        card.x = node.position.x;
        card.y = node.position.y;
        cardsChanged = true;
      }
      // Node boxes are padded; the shape origin sits SHAPE_PADDING inside.
      const shape = shapesRef.current.find((item) => item.id === node.id);
      if (shape) {
        const originX = node.position.x + SHAPE_PADDING;
        const originY = node.position.y + SHAPE_PADDING;
        if (shape.x !== originX || shape.y !== originY) {
          shape.x = originX;
          shape.y = originY;
          shapesChanged = true;
        }
      }
    }
    for (const node of dragged) {
      const start = inkDragStartRef.current.get(node.id);
      const stroke = inkRef.current.find((item) => item.id === node.id);
      if (!start || !stroke) continue;
      const dx = node.position.x - start.boxX;
      const dy = node.position.y - start.boxY;
      if (dx === 0 && dy === 0) continue;
      stroke.points = start.points.map(([x, y]) => [x + dx, y + dy]);
      inkChanged = true;
    }
    if (inkChanged) document.ink = inkRef.current;
    inkDragStartRef.current.clear();
    if (!cardsChanged && !shapesChanged && !inkChanged) return;
    // First real edit swaps the passthrough arrays for normalized values.
    if (cardsChanged) document.cards = cardsRef.current;
    if (shapesChanged) document.shapes = shapesRef.current;
    scheduleFlush();
    pushHistory();
  }, [scheduleFlush]);

  /**
   * Resize live/commit for shapes.
   *
   * `live` fires on every drag frame: the shape's geometry is rewritten and the
   * node's data/size are replaced in place, so the rough paths (and labels)
   * grow with the handle instead of waiting for release. On release the
   * geometry already on screen is committed to the document, history records
   * it and the graph is rebuilt from that truth.
   *
   * Text elements scale uniformly: the box keeps the aspect ratio implied by
   * the label and the font size tracks the box, so the text keeps filling it.
   */
  /** `direct` (the 'grow' phase) applies the box verbatim: no rescale base is
   *  captured and text elements skip their uniform-scale branch, so editor-
   *  driven growth never disturbs a later handle drag. */
  const applyShapeResize = useCallback((nodeId: string, box: ResizeBoxRect, shape: BoardShape, direct = false) => {
    if (direct) {
      shape.x = box.x + SHAPE_PADDING;
      shape.y = box.y + SHAPE_PADDING;
      shape.w = Math.max(16, box.width - SHAPE_PADDING * 2);
      shape.h = Math.max(16, box.height - SHAPE_PADDING * 2);
      return;
    }
    const base = resizeBaseRef.current?.id === nodeId
      ? resizeBaseRef.current
      : (resizeBaseRef.current = { id: nodeId, kind: 'shape', x: shape.x, y: shape.y, w: shape.w, h: shape.h, fontSize: shape.fontSize ?? FONT_SIZES[2] });
    if (shape.shape === 'text') {
      // Uniform scale from the box the drag started with; anchor at the box
      // center so the label stays under the pointer while it grows.
      const baseW = base.w + SHAPE_PADDING * 2;
      const baseH = base.h + SHAPE_PADDING * 2;
      const scale = Math.sqrt(Math.max(0.05, box.width / baseW) * Math.max(0.05, box.height / baseH));
      const w = Math.max(16, base.w * scale);
      const h = Math.max(16, base.h * scale);
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      shape.x = cx - w / 2;
      shape.y = cy - h / 2;
      shape.w = w;
      shape.h = h;
      shape.fontSize = Math.max(6, Math.round((base.fontSize ?? shape.fontSize ?? FONT_SIZES[2]) * scale));
      return;
    }
    shape.x = box.x + SHAPE_PADDING;
    shape.y = box.y + SHAPE_PADDING;
    shape.w = Math.max(16, box.width - SHAPE_PADDING * 2);
    shape.h = Math.max(16, box.height - SHAPE_PADDING * 2);
  }, []);

  const handleShapeResize = useCallback((nodeId: string, box: ResizeBoxRect, phase: ResizePhase = 'end') => {
    const document = documentRef.current;
    if (!document) return;
    const shape = shapesRef.current.find((item) => item.id === nodeId);
    if (!shape) return;
    if (phase === 'live' || phase === 'grow') {
      applyShapeResize(nodeId, box, shape, phase === 'grow');
      // Redraw this node only: rebuilding the whole graph every frame would
      // fight the drag and drop the selection.
      const next = { ...shape };
      const nodeBox = shapeBoxWithPadding(next);
      // React Flow emits its own dimension change right after this callback,
      // so a synchronous update would be overwritten and the box would show
      // the raw drag rect (text boxes are snapped to the label's aspect).
      queueMicrotask(() => setNodes((current) => current.map((node) => (node.id === nodeId
        ? {
          ...node,
          data: { ...node.data, shape: next },
          // Both the layout fields and the inline style: React Flow's own
          // dimension change writes width/height, and the renderer prefers
          // those over style.
          width: nodeBox.w,
          height: nodeBox.h,
          style: { ...node.style, width: nodeBox.w, height: nodeBox.h },
        }
        : node))));
      // Grow rides the text editing session: persist the geometry (the commit
      // may no-op when only the box changed) but leave history to the commit.
      if (phase === 'grow') {
        document.shapes = shapesRef.current;
        scheduleFlush();
      }
      return;
    }
    // Live frames already wrote the geometry on screen. The end event reports
    // d3's release point, which differs slightly from the last move frame — so
    // recomputing here made the element jump on mouse-up. Commit what the user
    // sees. Without live frames (a click, not a drag) honor the reported box.
    if (resizeBaseRef.current?.id !== nodeId) applyShapeResize(nodeId, box, shape);
    resizeBaseRef.current = null;
    document.shapes = shapesRef.current;
    // Rebuild from the document so node boxes, hit areas and selection rings
    // all agree with the committed geometry.
    applyGraphRef.current(document);
    scheduleFlush();
    pushHistory();
  }, [applyShapeResize, pushHistory, scheduleFlush]);

  // No dependency array: runs after render, once every handler below is
  // initialized (avoids TDZ reads of the consts declared further down).
  useEffect(() => {
    applyGraphRef.current = applyGraph;
    handleShapeResizeRef.current = handleShapeResize;
    handleCardResizeRef.current = handleCardResize;
    handleFrameResizeRef.current = handleFrameResize;
    handleInkResizeRef.current = handleInkResize;
    commitCardTextRef.current = commitCardText;
    commitFrameTitleRef.current = commitFrameTitle;
  });

  // Obsidian-style tool keys (V/H/P/E/R/O/D/A/T/N/F, Esc): claim this board
  // as the shortcut surface on mount, and only hand the pointer to the last
  // board the user actually touched (a second board in split view must win).
  const surfaceId = useMemo(() => `canvas-board:${workspaceHost}:${filePath}`, [filePath, workspaceHost]);
  useEffect(() => {
    claimCanvasSurface(surfaceId);
    return () => releaseCanvasSurface(surfaceId);
  }, [surfaceId]);
  useEffect(() => {
    const markSurface = (event: PointerEvent | FocusEvent) => {
      const board = boardRef.current;
      const target = event.target;
      if (board && target instanceof Node && board.contains(target)) setActiveCanvasSurface(surfaceId);
      else if (target instanceof Element && !target.closest('[data-canvas-surface]')) setActiveCanvasSurface(null);
    };
    document.addEventListener('pointerdown', markSurface, true);
    document.addEventListener('focusin', markSurface, true);
    return () => {
      document.removeEventListener('pointerdown', markSurface, true);
      document.removeEventListener('focusin', markSurface, true);
    };
  }, [surfaceId]);
  useEffect(() => {
    if (readOnly) return;
    const ownedByThisBoard = () => getActiveCanvasSurface() === surfaceId;
    const pops = CANVAS_TOOL_SHORTCUTS.map(({ actionId, tool }) => pushHandler(actionId, () => {
      selectTool(tool as BoardTool);
      return true;
    }, { isActive: ownedByThisBoard }));
    pops.push(pushHandler('canvas.tool.cancel', () => {
      selectTool('select');
      return true;
    }, { isActive: ownedByThisBoard }));
    // Ctrl+S: 本板是当前交互面时由画布自管保存并同步; 否则 action.run 落到
    // sync-coordination 的通用「保存打开文档并同步」路径。
    pops.push(pushHandler('document.saveAndSync', () => {
      void saveAndSync();
      return true;
    }, { isActive: ownedByThisBoard }));
    return () => pops.forEach((pop) => pop());
  }, [readOnly, saveAndSync, selectTool, surfaceId]);

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
      ink: inkRef.current.filter((stroke) => ids.has(stroke.id)).map((stroke) => ({ ...stroke, points: stroke.points.map((point) => [...point]) })),
    };
  }, []);

  /** Paste the clipboard. Without `at` the clones cascade off the originals;
   *  with one (context-menu paste) the whole group is centred on that flow
   *  point, like Obsidian pasting at the cursor. */
  const pasteClipboard = useCallback((at?: number[]) => {
    const clipboard = clipboardRef.current;
    const document = documentRef.current;
    if (!clipboard || !document) return;
    if (clipboard.cards.length === 0 && clipboard.shapes.length === 0 && clipboard.ink.length === 0) return;
    const offset = 28;
    const bounds = at ? clipboardBounds(clipboard) : null;
    const dx = bounds ? Math.round(at![0] - (bounds.x + bounds.w / 2)) : offset;
    const dy = bounds ? Math.round(at![1] - (bounds.y + bounds.h / 2)) : offset;
    const newIds: string[] = [];
    // Clones land on top of the stack, one slot each.
    let cloneZ = nextZ();
    const nextCards = [...cardsRef.current, ...clipboard.cards.map((card) => {
      const clone = { ...card, id: `${card.id.split('_')[0]}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, x: card.x + dx, y: card.y + dy, z: cloneZ };
      cloneZ += 1;
      newIds.push(clone.id);
      return clone;
    })];
    const nextShapes = [...shapesRef.current, ...clipboard.shapes.map((shape) => {
      const id = shapeId();
      newIds.push(id);
      const clone = {
        ...shape,
        id,
        x: shape.x + dx,
        y: shape.y + dy,
        z: cloneZ,
        ...(shape.x2 !== undefined ? { x2: shape.x2 + dx } : {}),
        ...(shape.y2 !== undefined ? { y2: shape.y2 + dy } : {}),
      };
      cloneZ += 1;
      return clone;
    })];
    const nextInk = [...inkRef.current, ...clipboard.ink.map((stroke) => {
      const id = inkStrokeId();
      newIds.push(id);
      const clone = { ...stroke, id, z: cloneZ, points: stroke.points.map(([x, y]) => [x + dx, y + dy]) };
      cloneZ += 1;
      return clone;
    })];
    cardsRef.current = nextCards;
    shapesRef.current = nextShapes;
    inkRef.current = nextInk;
    document.cards = nextCards;
    document.shapes = nextShapes;
    document.ink = nextInk;
    selectedIdsRef.current = newIds;
    setSelectedShapeIds(nextShapes.filter((shape) => newIds.includes(shape.id)).map((shape) => shape.id));
    applyGraph(document);
    scheduleFlush();
    pushHistory();
  }, [applyGraph, nextZ, pushHistory, scheduleFlush]);

  const duplicateSelection = useCallback(() => {
    copySelection();
    pasteClipboard();
  }, [copySelection, pasteClipboard]);

  /** Select every content element. Frames stay backdrops (matching the
   *  rubber-band) and connectors keep their exclusive selection, so it is
   *  cleared first. */
  const selectAllElements = useCallback(() => {
    selectedEdgeIdRef.current = null;
    setSelectedEdgeId(null);
    selectedIdsRef.current = [];
    setNodes((current) => current.map((node) => (node.type === 'frame'
      ? (node.selected ? { ...node, selected: false } : node)
      : (node.selected ? node : { ...node, selected: true }))));
  }, []);

  /** Wrap the current selection in a new frame sized to its bounding box.
   *  Frames render behind everything, so nothing is visually covered. */
  const createFrameFromSelection = useCallback(() => {
    const document = documentRef.current;
    if (!document) return;
    const ids = new Set(selectedIdsRef.current);
    if (ids.size === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const card of cardsRef.current) {
      if (!ids.has(card.id)) continue;
      minX = Math.min(minX, card.x);
      minY = Math.min(minY, card.y);
      maxX = Math.max(maxX, card.x + card.w);
      maxY = Math.max(maxY, card.y + card.h);
    }
    for (const shape of shapesRef.current) {
      if (!ids.has(shape.id)) continue;
      const x2 = shape.x2 ?? shape.x + shape.w;
      const y2 = shape.y2 ?? shape.y + shape.h;
      minX = Math.min(minX, shape.x, x2);
      minY = Math.min(minY, shape.y, y2);
      maxX = Math.max(maxX, shape.x, x2);
      maxY = Math.max(maxY, shape.y, y2);
    }
    for (const stroke of inkRef.current) {
      if (!ids.has(stroke.id)) continue;
      const box = inkBox(stroke);
      minX = Math.min(minX, box.x);
      minY = Math.min(minY, box.y);
      maxX = Math.max(maxX, box.x + box.w);
      maxY = Math.max(maxY, box.y + box.h);
    }
    if (!Number.isFinite(minX)) return;
    const padding = 60;
    const frame: BoardFrame = {
      id: `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      x: Math.round(minX - padding),
      y: Math.round(minY - padding),
      w: Math.round(maxX - minX + padding * 2),
      h: Math.round(maxY - minY + padding * 2),
    };
    document.frames = [...readBoardFrames(document), frame];
    applyGraphRef.current(document);
    scheduleFlush();
    pushHistory();
  }, [applyGraphRef, pushHistory, scheduleFlush]);

  /**
   * Insert an image card. Bytes are persisted into attachments/ and only the
   * notebook-relative key lands in the canvas JSON, so the same board renders
   * on every device.
   */
  const insertImage = useCallback(async (params: {
    dataUrl: string;
    mimeType: string;
    fileName: string;
    flowX: number;
    flowY: number;
    /** Skip the attachment write when the caller already stored the bytes. */
    storageKey?: string;
  }) => {
    const document = documentRef.current;
    if (!document) return;
    let storageKey = params.storageKey ?? null;
    if (!storageKey) {
      const payload = dataUrlPayload(params.dataUrl);
      if (!payload) return;
      try {
        const saved = await notebookAssets.saveContent({
          content: payload,
          fileName: params.fileName,
          notePath: filePath,
        });
        storageKey = saved?.key ?? null;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t('canvas.save.failed'));
        return;
      }
    }
    if (!storageKey) return;
    // Natural aspect ratio, clamped to a comfortable default width.
    const size = await imageSizeOf(params.dataUrl).catch(() => null);
    // Fit large images, but never insert something too small to grab.
    const maxWidth = 360;
    const minWidth = 96;
    const scale = size
      ? (size.width > maxWidth ? maxWidth / size.width : size.width < minWidth ? minWidth / size.width : 1)
      : 1;
    const width = size ? Math.round(size.width * scale) : 320;
    const height = size ? Math.round(size.height * scale) : 240;

    const fileId = `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const card: BoardCard = {
      id: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      kind: 'image',
      x: params.flowX,
      y: params.flowY,
      w: width,
      h: height,
      z: nextZ(),
      fileId,
    };
    document.files = {
      ...document.files,
      [fileId]: { id: fileId, mimeType: params.mimeType, storageKey },
    };
    storageKeysRef.current.set(fileId, storageKey);
    dataUrlsRef.current.set(fileId, params.dataUrl);
    cardsRef.current = [...cardsRef.current, card];
    document.cards = cardsRef.current;
    selectedIdsRef.current = [card.id];
    applyGraphRef.current(document);
    scheduleFlush();
    pushHistory();
  }, [filePath, nextZ, pushHistory, scheduleFlush, t]);

  /** Insert whatever image files the clipboard or a drop carries. */
  const insertImageFiles = useCallback(async (files: File[], flowX: number, flowY: number) => {
    let offset = 0;
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const dataUrl = await new Promise<string | null>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });
      if (!dataUrl) continue;
      await insertImage({
        dataUrl,
        mimeType: file.type || 'image/png',
        fileName: file.name || `image-${Date.now()}.png`,
        flowX: flowX + offset,
        flowY: flowY + offset,
      });
      offset += 28;
    }
  }, [insertImage]);

  /**
   * Insert a note card with its top-left at a flow position. The card stores
   * only the note identity plus its read-only scope; the body is rendered from
   * the note as soon as the content batch returns, and again whenever the note
   * changes.
   */
  const insertNoteCardAt = useCallback(async (selection: NoteCardSelection, flowX: number, flowY: number) => {
    const document = documentRef.current;
    if (!document || readOnly) return;
    const width = selection.renderScope === 'section' ? 380 : 420;
    const height = selection.renderScope === 'section' ? 300 : 400;
    const card: BoardCard = {
      id: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      kind: 'note',
      x: Math.round(flowX),
      y: Math.round(flowY),
      w: width,
      h: height,
      z: nextZ(),
      notebookId: selection.notebookId,
      ...(selection.notebookName ? { notebookName: selection.notebookName } : {}),
      path: selection.path,
      title: selection.title,
      renderScope: selection.renderScope,
      ...(selection.renderScope === 'section' && selection.heading ? { heading: selection.heading } : {}),
    };
    cardsRef.current = [...cardsRef.current, card];
    document.cards = cardsRef.current;
    applyGraphRef.current(document);
    scheduleFlush();
    pushHistory();
    // Titles/tags and the rendered body arrive after the card face paints.
    const loadedSummary = await loadCardSummaries(document);
    const absolute = absolutePathOf(card);
    const loadedContent = await loadCardContents(document, absolute ? { onlyPaths: [absolute] } : {});
    if (loadedSummary || loadedContent) applyGraphRef.current(document);
  }, [absolutePathOf, loadCardContents, loadCardSummaries, nextZ, pushHistory, readOnly, scheduleFlush]);

  /** Toolbar dialog: centre the new card in the viewport, cascading repeats. */
  const insertNoteCard = useCallback(async (selection: NoteCardSelection) => {
    const width = selection.renderScope === 'section' ? 380 : 420;
    const height = selection.renderScope === 'section' ? 300 : 400;
    const rect = boardRef.current?.getBoundingClientRect();
    const center = rect
      ? reactFlow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      : { x: 0, y: 0 };
    const offset = insertCascadeRef.current * 32;
    insertCascadeRef.current += 1;
    await insertNoteCardAt(selection, center.x - width / 2 + offset, center.y - height / 2 + offset);
  }, [insertNoteCardAt, reactFlow]);

  // File-tree drag: drop one or more notes onto the board as full-note cards.
  useEffect(() => {
    if (state.status !== 'ready' || readOnly) return;
    return registerDropTarget<NotebookDragResource, { x: number; y: number }>({
      id: `canvas-board:${filePath}`,
      priority: 60,
      hitTest: (point) => {
        const rect = boardRef.current?.getBoundingClientRect();
        if (!rect) return null;
        if (point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom) return null;
        const flow = reactFlow.screenToFlowPosition({ x: point.x, y: point.y });
        return { x: flow.x, y: flow.y };
      },
      locationKey: (location) => `${Math.round(location.x)},${Math.round(location.y)}`,
      evaluate: (payload) => {
        const notes = payload.items.filter(isMarkdownNoteDragResource);
        return notes.length > 0 && notes.length === payload.items.length
          ? { accepted: true }
          : { accepted: false, reason: 'unsupported-resource' };
      },
      onPreview: () => {},
      onDrop: async (payload, location) => {
        const notes = payload.items.filter(isMarkdownNoteDragResource);
        let offset = 0;
        for (const note of notes) {
          await insertNoteCardAt({
            notebookId: note.notebookId,
            notebookName: notebooksRef.current.find((notebook) => notebook.id === note.notebookId)?.name,
            path: note.relativePath,
            title: note.title,
            renderScope: 'full',
          }, location.x + offset, location.y + offset);
          offset += 32;
        }
      },
      onError: (error) => {
        logger.warn('canvas board note drop failed', { error: String(error) });
      },
    });
  }, [filePath, insertNoteCardAt, reactFlow, readOnly, state.status]);

  // Clipboard paste works without focusing the canvas first.
  useEffect(() => {
    if (state.status !== 'ready') return;
    const onPaste = (event: ClipboardEvent) => {
      const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'));
      if (files.length === 0) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))) return;
      event.preventDefault();
      const viewport = reactFlow.getViewport();
      const rect = boardRef.current?.getBoundingClientRect();
      const flowX = rect ? (rect.width / 2 - viewport.x) / viewport.zoom : 0;
      const flowY = rect ? (rect.height / 2 - viewport.y) / viewport.zoom : 0;
      void insertImageFiles(files, flowX, flowY);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [insertImageFiles, reactFlow, state.status]);

  /** Toolbar entry: pick image files from disk and drop them on the board. */
  const pickImages = useCallback(async () => {
    const paths = await dialogs.selectFiles({ accept: 'image/*', multiple: true });
    if (!paths || paths.length === 0) return;
    const viewport = reactFlow.getViewport();
    const rect = boardRef.current?.getBoundingClientRect();
    const centerX = rect ? (rect.width / 2 - viewport.x) / viewport.zoom : 0;
    const centerY = rect ? (rect.height / 2 - viewport.y) / viewport.zoom : 0;
    let offset = 0;
    for (const path of paths) {
      try {
        const saved = await notebookAssets.saveFromPath(path, { notePath: filePath });
        const key = saved?.key;
        if (!key) continue;
        const dataUrl = await notebookAssets.readContent({ storageKey: key, notePath: filePath });
        if (!dataUrl) continue;
        const fileName = path.split(/[\\/]/).pop() ?? 'image.png';
        const mimeType = dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png';
        await insertImage({
          dataUrl,
          mimeType,
          fileName,
          flowX: centerX + offset,
          flowY: centerY + offset,
          storageKey: key,
        });
        offset += 28;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t('canvas.save.failed'));
      }
    }
  }, [filePath, insertImage, reactFlow, t]);

  /** Card resize writes the new box straight into the card. The card body
   * already grows live (NodeResizer resizes the node box and the content
   * fills it), so only the release has to reach the document. */
  const handleCardResize = useCallback((nodeId: string, box: ResizeBoxRect, phase: ResizePhase = 'end') => {
    if (phase === 'live') return;
    const document = documentRef.current;
    if (!document) return;
    const card = cardsRef.current.find((item) => item.id === nodeId);
    if (!card) return;
    const w = Math.max(40, box.width);
    const h = Math.max(30, box.height);
    if (card.x === box.x && card.y === box.y && card.w === w && card.h === h) return;
    card.x = box.x;
    card.y = box.y;
    card.w = w;
    card.h = h;
    document.cards = cardsRef.current;
    applyGraphRef.current(document);
    scheduleFlush();
    pushHistory();
  }, [pushHistory, scheduleFlush]);

  /** Sticky-note body commit. Sticky text lives on the card itself, so a
   *  no-op edit must not record history (the node keeps focus otherwise). */
  const commitCardText = useCallback((cardId: string, text: string) => {
    const document = documentRef.current;
    if (!document) return;
    const card = cardsRef.current.find((item) => item.id === cardId);
    if (!card || (card.text ?? '') === text) return;
    card.text = text;
    document.cards = cardsRef.current;
    // Only the node's data changes; rebuilding the graph would blur the editor.
    setNodes((current) => current.map((node) => (node.id === cardId
      ? { ...node, data: { ...node.data, card: { ...node.data.card, text } } }
      : node)));
    scheduleFlush();
    pushHistory();
  }, [pushHistory, scheduleFlush]);

  /** Frame label commit; frames are stored separately from cards. */
  const commitFrameTitle = useCallback((frameId: string, title: string) => {
    const document = documentRef.current;
    if (!document) return;
    const frames = readBoardFrames(document);
    const frame = frames.find((item) => item.id === frameId);
    if (!frame || (frame.title ?? '') === title) return;
    document.frames = frames.map((item) => (item.id === frameId
      ? { ...item, ...(title ? { title } : { title: undefined }) }
      : item));
    applyGraphRef.current(document);
    scheduleFlush();
    pushHistory();
  }, [pushHistory, scheduleFlush]);

  /** Frame resize: live frames only redraw the node box, the release commits. */
  const handleFrameResize = useCallback((nodeId: string, box: ResizeBoxRect, phase: ResizePhase = 'end') => {
    if (phase === 'live') return;
    const document = documentRef.current;
    if (!document) return;
    const frames = readBoardFrames(document);
    const frame = frames.find((item) => item.id === nodeId);
    if (!frame) return;
    const w = Math.max(80, box.width);
    const h = Math.max(60, box.height);
    if (frame.x === box.x && frame.y === box.y && frame.w === w && frame.h === h) return;
    document.frames = frames.map((item) => (item.id === nodeId
      ? { ...item, x: box.x, y: box.y, w, h }
      : item));
    applyGraphRef.current(document);
    scheduleFlush();
    pushHistory();
  }, [pushHistory, scheduleFlush]);

/**
 * Ink resize scales every point from the bbox captured when the drag started
 * into the live box. Live frames redraw just this node; the release commits.
 */
  const handleInkResize = useCallback((nodeId: string, box: ResizeBoxRect, phase: ResizePhase = 'end') => {
    const document = documentRef.current;
    if (!document) return;
    const stroke = inkRef.current.find((item) => item.id === nodeId);
    if (!stroke) return;
    // The stroke mutates every frame, so the source bbox must be snapshotted
    // once per gesture — re-deriving it from the live points compounds the scale.
    const gestureActive = resizeBaseRef.current?.id === nodeId;
    if (phase === 'end' && gestureActive) {
      // The points already hold the last live frame; the end event's box is
      // d3's release point and would shift the stroke on mouse-up.
      resizeBaseRef.current = null;
      document.ink = inkRef.current;
      applyGraphRef.current(document);
      scheduleFlush();
      pushHistory();
      return;
    }
    const base = gestureActive
      ? resizeBaseRef.current
      : (resizeBaseRef.current = {
        id: nodeId,
        kind: 'ink',
        ...inkBox(stroke),
        // Explicit copy: the stroke's own points array is rewritten below.
      });
    if (!base || base.kind !== 'ink') return;
    const basePoints = base.points ?? (base.points = stroke.points.map(([x, y]) => [x, y]));
    const w = Math.max(40, box.width);
    const h = Math.max(30, box.height);
    const sx = base.w === 0 ? 1 : w / base.w;
    const sy = base.h === 0 ? 1 : h / base.h;
    stroke.points = basePoints.map(([x, y]) => [
      box.x + (x - base.x) * sx,
      box.y + (y - base.y) * sy,
    ]);
    if (phase === 'live') {
      const next = { ...stroke, points: stroke.points };
      const nodeBox = inkBox(next);
      queueMicrotask(() => setNodes((current) => current.map((node) => (node.id === nodeId
        ? {
          ...node,
          data: { ...node.data, inkStroke: next },
          width: nodeBox.w,
          height: nodeBox.h,
          style: { ...node.style, width: nodeBox.w, height: nodeBox.h },
        }
        : node))));
      return;
    }
    resizeBaseRef.current = null;
    document.ink = inkRef.current;
    applyGraphRef.current(document);
    scheduleFlush();
    pushHistory();
  }, [pushHistory, scheduleFlush]);

  /** Double-click on empty canvas drops a text element and starts editing
   *  (Obsidian's global gesture; the hand tool keeps it too). */
  const handleSurfaceDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (readOnly || (tool !== 'select' && tool !== 'hand')) return;
    if ((event.target as Element).closest('.react-flow__node, [data-board-toolbar]')) return;
    const document = documentRef.current;
    if (!document) return;
    const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const box = textShapeAt([position.x, position.y], toolTextAlign);
    const shape: BoardShape = {
      id: shapeId(),
      shape: 'text',
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      stroke: penColor,
      z: nextZ(),
      fontSize: toolFontSize,
      fontFamily: toolFontFamily,
      textAlign: toolTextAlign,
      text: '',
    };
    shapesRef.current = [...shapesRef.current, shape];
    document.shapes = shapesRef.current;
    setNodes((current) => [...current, shapeNodeFor(shape, commitShapeText, handleShapeResizeRef.current, true)]);
    scheduleFlush();
    pushHistory();
  }, [commitShapeText, nextZ, penColor, pushHistory, reactFlow, readOnly, scheduleFlush, tool, toolFontFamily, toolFontSize, toolTextAlign]);

  /** Delete key on a selected card/shape edits the document, not just the view. */
  const removeByIds = useCallback((ids: string[]) => {
    const document = documentRef.current;
    if (!document || ids.length === 0 || readOnly) return;
    const idSet = new Set(ids);
    const nextShapes = shapesRef.current.filter((shape) => !idSet.has(shape.id));
    const nextCards = cardsRef.current.filter((card) => !idSet.has(card.id));
    const nextInk = inkRef.current.filter((stroke) => !idSet.has(stroke.id));
    const currentFrames = readBoardFrames(document);
    const nextFrames = currentFrames.filter((frame) => !idSet.has(frame.id));
    const shapesChanged = nextShapes.length !== shapesRef.current.length;
    const cardsChanged = nextCards.length !== cardsRef.current.length;
    const inkChanged = nextInk.length !== inkRef.current.length;
    const framesChanged = nextFrames.length !== currentFrames.length;
    if (!shapesChanged && !cardsChanged && !inkChanged && !framesChanged) return;
    if (framesChanged) document.frames = nextFrames;
    if (shapesChanged) {
      shapesRef.current = nextShapes;
      document.shapes = nextShapes;
    }
    if (cardsChanged) {
      cardsRef.current = nextCards;
      document.cards = nextCards;
    }
    if (inkChanged) {
      inkRef.current = nextInk;
      document.ink = nextInk;
    }
    selectedIdsRef.current = selectedIdsRef.current.filter((id) => !idSet.has(id));
    setSelectedInkIds((current) => current.filter((id) => !idSet.has(id)));
    applyGraph(document);
    scheduleFlush();
    pushHistory();
  }, [applyGraph, pushHistory, readOnly, scheduleFlush]);

  const handleNodesDelete = useCallback((deleted: BoardNode[]) => {
    removeByIds(deleted.map((node) => node.id));
  }, [removeByIds]);

  /** Copy + delete in one step (context menu 剪切 / Ctrl+X). */
  const cutSelection = useCallback(() => {
    if (selectedIdsRef.current.length === 0) return;
    copySelection();
    removeByIds(selectedIdsRef.current);
  }, [copySelection, removeByIds]);

  /** Delete selected connectors. React Flow only reports deletions through
   *  `onEdgesDelete`; without it the controlled `edges` prop restores them on
   *  the next render. */
  const handleEdgesDelete = useCallback((deleted: Edge[]) => {
    const document = documentRef.current;
    if (!document || readOnly || deleted.length === 0) return;
    const ids = new Set(deleted.map((edge) => edge.id));
    const current = readBoardEdges(document);
    const next = current.filter((edge) => !ids.has(edge.id));
    if (next.length === current.length) return;
    document.edges = next;
    applyGraph(document);
    scheduleFlush();
    pushHistory();
  }, [applyGraph, pushHistory, readOnly, scheduleFlush]);

  const selectEdge = useCallback((edgeId: string | null) => {
    selectedEdgeIdRef.current = edgeId;
    setSelectedEdgeId(edgeId);
    if (edgeId) {
      // A connector is an exclusive selection: otherwise Delete would remove
      // both the edge and whatever node happened to be selected.
      selectedIdsRef.current = [];
      setSelectedShapeIds([]);
      setSelectedCardIds([]);
      setSelectedInkIds([]);
      setNodes((current) => current.some((node) => node.selected)
        ? current.map((node) => (node.selected ? { ...node, selected: false } : node))
        : current);
    }
    const document = documentRef.current;
    if (document) applyGraphRef.current(document);
  }, []);

  const deleteSelectedEdge = useCallback(() => {
    const edgeId = selectedEdgeIdRef.current;
    if (!edgeId) return;
    handleEdgesDelete([{ id: edgeId } as Edge]);
    selectedEdgeIdRef.current = null;
    setSelectedEdgeId(null);
    const document = documentRef.current;
    if (document) applyGraphRef.current(document);
  }, [handleEdgesDelete]);

  useEffect(() => {
    if (!selectedEdgeId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      event.preventDefault();
      event.stopPropagation();
      deleteSelectedEdge();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [deleteSelectedEdge, selectedEdgeId]);

  /** Global stacking across shapes/cards/ink: normalize to dense z values,
   * move the picked elements, then write each array back in stacking order.
   * Type defaults only apply until the first layer op assigns explicit z.
   * Reads the selection mirror ref, not the state arrays: the context menu
   * builds its items in the same handler that re-selects the right-clicked
   * node, so a state-based closure would act on the stale (pre-click)
   * selection and silently no-op. */
  const moveSelectedLayer = useCallback((layer: 'front' | 'forward' | 'backward' | 'back') => {
    const document = documentRef.current;
    if (!document) return;
    const ids = new Set(selectedIdsRef.current);
    if (ids.size === 0) return;
    const defaultZ = { shape: 5, card: 10, ink: 20 } as const;
    type Entry = { el: BoardShape | BoardCard | BoardInkStroke; kind: keyof typeof defaultZ };
    const entries: Entry[] = [
      ...shapesRef.current.map((el) => ({ el, kind: 'shape' as const })),
      ...cardsRef.current.map((el) => ({ el, kind: 'card' as const })),
      ...inkRef.current.map((el) => ({ el, kind: 'ink' as const })),
    ];
    const zOf = (entry: Entry) => entry.el.z ?? defaultZ[entry.kind];
    // Stable order: explicit z, array position breaks ties (legacy files).
    const stack = entries
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => zOf(a.entry) - zOf(b.entry) || a.index - b.index)
      .map(({ entry }) => entry);
    let next: Entry[];
    if (layer === 'front') {
      next = [...stack.filter((entry) => !ids.has(entry.el.id)), ...stack.filter((entry) => ids.has(entry.el.id))];
    } else if (layer === 'back') {
      next = [...stack.filter((entry) => ids.has(entry.el.id)), ...stack.filter((entry) => !ids.has(entry.el.id))];
    } else {
      next = [...stack];
      if (layer === 'forward') {
        for (let i = next.length - 2; i >= 0; i -= 1) {
          if (ids.has(next[i].el.id) && !ids.has(next[i + 1].el.id)) {
            [next[i], next[i + 1]] = [next[i + 1], next[i]];
          }
        }
      } else {
        for (let i = 1; i < next.length; i += 1) {
          if (ids.has(next[i].el.id) && !ids.has(next[i - 1].el.id)) {
            [next[i], next[i - 1]] = [next[i - 1], next[i]];
          }
        }
      }
    }
    // Dense re-assignment keeps future inserts and repeat presses well-ordered.
    const shapesOut: BoardShape[] = [];
    const cardsOut: BoardCard[] = [];
    const inkOut: BoardInkStroke[] = [];
    next.forEach((entry, index) => {
      entry.el.z = index + 1;
      if (entry.kind === 'shape') shapesOut.push(entry.el as BoardShape);
      else if (entry.kind === 'card') cardsOut.push(entry.el as BoardCard);
      else inkOut.push(entry.el as BoardInkStroke);
    });
    document.shapes = shapesRef.current = shapesOut;
    document.cards = cardsRef.current = cardsOut;
    document.ink = inkRef.current = inkOut;
    applyGraph(document);
    scheduleFlush();
    pushHistory();
  }, [applyGraph, pushHistory, scheduleFlush]);

  const dragStartPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const handleNodeDragStart = useCallback((_event: unknown, node: BoardNode, dragged: BoardNode[]) => {
    // On touch, a node drag must not summon the properties panel (Obsidian
    // mobile behaviour); hide it for the gesture so it can't block the drag.
    touchDraggingRef.current = lastPointerTypeRef.current === 'touch';
    if (touchDraggingRef.current) setPanelCollapsed(true);
    dragStartPositionsRef.current = new Map(
      (dragged.length > 0 ? dragged : [node]).map((item) => [item.id, { x: item.position.x, y: item.position.y }]),
    );
    inkDragStartRef.current.clear();
    for (const item of dragged.length > 0 ? dragged : [node]) {
      if (item.type !== 'ink') continue;
      const stroke = inkRef.current.find((entry) => entry.id === item.id);
      const box = stroke ? inkBox(stroke) : null;
      if (!stroke || !box) continue;
      inkDragStartRef.current.set(item.id, {
        boxX: box.x,
        boxY: box.y,
        points: stroke.points.map(([x, y]) => [x, y]),
      });
    }
  }, []);

  const handleNodeDragStop = useCallback(
    (event: unknown, node: BoardNode, dragged: BoardNode[]) => {
      void event;
      const moved = (dragged.length > 0 ? dragged : [node]).some((item) => {
        const start = dragStartPositionsRef.current.get(item.id);
        return start && (Math.abs(item.position.x - start.x) > 3 || Math.abs(item.position.y - start.y) > 3);
      });
      dragStartPositionsRef.current.clear();
      syncPositionsToDocument(dragged.length > 0 ? dragged : [node]);
      if (!touchDraggingRef.current) return;
      touchDraggingRef.current = false;
      // React Flow also runs dragStart/Stop for a stationary tap; only a real
      // move should leave reading mode. Otherwise a tap could never select a
      // card for scrolling.
      if (!moved) return;
      // Touch drags must leave the card in moving mode. A selected note card
      // turns its body into a scrollable reader (`nodrag`), so the next touch
      // drag that starts on the body would be swallowed — the "first drag
      // works, second does not" cycle. Tapping selects it for reading.
      selectedIdsRef.current = [];
      setSelectedShapeIds([]);
      setSelectedCardIds([]);
      setSelectedInkIds([]);
      setNodes((current) => current.some((item) => item.selected)
        ? current.map((item) => (item.selected ? { ...item, selected: false } : item))
        : current);
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

  /** A touch double-tap can reach us through both `onNodeClick` and the
   *  synthesized `dblclick`; open once per gesture. */
  const lastOpenRef = useRef<{ id: string; at: number } | null>(null);
  const openCardNode = useCallback(async (node: BoardNode) => {
    if (tool !== 'select') return;
    const card = cardsRef.current.find((item) => item.id === node.id);
    if (!card || (card.kind !== 'note' && card.kind !== 'canvas')) return;
    if (!card.path) return;
    const now = Date.now();
    if (lastOpenRef.current?.id === card.id && now - lastOpenRef.current.at < 600) return;
    lastOpenRef.current = { id: card.id, at: now };
    const notebook = resolveCardNotebook(card);
    if (!notebook) {
      toast.error(t('canvas.board.openFailed'));
      return;
    }
    // Affine-style split view: the note opens beside the canvas so edits and
    // the read-only card stay visible together. Narrow (phone) viewports have
    // no side column, so they keep the full-screen navigation. A canvas that
    // already lives in the side column sends the note to the work column
    // instead of replacing its own tab.
    const destination = isNarrowViewport
      ? undefined
      : workspaceHost === 'browser-column'
        ? 'main-third' as const
        : 'browser-column' as const;
    try {
      await openNoteByNotebookPath(notebook.id, card.path, null, destination ? { destination } : undefined);
    } catch (error) {
      logger.warn('canvas board open card failed', { path: card.path, error: String(error) });
      toast.error(t('canvas.board.openFailed'));
    }
  }, [isNarrowViewport, resolveCardNotebook, t, tool, workspaceHost]);

  const handleNodeDoubleClick = useCallback<NodeMouseHandler<BoardNode>>((event, node) => {
    void event;
    void openCardNode(node);
  }, [openCardNode]);

  /** Two taps on the same node. Taps inside the touch-action:none canvas do
   *  not synthesize `dblclick` on Android, so mobile double-tap is detected
   *  from the click stream instead. */
  const lastNodeTapRef = useRef<{ id: string; at: number } | null>(null);
  const handleNodeClick = useCallback<NodeMouseHandler<BoardNode>>((event, node) => {
    void event;
    if (lastPointerTypeRef.current !== 'touch') return;
    const now = Date.now();
    const last = lastNodeTapRef.current;
    lastNodeTapRef.current = { id: node.id, at: now };
    if (last && last.id === node.id && now - last.at < 350) {
      lastNodeTapRef.current = null;
      void openCardNode(node);
    }
  }, [openCardNode]);

  /** Reset the camera to 100% around the current center (Obsidian-style). */
  const resetZoom = useCallback(() => {
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const viewport = reactFlow.getViewport();
    const flowX = (cx - viewport.x) / viewport.zoom;
    const flowY = (cy - viewport.y) / viewport.zoom;
    void reactFlow.setViewport({ x: cx - flowX, y: cy - flowY, zoom: 1 });
  }, [reactFlow]);

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
    // First real edit swaps the passthrough array for normalized values.
    document.ink = strokes;
    // Strokes are rendered as nodes now, so the graph has to be rebuilt or a
    // freshly drawn (or erased) stroke never shows up until a reopen.
    applyGraphRef.current(document);
    scheduleFlush();
    pushHistory();
  }, [pushHistory, scheduleFlush]);

  const eraseInkAt = useCallback((position: number[]) => {
    const zoom = reactFlow.getViewport().zoom;
    const kept = inkRef.current.filter((stroke) => !inkStrokeHit(stroke, position[0], position[1], zoom));
    if (kept.length !== inkRef.current.length) syncInkToDocument(kept);
  }, [reactFlow, syncInkToDocument]);

  const handleBoardPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // A pointerdown means the previous gesture ended — possibly outside the
    // board, where we never saw its pointerup. A stale fired-flag would
    // swallow a recycled pointer id's moves, so drop it unconditionally.
    longPressFiredRef.current = null;
    lastPointerTypeRef.current = event.pointerType;
    pressRef.current = {
      x: event.clientX,
      y: event.clientY,
      onElement: !!(event.target as Element).closest('.react-flow__node:not(.react-flow__node-frame)'),
    };
    // Touch long-press summons the context menu. Any element press qualifies
    // (that is exactly where the element menu is wanted); toolbar hits and
    // active text editors do not — long-press there means text selection.
    cancelLongPress();
    if (tool === 'select' && !readOnly && event.pointerType === 'touch'
      && !(event.target as Element).closest('[data-board-toolbar]')
      && !isTextEditingTarget(event.target)) {
      longPressRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        nodeElement: (event.target as Element).closest('.react-flow__node'),
        timer: window.setTimeout(() => fireLongPressRef.current(), LONG_PRESS_MS),
      };
    }
    if (tool === 'select' && !readOnly) {
      const gesture = marqueeRef.current;
      const point = { x: event.clientX, y: event.clientY };
      if (gesture) {
        // A second finger converts the rubber-band into a two-finger pan/pinch
        // (Obsidian mobile); any further fingers ride along untouched.
        if (gesture.mode === 'pan' || gesture.pointers.size >= 2) return;
        gesture.pointers.set(event.pointerId, point);
        setMarquee(null);
        gesture.mode = 'pan';
        const [a, b] = [...gesture.pointers.values()];
        gesture.startMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        gesture.startDist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        gesture.startViewport = reactFlow.getViewport();
        return;
      }
      // Presses on elements belong to them (React Flow drags the node); the
      // pane starts a rubber-band, with mouse and touch alike.
      if (pressRef.current.onElement || (event.target as Element).closest('[data-board-toolbar]')) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      marqueeRef.current = {
        pointers: new Map([[event.pointerId, point]]),
        mode: 'select',
        startFlow: flowPositionOf(event),
        // Copies: the pointers map entry is mutated on every move, and these
        // must keep holding the gesture's origin.
        startScreen: { ...point },
        startMid: { ...point },
        startDist: 1,
        startViewport: reactFlow.getViewport(),
        additive: event.shiftKey,
      };
      return;
    }
    if (readOnly || event.button !== 0) return;
    if ((event.target as Element).closest('[data-board-toolbar]')) return;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic pointers cannot capture */ }
    if (tool === 'pen') {
      liveStrokeRef.current = [flowPositionOf(event)];
      setLivePoints(liveStrokeRef.current);
      return;
    }
    if (isBoxTool(tool)) {
      const start = flowPositionOf(event);
      shapeDraftRef.current = { start, current: start };
      setShapePreview({ start, end: start });
      return;
    }
    eraseInkAt(flowPositionOf(event));
  }, [cancelLongPress, eraseInkAt, flowPositionOf, readOnly, reactFlow, tool]);

  const handleBoardPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const pendingPress = longPressRef.current;
    if (pendingPress && event.pointerId === pendingPress.pointerId) {
      pendingPress.x = event.clientX;
      pendingPress.y = event.clientY;
      if (Math.hypot(event.clientX - pendingPress.startX, event.clientY - pendingPress.startY) > LONG_PRESS_SLOP_PX) cancelLongPress();
    }
    if (longPressFiredRef.current === event.pointerId) {
      // The menu is open: swallow the rest of the gesture. Capture-phase
      // stopPropagation also keeps React Flow's node drag from ever seeing
      // the first move, so nothing drags behind the menu.
      event.stopPropagation();
      return;
    }
    if (tool === 'select') {
      const gesture = marqueeRef.current;
      if (!gesture) return;
      const tracked = gesture.pointers.get(event.pointerId);
      if (!tracked) return;
      tracked.x = event.clientX;
      tracked.y = event.clientY;
      if (gesture.mode === 'pan' && gesture.pointers.size >= 2) {
        const [a, b] = [...gesture.pointers.values()];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, gesture.startViewport.zoom * (dist / gesture.startDist)));
        // The flow point under the first midpoint stays under the current one,
        // so the canvas follows the fingers and zooms around their center.
        const anchorX = (gesture.startMid.x - gesture.startViewport.x) / gesture.startViewport.zoom;
        const anchorY = (gesture.startMid.y - gesture.startViewport.y) / gesture.startViewport.zoom;
        void reactFlow.setViewport({ x: mid.x - anchorX * zoom, y: mid.y - anchorY * zoom, zoom });
        return;
      }
      if (gesture.mode === 'select' && gesture.pointers.size === 1) {
        setMarquee({ start: gesture.startFlow, end: flowPositionOf(event) });
      }
      return;
    }
    if (readOnly) return;
    const stroke = liveStrokeRef.current;
    if (tool === 'pen' && stroke) {
      const position = flowPositionOf(event);
      const last = stroke[stroke.length - 1];
      if (Math.hypot(position[0] - last[0], position[1] - last[1]) < 1) return;
      stroke.push(position);
      setLivePoints([...stroke]);
      return;
    }
    if (isBoxTool(tool) && shapeDraftRef.current) {
      const current = flowPositionOf(event);
      const { start } = shapeDraftRef.current;
      shapeDraftRef.current.current = current;
      setShapePreview({ start, end: current });
      return;
    }
    if (tool === 'eraser' && event.buttons % 2 === 1) eraseInkAt(flowPositionOf(event));
  }, [cancelLongPress, eraseInkAt, flowPositionOf, readOnly, reactFlow, tool]);

  const handleBoardPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (longPressFiredRef.current === event.pointerId) {
      longPressFiredRef.current = null;
      cancelLongPress();
      // Swallow the lift and the click it synthesizes (same trap as the
      // rubber-band release below); the menu stays open.
      suppressPaneClickRef.current = true;
      window.setTimeout(() => { suppressPaneClickRef.current = false; }, 350);
      event.stopPropagation();
      return;
    }
    cancelLongPress();
    const gesture = marqueeRef.current;
    if (gesture && tool === 'select' && !readOnly) {
      gesture.pointers.delete(event.pointerId);
      if (gesture.mode === 'pan') {
        // A pan gesture ends once fewer than two fingers remain.
        if (gesture.pointers.size < 2) marqueeRef.current = null;
      } else {
        marqueeRef.current = null;
        setMarquee(null);
        const end = flowPositionOf(event);
        const dragged = Math.hypot(event.clientX - gesture.startScreen.x, event.clientY - gesture.startScreen.y) >= 6;
        // pointercancel has no follow-up click; only a real pointerup needs
        // its click swallowed. The timeout is a failsafe: if no click ever
        // follows (pointer released outside the window), a stuck flag would
        // eat the next legitimate tap-select.
        if (dragged && event.type === 'pointerup') {
          suppressPaneClickRef.current = true;
          window.setTimeout(() => { suppressPaneClickRef.current = false; }, 350);
        }
        if (dragged) {
          const minX = Math.min(gesture.startFlow[0], end[0]);
          const minY = Math.min(gesture.startFlow[1], end[1]);
          const maxX = Math.max(gesture.startFlow[0], end[0]);
          const maxY = Math.max(gesture.startFlow[1], end[1]);
          // Frames are backdrops, not marquee targets (they are picked by
          // clicking); everything else intersects the rect. Shift keeps the
          // existing selection, like React Flow's own rubber-band.
          setNodes((current) => current.map((node) => {
            if (node.type === 'frame') return gesture.additive ? node : (node.selected ? { ...node, selected: false } : node);
            const width = node.width ?? Number(node.style?.width ?? 0);
            const height = node.height ?? Number(node.style?.height ?? 0);
            const hit = node.position.x < maxX && node.position.x + width > minX
              && node.position.y < maxY && node.position.y + height > minY;
            if (hit) return node.selected ? node : { ...node, selected: true };
            return gesture.additive ? node : (node.selected ? { ...node, selected: false } : node);
          }));
        }
      }
    }
    const press = pressRef.current;
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) < 5 && press.onElement) {
      // A click (not a drag) on an element summons the panel.
      setPanelCollapsed(false);
    }
    pressRef.current = null;
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
        ? textShapeAt(draft.start, toolTextAlign)
        : rect.w < 24 || rect.h < 24
          ? { x: draft.start[0] - 80, y: draft.start[1] - 50, w: 160, h: 100 }
          : rect;
      const document = documentRef.current;
      if (!document) return;
      // Sticky notes and frames are cards/containers, not shapes: a click
      // (no drag) drops the Obsidian default size, a drag uses the drawn box.
      if (tool === 'sticky' || tool === 'frame') {
        const isSticky = tool === 'sticky';
        const fallback = isSticky ? DEFAULT_STICKY_SIZE : DEFAULT_FRAME_SIZE;
        const boxed = rect.w < 24 || rect.h < 24
          ? { x: draft.start[0], y: draft.start[1], w: fallback.w, h: fallback.h }
          : rect;
        const x = Math.round(boxed.x);
        const y = Math.round(boxed.y);
        const w = Math.round(Math.max(isSticky ? 80 : 120, boxed.w));
        const h = Math.round(Math.max(isSticky ? 60 : 80, boxed.h));
        if (isSticky) {
          const card: BoardCard = {
            id: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            kind: 'text',
            x,
            y,
            w,
            h,
            z: nextZ(),
            text: '',
            color: stickyColor,
            fontSize: stickyFontSize,
            fontFamily: stickyFontFamily,
            textAlign: stickyTextAlign,
            textColor: stickyTextColor,
          };
          cardsRef.current = [...cardsRef.current, card];
          document.cards = cardsRef.current;
          // Drop straight into text editing, like Obsidian's sticky tool.
          pendingEditingRef.current = card.id;
          applyGraph(document);
          scheduleFlush();
          pushHistory();
        } else {
          const frame: BoardFrame = {
            id: `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            x,
            y,
            w,
            h,
          };
          document.frames = [...readBoardFrames(document), frame];
          pendingEditingRef.current = frame.id;
          applyGraph(document);
          scheduleFlush();
          pushHistory();
        }
        if (!toolLocked) setTool('select');
        return;
      }
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
      // Arrows and lines share the two-point geometry (x/y tail, x2/y2 head);
      // only the arrowhead rendering differs.
      const shape: BoardShape = isArrow || tool === 'line'
        ? {
          id: shapeId(),
          shape: tool as BoardShapeKind,
          x: arrowStart[0],
          y: arrowStart[1],
          x2: arrowEnd[0],
          y2: arrowEnd[1],
          w: Math.abs(arrowEnd[0] - arrowStart[0]),
          h: Math.abs(arrowEnd[1] - arrowStart[1]),
          stroke: penColor,
          z: nextZ(),
          ...(toolStrokeStyle !== 'solid' ? { strokeStyle: toolStrokeStyle } : {}),
          ...(toolRoughness !== 1 ? { roughness: toolRoughness } : {}),
          ...(toolOpacity < 100 ? { opacity: toolOpacity } : {}),
        }
        : {
          id: shapeId(),
          shape: tool as BoardShapeKind,
          x: box.x,
          y: box.y,
          w: box.w,
          h: box.h,
          stroke: penColor,
          z: nextZ(),
          ...(isLabel
            ? { fontSize: toolFontSize, fontFamily: toolFontFamily, textAlign: toolTextAlign, text: '' }
            : {
                fill: toolFill,
                fillStyle: toolFillStyle,
                strokeStyle: toolStrokeStyle,
                roughness: toolRoughness,
                edges: toolEdges,
              }),
          ...(toolOpacity < 100 ? { opacity: toolOpacity } : {}),
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
      z: nextZ(),
      ...(toolPressure ? {} : { pressure: false }),
    }]);
  }, [applyGraph, cancelLongPress, commitShapeText, flowPositionOf, nextZ, penColor, penWidth, pushHistory, readOnly, scheduleFlush, syncInkToDocument, tool, toolFontFamily, toolFontSize, toolTextAlign]);

  // Native capture-phase listeners: React's synthetic pointer events never
  // reached these handlers for real touch input on Android (only synthetic
  // dispatch worked), so pen drawing silently did nothing on device.
  useEffect(() => {
    const element = boardRef.current;
    if (!element) return;
    const down = (event: PointerEvent) => handleBoardPointerDown(event as unknown as React.PointerEvent<HTMLDivElement>);
    const move = (event: PointerEvent) => handleBoardPointerMove(event as unknown as React.PointerEvent<HTMLDivElement>);
    const up = (event: PointerEvent) => handleBoardPointerUp(event as unknown as React.PointerEvent<HTMLDivElement>);
    element.addEventListener('pointerdown', down, true);
    element.addEventListener('pointermove', move, true);
    element.addEventListener('pointerup', up, true);
    element.addEventListener('pointercancel', up, true);
    // A rubber-band drag must not be undone by the click that follows its
    // pointerup (React Flow's pane click clears the selection).
    const swallowPaneClick = (event: MouseEvent) => {
      if (!suppressPaneClickRef.current) return;
      suppressPaneClickRef.current = false;
      event.stopPropagation();
      event.preventDefault();
    };
    element.addEventListener('click', swallowPaneClick, true);
    return () => {
      element.removeEventListener('pointerdown', down, true);
      element.removeEventListener('pointermove', move, true);
      element.removeEventListener('pointerup', up, true);
      element.removeEventListener('pointercancel', up, true);
      element.removeEventListener('click', swallowPaneClick, true);
    };
  }, [handleBoardPointerDown, handleBoardPointerMove, handleBoardPointerUp]);

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
        dataUrlsRef.current = dataUrls;
        storageKeysRef.current = new Map(
          readCanvasFileEntries(document.files)
            .filter((entry) => entry.storageKey)
            .map((entry) => [entry.id, entry.storageKey as string]),
        );
        lastSavedTextRef.current = text;
        moveSeedRef.current = readBoardViewport(document);
        await loadCardSummaries(document);
        await loadCardContents(document);
        applyGraph(document);
      });
    });
  }, [applyGraph, filePath, loadCardContents, loadCardSummaries, notebookPath, state.status]);

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
      if (key === 'd') { event.preventDefault(); duplicateSelection(); return; }
      // Cut and select-all are new chords (context menu parity); unlike
      // copy/paste they hijack keys other panes use, so they only fire while
      // this board is the active interaction surface.
      if ((key === 'x' || key === 'a') && getActiveCanvasSurface() !== surfaceId) return;
      if (key === 'x') { event.preventDefault(); cutSelection(); return; }
      if (key === 'a') { event.preventDefault(); selectAllElements(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [copySelection, cutSelection, duplicateSelection, pasteClipboard, selectAllElements, surfaceId]);

  /** Arrow-key nudge for selected elements. React Flow's built-in a11y
   *  movement only edits view state — positions never reached the document,
   *  so the next graph rebuild (blur, selection change) snapped elements
   *  back. Intercept the keys in capture phase, move both the view and the
   *  document, and coalesce held-key repeats into one undo entry. */
  const lastNudgeAtRef = useRef(0);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))) return;
      const selected = nodes.filter((item) => item.selected);
      if (selected.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const step = event.shiftKey ? 10 : 1;
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
      // Ink needs a drag-start record for syncPositionsToDocument to
      // translate its points; seed it lazily on the first nudge stroke.
      for (const item of selected) {
        if (item.type !== 'ink' || inkDragStartRef.current.has(item.id)) continue;
        const stroke = inkRef.current.find((entry) => entry.id === item.id);
        const box = stroke ? inkBox(stroke) : null;
        if (!stroke || !box) continue;
        inkDragStartRef.current.set(item.id, {
          boxX: box.x,
          boxY: box.y,
          points: stroke.points.map(([x, y]) => [x, y]),
        });
      }
      const selectedIds = new Set(selected.map((item) => item.id));
      const movedNodes = selected.map((item) => ({ ...item, position: { x: item.position.x + dx, y: item.position.y + dy } }));
      setNodes((current) => current.map((item) => (selectedIds.has(item.id)
        ? { ...item, position: { x: item.position.x + dx, y: item.position.y + dy } }
        : item)));
      syncPositionsToDocument(movedNodes);
      const now = Date.now();
      if (now - lastNudgeAtRef.current > 800) pushHistory();
      lastNudgeAtRef.current = now;
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [nodes, pushHistory, syncPositionsToDocument]);

  const defaultViewport = useMemo<Viewport>(
    () => initialViewport ?? { x: 0, y: 0, zoom: 1 },
    [initialViewport],
  );

  const livePath = useMemo(
    () => (livePoints && livePoints.length >= 2 ? svgPathFromStroke(getStroke(livePoints, freehandOptions(penWidth, toolPressure))) : ''),
    [livePoints, penWidth, toolPressure],
  );
  // WebView2 does not paint content overflowing a tiny SVG root (even with
  // `overflow: visible`), so the in-progress stroke gets a box sized to its
  // own bounds and a group translate maps flow coordinates into it.
  const liveBounds = useMemo(() => {
    if (!livePoints || livePoints.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of livePoints) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minX)) return null;
    const padding = 60;
    return {
      x: Math.floor(minX - padding),
      y: Math.floor(minY - padding),
      w: Math.ceil(maxX - minX + padding * 2),
      h: Math.ceil(maxY - minY + padding * 2),
    };
  }, [livePoints]);

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

  /** Right-click / long-press hit-testing: a hit on an element that is not
   *  already part of the selection re-selects exclusively; a hit inside the
   *  current selection (single or multi) keeps it, so the menu acts on all
   *  of it (Obsidian behaviour). */
  const selectNodeExclusively = useCallback((nodeId: string) => {
    if (selectedIdsRef.current.includes(nodeId)) return;
    selectedEdgeIdRef.current = null;
    setSelectedEdgeId(null);
    selectedIdsRef.current = [nodeId];
    setNodes((current) => current.map((node) => (node.selected === (node.id === nodeId)
      ? node
      : { ...node, selected: node.id === nodeId })));
  }, []);

  /** Build the item list for a request and open the shared menu shell.
   *  Mirrors Obsidian's canvas menus, reduced to what the board supports. */
  const openContextMenu = useCallback((request: BoardContextMenuRequest) => {
    const document = documentRef.current;
    if (!document) return;
    const items: BoardContextMenuItem[] = [];
    const mod = (chord: string) => formatChord(chord);
    const clipboard = clipboardRef.current;
    const hasClipboardContent = !!clipboard
      && clipboard.cards.length + clipboard.shapes.length + clipboard.ink.length > 0;
    /** Context-menu paste lands at the invoked point (not the cascade). */
    const pasteItem = (flowPoint: [number, number]) => ({
      kind: 'item' as const,
      id: 'paste',
      label: t('canvas.board.menu.paste'),
      shortcut: mod('Mod+V'),
      onSelect: () => pasteClipboard(flowPoint),
    });
    if (request.mode === 'edge') {
      items.push({ kind: 'item', id: 'delete-edge', label: t('canvas.board.edgeDelete'), onSelect: deleteSelectedEdge });
    } else if (request.mode === 'board') {
      if (!readOnly && hasClipboardContent) items.push(pasteItem(request.flowPoint));
      if (!readOnly) {
        items.push({ kind: 'separator' });
        items.push({
          kind: 'item',
          id: 'select-all',
          label: t('canvas.board.menu.selectAll'),
          shortcut: mod('Mod+A'),
          disabled: nodes.length === 0,
          onSelect: selectAllElements,
        });
      }
      items.push(
        { kind: 'separator' },
        {
          kind: 'item',
          id: 'fit-view',
          label: t('canvas.board.menu.fitView'),
          onSelect: () => void reactFlow.fitView({ padding: 0.2, maxZoom: 1.2 }),
        },
        { kind: 'item', id: 'reset-zoom', label: t('canvas.board.menu.resetZoom'), onSelect: resetZoom },
        { kind: 'separator' },
        { kind: 'item', id: 'export-svg', label: t('canvas.export.svg'), onSelect: () => void handleExport('svg') },
        { kind: 'item', id: 'export-png', label: t('canvas.export.png'), onSelect: () => void handleExport('png') },
      );
    } else {
      // Selection menu. Frames participate in delete only: they are not
      // cloned and carry no stacking slot (they render behind everything).
      const ids = selectedIdsRef.current;
      const frameIds = new Set(readBoardFrames(document).map((frame) => frame.id));
      const hasElements = ids.some((id) => !frameIds.has(id));
      if (!readOnly) {
        if (hasElements) {
          items.push(
            { kind: 'item', id: 'cut', label: t('canvas.board.menu.cut'), shortcut: mod('Mod+X'), onSelect: cutSelection },
            { kind: 'item', id: 'copy', label: t('canvas.board.menu.copy'), shortcut: mod('Mod+C'), onSelect: copySelection },
            pasteItem(request.flowPoint),
            { kind: 'separator' },
            { kind: 'item', id: 'duplicate', label: t('canvas.board.action.duplicate'), shortcut: mod('Mod+D'), onSelect: duplicateSelection },
            { kind: 'item', id: 'create-frame', label: t('canvas.board.menu.createFrame'), onSelect: createFrameFromSelection },
            { kind: 'separator' },
            { kind: 'item', id: 'layer-backward', label: t('canvas.board.layer.backward'), onSelect: () => moveSelectedLayer('backward') },
            { kind: 'item', id: 'layer-forward', label: t('canvas.board.layer.forward'), onSelect: () => moveSelectedLayer('forward') },
            { kind: 'item', id: 'layer-back', label: t('canvas.board.layer.back'), onSelect: () => moveSelectedLayer('back') },
            { kind: 'item', id: 'layer-front', label: t('canvas.board.layer.front'), onSelect: () => moveSelectedLayer('front') },
          );
        } else if (hasClipboardContent) {
          items.push(pasteItem(request.flowPoint));
        }
        items.push(
          { kind: 'separator' },
          { kind: 'item', id: 'delete', label: t('canvas.board.action.delete'), onSelect: () => removeByIds(selectedIdsRef.current) },
        );
      }
    }
    contextMenuRef.current?.open(request, items);
  }, [
    copySelection, createFrameFromSelection, cutSelection, deleteSelectedEdge, duplicateSelection,
    handleExport, moveSelectedLayer, nodes.length, pasteClipboard, readOnly, reactFlow, removeByIds,
    resetZoom, selectAllElements, t,
  ]);

  /** Touch long-press fired: open the menu at the press point and mark the
   *  gesture so its remaining events are swallowed (see longPressFiredRef). */
  const fireLongPress = useCallback(() => {
    const pending = longPressRef.current;
    longPressRef.current = null;
    if (!pending) return;
    longPressFiredRef.current = pending.pointerId;
    // Kill any rubber-band the same press had started.
    if (marqueeRef.current) {
      marqueeRef.current = null;
      setMarquee(null);
    }
    suppressNextContextMenuRef.current = true;
    window.setTimeout(() => { suppressNextContextMenuRef.current = false; }, 800);
    const nodeElement = pending.nodeElement?.isConnected ? pending.nodeElement : null;
    const nodeId = nodeElement?.getAttribute('data-id') ?? null;
    const flow = reactFlow.screenToFlowPosition({ x: pending.x, y: pending.y });
    if (nodeId) {
      selectNodeExclusively(nodeId);
      openContextMenu({ mode: 'selection', screen: { x: pending.x, y: pending.y }, flowPoint: [flow.x, flow.y] });
    } else {
      openContextMenu({ mode: 'board', screen: { x: pending.x, y: pending.y }, flowPoint: [flow.x, flow.y] });
    }
  }, [openContextMenu, reactFlow, selectNodeExclusively]);

  useEffect(() => {
    fireLongPressRef.current = fireLongPress;
  });

  /** React Flow context events. Each consumes the post-long-press suppress
   *  flag (Android's synthetic contextmenu lands on the same element the
   *  finger pressed), then opens the matching menu. */
  const handleNodeContextMenu = useCallback<NodeMouseHandler<BoardNode>>((event, node) => {
    // Right-click inside an editing text field keeps the native text menu.
    if (isTextEditingTarget(event.target)) return;
    event.preventDefault();
    if (suppressNextContextMenuRef.current) {
      suppressNextContextMenuRef.current = false;
      return;
    }
    if (readOnly) return;
    selectNodeExclusively(node.id);
    const flow = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    openContextMenu({ mode: 'selection', screen: { x: event.clientX, y: event.clientY }, flowPoint: [flow.x, flow.y] });
  }, [openContextMenu, readOnly, reactFlow, selectNodeExclusively]);

  const handlePaneContextMenu = useCallback((event: React.MouseEvent | MouseEvent) => {
    event.preventDefault();
    if (suppressNextContextMenuRef.current) {
      suppressNextContextMenuRef.current = false;
      return;
    }
    const flow = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    openContextMenu({ mode: 'board', screen: { x: event.clientX, y: event.clientY }, flowPoint: [flow.x, flow.y] });
  }, [openContextMenu, reactFlow]);

  const handleEdgeContextMenu = useCallback<EdgeMouseHandler<Edge>>((event, edge) => {
    event.preventDefault();
    if (suppressNextContextMenuRef.current) {
      suppressNextContextMenuRef.current = false;
      return;
    }
    if (readOnly) return;
    selectEdge(edge.id);
    openContextMenu({ mode: 'edge', screen: { x: event.clientX, y: event.clientY } });
  }, [openContextMenu, readOnly, selectEdge]);

  const previewShape: BoardShape | null = (() => {
    if (!shapePreview || !isShapeTool(tool)) return null;
    const [sx, sy] = shapePreview.start;
    const [ex, ey] = shapePreview.end;
    const minX = Math.min(sx, ex);
    const minY = Math.min(sy, ey);
    const twoPoint = tool === 'arrow' || tool === 'line';
    return {
      id: 'preview',
      shape: tool,
      x: twoPoint ? sx : minX,
      y: twoPoint ? sy : minY,
      w: Math.abs(ex - sx),
      h: Math.abs(ey - sy),
      ...(twoPoint ? { x2: ex, y2: ey } : {}),
      stroke: penColor,
    };
  })();

  const selectedShapes = nodes
    .filter((node) => node.type === 'shape' && selectedShapeIds.includes(node.id))
    .map((node) => node.data.shape)
    .filter((shape): shape is BoardShape => Boolean(shape));
  const selectedShapeCount = selectedShapes.length;
  const selectedStrokes = inkRef.current.filter((stroke) => selectedInkIds.includes(stroke.id));
  const selectedNodeCount = nodes.filter((node) => node.selected).length;
  const inkOnlySelection = selectedShapeCount === 0 && selectedStrokes.length > 0;
  // Any selection opens the panel (cards too); shape/ink rows are gated below.
  const selectionMode = selectedNodeCount > 0;
  const cardOnlySelection = selectionMode && selectedShapeCount === 0 && selectedStrokes.length === 0;
  const selectedStickyCards = nodes
    .filter((node) => node.type === 'sticky' && node.selected && selectedCardIds.includes(node.id))
    .map((node) => node.data.card);
  const selectedSticky = selectedStickyCards[0] ?? null;
  const stickyMode = tool === 'sticky' || selectedStickyCards.length > 0;
  /** Sticky tool without a selection: only the style rows show. */
  const stickyPlacing = tool === 'sticky' && !selectionMode;
  const styleStickyColor = selectedSticky?.color ?? stickyColor;
  const styleStickyFontSize = selectedSticky?.fontSize ?? stickyFontSize;
  const styleStickyFontFamily = selectedSticky?.fontFamily ?? stickyFontFamily;
  const styleStickyTextAlign = selectedSticky?.textAlign ?? stickyTextAlign;
  const styleStickyTextColor = selectedSticky?.textColor ?? stickyTextColor;
  const firstSelected = selectedShapes[0] ?? null;
  const firstStroke = selectedStrokes[0] ?? null;
  const allSelectedLabel = selectedShapeCount > 0 && selectedShapes.every((shape) => shape.shape === 'text');
  const styleStroke = inkOnlySelection ? firstStroke?.color ?? '#1e1e1e'
    : selectionMode ? firstSelected?.stroke ?? '#64748b' : penColor;
  const styleFill = selectionMode ? firstSelected?.fill ?? 'transparent' : toolFill;
  const styleStrokeWidth = inkOnlySelection ? firstStroke?.width ?? 5
    : selectionMode ? firstSelected?.strokeWidth ?? 2 : penWidth;
  const styleStrokeStyle = selectionMode ? firstSelected?.strokeStyle ?? 'solid' : toolStrokeStyle;
  const styleFontSize = selectionMode ? firstSelected?.fontSize ?? 20 : toolFontSize;
  const styleOpacity = selectionMode ? firstSelected?.opacity ?? 100 : toolOpacity;
  // Ink has no fill/line-style/edges; every shape-only row hides for it —
  // and sticky/frame tools draw containers, not styled shapes.
  const showFill = inkOnlySelection || cardOnlySelection ? false : selectionMode ? selectedShapes.some((shape) => shape.shape !== 'text' && shape.shape !== 'arrow' && shape.shape !== 'line') : isShapeTool(tool) && tool !== 'text' && tool !== 'arrow' && tool !== 'line';
  const showStrokeStyle = inkOnlySelection || cardOnlySelection ? false : selectionMode ? selectedShapes.some((shape) => shape.shape !== 'text') : isShapeTool(tool) && tool !== 'text';
  const showFontSize = inkOnlySelection || cardOnlySelection ? false : selectionMode ? allSelectedLabel : tool === 'text';
  const textOnlySelection = selectionMode && !cardOnlySelection && !inkOnlySelection && allSelectedLabel;
  const showFontFamily = textOnlySelection || (!selectionMode && tool === 'text');
  const showTextAlign = textOnlySelection || (!selectionMode && tool === 'text');
  const styleFontFamily = selectionMode ? firstSelected?.fontFamily ?? 'hand' : toolFontFamily;
  const styleTextAlign = selectionMode ? firstSelected?.textAlign ?? 'center' : toolTextAlign;
  const showOpacity = inkOnlySelection || cardOnlySelection ? false : selectionMode || isShapeTool(tool);
  const showFillStyle = inkOnlySelection || cardOnlySelection ? false : selectionMode ? selectedShapes.some((shape) => shape.shape === 'rect' || shape.shape === 'ellipse' || shape.shape === 'diamond') : tool === 'rect' || tool === 'ellipse' || tool === 'diamond';
  const showRoughness = inkOnlySelection || cardOnlySelection ? false : selectionMode ? selectedShapes.some((shape) => shape.shape !== 'text') : isShapeTool(tool) && tool !== 'text';
  const showEdges = inkOnlySelection || cardOnlySelection ? false : selectionMode ? selectedShapes.length > 0 && selectedShapes.every((shape) => shape.shape === 'rect') : tool === 'rect';
  const styleFillStyle = selectionMode ? firstSelected?.fillStyle ?? 'hachure' : toolFillStyle;
  const styleRoughness = selectionMode ? firstSelected?.roughness ?? 1 : toolRoughness;
  const styleEdges = selectionMode ? firstSelected?.edges ?? 'sharp' : toolEdges;
  /** Route a style change to ink or shapes depending on what is selected. */
  const applyStroke = (color: string) => {
    if (inkOnlySelection) patchSelectedInk({ color });
    else if (selectionMode) patchSelectedShapes({ stroke: color });
    else setPenColor(color);
  };
  const applyStrokeWidth = (width: number) => {
    if (inkOnlySelection) patchSelectedInk({ width });
    else if (selectionMode) patchSelectedShapes({ strokeWidth: width });
    else setPenWidth(width);
  };
  /** Sticky tint: recolours the picked sticky cards, otherwise becomes the
   *  tint of the next placed sticky (Excalidraw keeps the last used style). */
  /** Sticky text tools: recolour/resize/restyle the picked sticky cards,
   *  otherwise become the defaults of the next placed sticky. */
  const applyStickyStyle = (patch: Partial<BoardCard>) => {
    if (patch.color !== undefined) setStickyColor(patch.color as StickyColor);
    if (patch.fontSize !== undefined) setStickyFontSize(patch.fontSize);
    if (patch.fontFamily !== undefined) setStickyFontFamily(patch.fontFamily);
    if (patch.textAlign !== undefined) setStickyTextAlign(patch.textAlign);
    if (patch.textColor !== undefined) setStickyTextColor(patch.textColor);
    const ids = new Set(selectedStickyCards.map((card) => card.id));
    if (ids.size === 0) return;
    const changed = Object.entries(patch).some(([key, value]) => selectedStickyCards.some((card) => card[key as keyof BoardCard] !== value));
    if (!changed) return;
    cardsRef.current = cardsRef.current.map((card) => (ids.has(card.id) ? { ...card, ...patch } : card));
    const document = documentRef.current;
    if (!document) return;
    document.cards = cardsRef.current;
    applyGraph(document);
    scheduleFlush();
    pushHistory();
  };

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
      ref={boardRef}
      // Touch gestures must reach the canvas instead of scrolling the shell.
      style={{ touchAction: 'none' }}
      className={`h-full min-h-0 w-full ${tool === 'hand' ? 'cursor-grab' : tool !== 'select' ? 'cursor-crosshair' : ''}`}
      data-canvas-surface={filePath}
      // The board owns pan/zoom gestures; the shell's swipe-down must not steal them.
      data-mobile-swipe-ignore="true"
      onDoubleClick={handleSurfaceDoubleClick}
      // The board fully owns the context menu (React Flow context events +
      // long-press); never let the WebView's native menu appear here — except
      // inside active text editors, where the native text menu applies. React
      // Flow's own handlers run deeper in the tree and consume the suppress
      // flag before this catch-all fires.
      onContextMenu={(event) => {
        if (isTextEditingTarget(event.target)) return;
        event.preventDefault();
        cancelLongPress();
      }}
      onPaste={(event) => {
        const images = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'));
        if (images.length === 0) return;
        event.preventDefault();
        const viewport = reactFlow.getViewport();
        const rect = boardRef.current?.getBoundingClientRect();
        const flowX = rect ? (rect.width / 2 - viewport.x) / viewport.zoom : 0;
        const flowY = rect ? (rect.height / 2 - viewport.y) / viewport.zoom : 0;
        void insertImageFiles(images, flowX, flowY);
      }}
      onDragOver={(event) => {
        if ([...(event.dataTransfer?.items ?? [])].some((item) => item.kind === 'file')) event.preventDefault();
      }}
      onDrop={(event) => {
        const files = [...(event.dataTransfer?.files ?? [])].filter((file) => file.type.startsWith('image/'));
        if (files.length === 0) return;
        event.preventDefault();
        const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        void insertImageFiles(files, position.x, position.y);
      }}
    >
      <div data-board-toolbar className="absolute left-3 top-3 z-30 flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--card)] p-1 shadow-sm">
        <Tooltip content={t('canvas.board.tool.select')} shortcut="canvas.tool.select" side="bottom">
          <button type="button" aria-label={t('canvas.board.tool.select')} className={toolButtonClass(tool === 'select')} onClick={() => selectTool('select')}>
            <MousePointer2 className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
        <Tooltip content={t('canvas.board.tool.hand')} shortcut="canvas.tool.hand" side="bottom">
          <button type="button" aria-label={t('canvas.board.tool.hand')} className={toolButtonClass(tool === 'hand')} onClick={() => selectTool('hand')}>
            <Hand className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
        <Tooltip content={t('canvas.board.tool.pen')} shortcut="canvas.tool.pen" side="bottom">
          <button type="button" aria-label={t('canvas.board.tool.pen')} className={toolButtonClass(tool === 'pen')} onClick={() => selectTool('pen')}>
            <Pencil className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
        <Tooltip content={t('canvas.board.tool.eraser')} shortcut="canvas.tool.eraser" side="bottom">
          <button type="button" aria-label={t('canvas.board.tool.eraser')} className={toolButtonClass(tool === 'eraser')} onClick={() => selectTool('eraser')}>
            <Eraser className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
        {SHAPE_TOOLS.map((shapeKind) => (
          <Tooltip key={shapeKind} content={t(`canvas.board.tool.${shapeKind}`)} shortcut={`canvas.tool.${shapeKind}`} side="bottom">
            <button
              type="button"
              aria-label={t(`canvas.board.tool.${shapeKind}`)}
              className={toolButtonClass(tool === shapeKind)}
              onClick={() => selectTool(shapeKind)}
            >
              {shapeKind === 'rect' ? <Square className="h-3.5 w-3.5" />
                : shapeKind === 'ellipse' ? <Circle className="h-3.5 w-3.5" />
                  : shapeKind === 'diamond' ? <Diamond className="h-3.5 w-3.5" />
                    : shapeKind === 'arrow' ? <ArrowUpRight className="h-3.5 w-3.5" />
                      : shapeKind === 'line' ? <Minus className="h-3.5 w-3.5" />
                        : <Type className="h-3.5 w-3.5" />}
            </button>
          </Tooltip>
        ))}
        <Tooltip content={t('canvas.board.tool.sticky')} shortcut="canvas.tool.sticky" side="bottom">
          <button
            type="button"
            aria-label={t('canvas.board.tool.sticky')}
            className={toolButtonClass(tool === 'sticky')}
            onClick={() => selectTool('sticky')}
          >
            <StickyNote className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
        <Tooltip content={t('canvas.board.tool.note')} side="bottom">
          <button
            type="button"
            aria-label={t('canvas.board.tool.note')}
            className={toolButtonClass(false)}
            disabled={readOnly}
            onClick={() => setInsertDialogOpen(true)}
          >
            <FileText className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
        {selectedEdgeId ? (
          <Tooltip content={t('canvas.board.edgeDelete')} side="bottom">
            <button
              type="button"
              aria-label={t('canvas.board.edgeDelete')}
              className={toolButtonClass(false)}
              disabled={readOnly}
              onClick={deleteSelectedEdge}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        ) : null}
        <Tooltip content={t('canvas.board.tool.fit')} side="bottom">
          <button
            type="button"
            aria-label={t('canvas.board.tool.fit')}
            className={toolButtonClass(false)}
            onClick={() => { void reactFlow.fitView({ padding: 0.2, maxZoom: 1.2 }); }}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
        <Tooltip content={t('canvas.board.tool.lock')} side="bottom">
          <button
            type="button"
            aria-label={t('canvas.board.tool.lock')}
            aria-pressed={toolLocked}
            className={toolButtonClass(toolLocked)}
            onClick={() => setToolLocked((locked) => !locked)}
          >
            {toolLocked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
          </button>
        </Tooltip>
        {/* Infrequent tools live behind the … overflow (Obsidian-style): the
            frame tool, image import, and the export actions. The trigger
            highlights while the frame tool is engaged so its active state is
            still visible even though its own button is in the menu. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={t('canvas.board.tool.more')} className={toolButtonClass(tool === 'frame')}>
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[150px]">
            {/* The shared menu item has no built-in gap, so icon+label rows
                space themselves (otherwise the icon touches the text). */}
            <DropdownMenuItem className="gap-2" onClick={() => selectTool('frame')}>
              <FrameIcon className="h-3.5 w-3.5 shrink-0" />
              {t('canvas.board.tool.frame')}
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2" onClick={() => { void pickImages(); }}>
              <ImagePlus className="h-3.5 w-3.5 shrink-0" />
              {t('canvas.board.tool.image')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-2" onClick={() => { void handleExport('svg'); }}>
              <Download className="h-3.5 w-3.5 shrink-0" />
              {t('canvas.export.svg')}
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2" onClick={() => { void handleExport('png'); }}>
              <Download className="h-3.5 w-3.5 shrink-0" />
              {t('canvas.export.png')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {/* Explicit save + FNS sync (Ctrl+S shares the same path via the
          document.saveAndSync handler). The board pointer handlers ignore
          clicks on [data-board-toolbar], so the button never starts a marquee.
          Narrow viewports drop the chip one row below the toolbar: the tool
          row already overflows the screen edge, so sharing its corner would
          cover the clipped fit/lock/more buttons. */}
      {!readOnly ? (
        <div data-board-toolbar className={`absolute right-3 z-30 ${isNarrowViewport ? 'top-14' : 'top-3'}`}>
          <Tooltip content={t('canvas.board.save')} shortcut="document.saveAndSync" side="bottom">
            <button
              type="button"
              aria-label={t('canvas.board.save')}
              className="relative flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)] shadow-sm transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:pointer-events-none disabled:opacity-60"
              disabled={saveBusy}
              onClick={() => { void saveAndSync(); }}
            >
              {saveBusy ? <Loader2 className="h-3.5 w-3.5 flowix-spin" /> : <Save className="h-3.5 w-3.5" />}
              {saveDirty && !saveBusy ? (
                <span aria-hidden="true" className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--brand)]" />
              ) : null}
            </button>
          </Tooltip>
        </div>
      ) : null}
      <div className="absolute bottom-4 left-3 z-30 flex max-h-[calc(100%-120px)] flex-col items-start gap-2">
        {(tool === 'pen' || isShapeTool(tool) || stickyMode || selectionMode) && !panelCollapsed ? (
        <div
          data-board-toolbar
          className="flex min-h-0 w-[184px] flex-col gap-2.5 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--card)] p-2.5 shadow-sm"
        >
          {stickyMode ? (
          <PanelRow label={t('canvas.board.sticky.color')}>
            {STICKY_COLORS.map((entry) => (
              <button
                key={entry.value}
                type="button"
                aria-label={`${t('canvas.board.sticky.color')} ${entry.value}`}
                onClick={() => applyStickyStyle({ color: entry.value })}
                className={`h-5 w-5 rounded-[4px] border ${styleStickyColor === entry.value ? 'border-[var(--foreground)] ring-2 ring-[var(--foreground)]/30' : 'border-transparent'}`}
                style={{ backgroundColor: entry.background }}
              />
            ))}
          </PanelRow>
          ) : null}
          {stickyMode ? (
          <PanelRow label={t('canvas.board.style.font')}>
            <button
              type="button"
              aria-label={t('canvas.board.style.fontHand')}
              aria-pressed={styleStickyFontFamily === 'hand'}
              onClick={() => applyStickyStyle({ fontFamily: 'hand' })}
              className={toolButtonClass(styleStickyFontFamily === 'hand')}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <div
              className="relative"
              onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as HTMLElement | null)) setStickyFontMenuOpen(false); }}
            >
              <button
                type="button"
                aria-label={t('canvas.board.style.fontMenu')}
                aria-expanded={stickyFontMenuOpen}
                className={`${toolButtonClass(stickyFontMenuOpen)} flex items-center gap-0.5`}
                onClick={() => setStickyFontMenuOpen((open) => !open)}
              >
                <span style={{ fontFamily: TEXT_FONTS[styleStickyFontFamily], fontWeight: TEXT_FONT_WEIGHTS[styleStickyFontFamily] }}>A</span>
                <ChevronUp className="h-2.5 w-2.5" />
              </button>
              {stickyFontMenuOpen ? (
                <div className="absolute bottom-full left-0 z-40 mb-1 w-28 rounded-lg border border-[var(--border)] bg-[var(--card)] p-1 shadow-md">
                  {TEXT_FONT_KEYS.map((key) => {
                    const label = t(FONT_LABEL_KEYS[key]);
                    return (
                      <button
                        key={key}
                        type="button"
                        aria-label={label}
                        onClick={() => { applyStickyStyle({ fontFamily: key }); setStickyFontMenuOpen(false); }}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[var(--foreground)] hover:bg-[var(--muted)] ${styleStickyFontFamily === key ? 'bg-[var(--muted)]' : ''}`}
                      >
                        <span className="w-4 text-center text-[13px]" style={{ fontFamily: TEXT_FONTS[key], fontWeight: TEXT_FONT_WEIGHTS[key] }}>A</span>
                        <span className="truncate">{label}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </PanelRow>
          ) : null}
          {stickyMode ? (
          <PanelRow label={t('canvas.board.style.fontSize')}>
            {FONT_SIZES.map((size, index) => (
              <button
                key={size}
                type="button"
                aria-label={`${t('canvas.board.style.fontSize')} ${FONT_SIZE_LABELS[index]}`}
                onClick={() => applyStickyStyle({ fontSize: size })}
                className={`${toolButtonClass(styleStickyFontSize === size)} w-7 text-[10px]`}
              >
                {FONT_SIZE_LABELS[index]}
              </button>
            ))}
          </PanelRow>
          ) : null}
          {stickyMode ? (
          <PanelRow label={t('canvas.board.style.textAlign')}>
            {TEXT_ALIGNS.map((align) => (
              <button
                key={align}
                type="button"
                aria-label={t(`canvas.board.textAlign.${align}`)}
                onClick={() => applyStickyStyle({ textAlign: align })}
                className={toolButtonClass(styleStickyTextAlign === align)}
              >
                <span className={`flex w-3.5 flex-col gap-[3px] ${align === 'left' ? 'items-start' : align === 'right' ? 'items-end' : 'items-center'}`}>
                  <span className="block h-[2px] w-full bg-current" />
                  <span className="block h-[2px] w-2/3 bg-current" />
                  <span className="block h-[2px] w-full bg-current" />
                </span>
              </button>
            ))}
          </PanelRow>
          ) : null}
          {stickyMode ? (
          <PanelRow label={t('canvas.board.style.textColor')}>
            {INK_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={`${t('canvas.board.style.textColor')} ${color}`}
                onClick={() => applyStickyStyle({ textColor: color })}
                className={`h-5 w-5 rounded-[4px] border ${styleStickyTextColor === color ? 'border-[var(--foreground)] ring-2 ring-[var(--foreground)]/30' : 'border-transparent'}`}
                style={{ backgroundColor: color }}
              />
            ))}
          </PanelRow>
          ) : null}
          {!cardOnlySelection && !stickyPlacing ? (
          <PanelRow label={t('canvas.board.style.stroke')}>
            <div className="flex flex-wrap items-center gap-1.5">
              {INK_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-label={`${t('canvas.board.style.stroke')} ${color}`}
                  onClick={() => applyStroke(color)}
                  className={`h-5 w-5 rounded-[4px] border ${styleStroke === color ? 'border-[var(--foreground)] ring-2 ring-[var(--foreground)]/30' : 'border-transparent'}`}
                  style={{ backgroundColor: color }}
                />
              ))}
              <span className="ml-auto block h-6 w-6 rounded-md border border-[var(--border)]" style={{ backgroundColor: styleStroke }} />
            </div>
          </PanelRow>
          ) : null}
          {showFill ? (
            <PanelRow label={t('canvas.board.style.background')}>
              <div className="flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  aria-label={t('canvas.board.style.backgroundTransparent')}
                  onClick={() => (selectionMode ? patchSelectedShapes({ fill: 'transparent' }) : setToolFill('transparent'))}
                  className={`h-5 w-5 rounded-[4px] border ${styleFill === 'transparent' ? 'border-[var(--foreground)] ring-2 ring-[var(--foreground)]/30' : 'border-[var(--border)]'} bg-[var(--card)]`}
                  style={{ backgroundImage: 'linear-gradient(135deg, transparent 45%, var(--muted-foreground) 45%, var(--muted-foreground) 55%, transparent 55%)' }}
                />
                {FILL_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-label={`${t('canvas.board.style.background')} ${color}`}
                    onClick={() => (selectionMode ? patchSelectedShapes({ fill: color }) : setToolFill(color))}
                    className={`h-5 w-5 rounded-[4px] border ${styleFill === color ? 'border-[var(--foreground)] ring-2 ring-[var(--foreground)]/30' : 'border-[var(--border)]'}`}
                    style={{ backgroundColor: color }}
                  />
                ))}
                <span className="ml-auto block h-6 w-6 rounded-md border border-[var(--border)]" style={{ backgroundColor: styleFill === 'transparent' ? 'var(--card)' : styleFill }} />
              </div>
            </PanelRow>
          ) : null}
          {showFillStyle ? (
            <PanelRow label={t('canvas.board.style.fill')}>
              <div className="flex items-center gap-1">
                {FILL_STYLES.map((style) => (
                  <button
                    key={style}
                    type="button"
                    aria-label={t(`canvas.board.fillStyle.${style}`)}
                    onClick={() => (selectionMode ? patchSelectedShapes({ fillStyle: style }) : setToolFillStyle(style))}
                    className={toolButtonClass(styleFillStyle === style)}
                  >
                    <span
                      className="block h-3.5 w-3.5 rounded-sm border border-current"
                      style={style === 'solid'
                        ? { backgroundColor: 'currentColor' }
                        : { backgroundImage: style === 'hachure'
                            ? 'repeating-linear-gradient(45deg, currentColor 0 1px, transparent 1px 4px)'
                            : 'repeating-linear-gradient(45deg, currentColor 0 1px, transparent 1px 3px), repeating-linear-gradient(-45deg, currentColor 0 1px, transparent 1px 3px)' }}
                    />
                  </button>
                ))}
              </div>
            </PanelRow>
          ) : null}
          {textOnlySelection || cardOnlySelection || stickyPlacing ? null : (
          <PanelRow label={t('canvas.board.style.strokeWidth')}>
            {(inkOnlySelection || (selectionMode ? false : tool === 'pen') ? INK_WIDTHS : STROKE_WIDTHS).map((width) => (
              <button
                key={width}
                type="button"
                aria-label={`${t('canvas.board.style.strokeWidth')} ${width}`}
                onClick={() => applyStrokeWidth(width)}
                className={toolButtonClass(styleStrokeWidth === width)}
              >
                <span className="block rounded-full bg-current" style={{ width: width + 3, height: width + 3 }} />
              </button>
            ))}
          </PanelRow>
          )}
          {tool === 'pen' ? (
            <PanelRow label={t('canvas.board.style.pressure')}>
              <button
                type="button"
                aria-label={t('canvas.board.style.pressureOn')}
                aria-pressed={toolPressure}
                className={toolButtonClass(toolPressure)}
                onClick={() => setToolPressure(true)}
              >
                <Waves className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label={t('canvas.board.style.pressureOff')}
                aria-pressed={!toolPressure}
                className={toolButtonClass(!toolPressure)}
                onClick={() => setToolPressure(false)}
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
            </PanelRow>
          ) : null}
          {showRoughness ? (
            <PanelRow label={t('canvas.board.style.roughness')}>
              {ROUGHNESS_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  aria-label={`${t('canvas.board.style.roughness')} ${level}`}
                  onClick={() => (selectionMode ? patchSelectedShapes({ roughness: level }) : setToolRoughness(level))}
                  className={toolButtonClass(styleRoughness === level)}
                >
                  {level === 0 ? <Minus className="h-3.5 w-3.5" /> : level === 1 ? <span className="block w-3.5 border-t-2 border-current" style={{ transform: 'rotate(-8deg)' }} /> : <Waves className="h-3.5 w-3.5" />}
                </button>
              ))}
            </PanelRow>
          ) : null}
          {showEdges ? (
            <PanelRow label={t('canvas.board.style.edges')}>
              <button
                type="button"
                aria-label={t('canvas.board.style.edgesSharp')}
                onClick={() => (selectionMode ? patchSelectedShapes({ edges: 'sharp' }) : setToolEdges('sharp'))}
                className={toolButtonClass(styleEdges === 'sharp')}
              >
                <span className="block h-3.5 w-3.5 rounded-none border-2 border-current" />
              </button>
              <button
                type="button"
                aria-label={t('canvas.board.style.edgesRound')}
                onClick={() => (selectionMode ? patchSelectedShapes({ edges: 'round' }) : setToolEdges('round'))}
                className={toolButtonClass(styleEdges === 'round')}
              >
                <span className="block h-3.5 w-3.5 rounded-[6px] border-2 border-current" />
              </button>
            </PanelRow>
          ) : null}
          {showStrokeStyle ? (
            <PanelRow label={t('canvas.board.style.strokeType')}>
              {STROKE_STYLES.map((style) => (
                <button
                  key={style}
                  type="button"
                  aria-label={t(`canvas.board.style.${style}`)}
                  onClick={() => (selectionMode ? patchSelectedShapes({ strokeStyle: style }) : setToolStrokeStyle(style))}
                  className={toolButtonClass(styleStrokeStyle === style)}
                >
                  <span className="block w-4 border-t-2 border-current" style={{ borderTopStyle: style }} />
                </button>
              ))}
            </PanelRow>
          ) : null}
          {showFontFamily ? (
            <PanelRow label={t('canvas.board.style.font')}>
              <button
                type="button"
                aria-label={t('canvas.board.style.fontHand')}
                aria-pressed={styleFontFamily === 'hand'}
                onClick={() => (selectionMode ? patchSelectedShapes({ fontFamily: 'hand' }) : setToolFontFamily('hand'))}
                className={toolButtonClass(styleFontFamily === 'hand')}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <div
                className="relative"
                onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as HTMLElement | null)) setFontMenuOpen(false); }}
              >
                <button
                  type="button"
                  aria-label={t('canvas.board.style.fontMenu')}
                  aria-expanded={fontMenuOpen}
                  className={`${toolButtonClass(fontMenuOpen)} flex items-center gap-0.5`}
                  onClick={() => setFontMenuOpen((open) => !open)}
                >
                  <span style={{ fontFamily: TEXT_FONTS[styleFontFamily], fontWeight: TEXT_FONT_WEIGHTS[styleFontFamily] }}>A</span>
                  <ChevronUp className="h-2.5 w-2.5" />
                </button>
                {fontMenuOpen ? (
                  <div className="absolute bottom-full left-0 z-40 mb-1 w-28 rounded-lg border border-[var(--border)] bg-[var(--card)] p-1 shadow-md">
                    {TEXT_FONT_KEYS.map((key) => {
                      const label = t(FONT_LABEL_KEYS[key]);
                      return (
                        <button
                          key={key}
                          type="button"
                          aria-label={label}
                          onClick={() => {
                            if (selectionMode) patchSelectedShapes({ fontFamily: key });
                            else setToolFontFamily(key);
                            setFontMenuOpen(false);
                          }}
                          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[var(--foreground)] hover:bg-[var(--muted)] ${styleFontFamily === key ? 'bg-[var(--muted)]' : ''}`}
                        >
                          <span className="w-4 text-center text-[13px]" style={{ fontFamily: TEXT_FONTS[key], fontWeight: TEXT_FONT_WEIGHTS[key] }}>A</span>
                          <span className="truncate">{label}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </PanelRow>
          ) : null}
          {showFontSize ? (
            <PanelRow label={t('canvas.board.style.fontSize')}>
              {FONT_SIZES.map((size, index) => (
                <button
                  key={size}
                  type="button"
                  aria-label={`${t('canvas.board.style.fontSize')} ${FONT_SIZE_LABELS[index]}`}
                  onClick={() => (selectionMode ? patchSelectedShapes({ fontSize: size }) : setToolFontSize(size))}
                  className={`${toolButtonClass(styleFontSize === size)} w-7 text-[10px]`}
                >
                  {FONT_SIZE_LABELS[index]}
                </button>
              ))}
            </PanelRow>
          ) : null}
          {showTextAlign ? (
            <PanelRow label={t('canvas.board.style.textAlign')}>
              {TEXT_ALIGNS.map((align) => (
                <button
                  key={align}
                  type="button"
                  aria-label={t(`canvas.board.textAlign.${align}`)}
                  onClick={() => (selectionMode ? patchSelectedShapes({ textAlign: align }) : setToolTextAlign(align))}
                  className={toolButtonClass(styleTextAlign === align)}
                >
                  <span className={`flex w-3.5 flex-col gap-[3px] ${align === 'left' ? 'items-start' : align === 'right' ? 'items-end' : 'items-center'}`}>
                    <span className="block h-[2px] w-full bg-current" />
                    <span className="block h-[2px] w-2/3 bg-current" />
                    <span className="block h-[2px] w-full bg-current" />
                  </span>
                </button>
              ))}
            </PanelRow>
          ) : null}
          {showOpacity ? (
            <div>
              <div className="mb-1 text-[10px] leading-none text-[var(--muted-foreground)]">{t('canvas.board.style.transparency')}</div>
              <input
                type="range"
                min={5}
                max={100}
                step={5}
                value={styleOpacity}
                onChange={(event) => (selectionMode ? patchSelectedShapes({ opacity: Number(event.target.value) }, false) : setToolOpacity(Number(event.target.value)))}
                onPointerUp={() => pushHistory()}
                onKeyUp={() => pushHistory()}
                className="w-full accent-[var(--foreground)]"
              />
              <div className="mt-1 flex justify-between text-[10px] leading-none text-[var(--muted-foreground)]">
                <span>0</span>
                <span>100</span>
              </div>
            </div>
          ) : null}
          {selectionMode && selectedShapeCount >= 2 ? (
            <PanelRow label={t('canvas.board.align.title')}>
              <div className="flex flex-wrap items-center gap-1">
                {([
                  ['left', AlignStartVertical], ['hcenter', AlignCenterVertical], ['right', AlignEndVertical],
                  ['top', AlignStartHorizontal], ['vcenter', AlignCenterHorizontal], ['bottom', AlignEndHorizontal],
                ] as const).map(([mode, Icon]) => (
                  <button
                    key={mode}
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
              </div>
            </PanelRow>
          ) : null}
          {selectionMode ? (
            <PanelRow label={t('canvas.board.layer.title')}>
              <div className="flex items-center gap-1">
                {([
                  ['back', ArrowDownToLine], ['backward', ArrowDown], ['forward', ArrowUp], ['front', ArrowUpToLine],
                ] as const).map(([layer, Icon]) => (
                  <button
                    key={layer}
                    type="button"
                    aria-label={t(`canvas.board.layer.${layer}`)}
                    className={toolButtonClass(false)}
                    onClick={() => moveSelectedLayer(layer)}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                ))}
              </div>
            </PanelRow>
          ) : null}
          {selectionMode ? (
            <PanelRow label={t('canvas.board.action.title')}>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={t('canvas.board.action.duplicate')}
                  className={toolButtonClass(false)}
                  onClick={duplicateSelection}
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={t('canvas.board.action.delete')}
                  className={toolButtonClass(false)}
                  onClick={() => removeByIds(selectedIdsRef.current)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={t('canvas.board.action.link')}
                  aria-pressed={linkEditing}
                  className={toolButtonClass(linkEditing)}
                  onClick={() => { setLinkDraft(firstSelected?.link ?? ''); setLinkEditing((editing) => !editing); }}
                >
                  <Link2 className="h-3.5 w-3.5" />
                </button>
              </div>
              {linkEditing ? (
                <input
                  autoFocus
                  value={linkDraft}
                  placeholder="https://..."
                  onChange={(event) => setLinkDraft(event.target.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') { patchSelectedShapes({ link: linkDraft.trim() || undefined }); setLinkEditing(false); }
                    if (event.key === 'Escape') setLinkEditing(false);
                  }}
                  onBlur={() => { patchSelectedShapes({ link: linkDraft.trim() || undefined }); setLinkEditing(false); }}
                  className="mt-1.5 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-xs text-[var(--foreground)] outline-none"
                />
              ) : null}
            </PanelRow>
          ) : null}
        </div>
        ) : null}
        <div className="flex items-center gap-2">
          <div data-board-toolbar className="flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--card)] p-1 shadow-sm">
            <button
              type="button"
              aria-label={t('canvas.board.panel.toggle')}
              aria-pressed={!panelCollapsed}
              className={toolButtonClass(!panelCollapsed)}
              onClick={() => setPanelCollapsed((collapsed) => !collapsed)}
            >
              <Palette className="h-3.5 w-3.5" />
            </button>
            {!panelCollapsed ? (
              <>
                <button
                  type="button"
                  aria-label={t('canvas.board.action.duplicate')}
                  className={toolButtonClass(false)}
                  disabled={!selectionMode}
                  onClick={duplicateSelection}
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={t('canvas.board.action.delete')}
                  className={toolButtonClass(false)}
                  disabled={!selectionMode}
                  onClick={() => removeByIds(selectedIdsRef.current)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
                <div className="mx-1 h-5 w-px bg-[var(--border)]" />
              </>
            ) : null}
            <button type="button" aria-label={t('canvas.board.tool.undo')} className={toolButtonClass(false)} disabled={historyDepth.index <= 0} onClick={undo}>
              <Undo2 className="h-3.5 w-3.5" />
            </button>
            <button type="button" aria-label={t('canvas.board.tool.redo')} className={toolButtonClass(false)} disabled={historyDepth.index >= historyDepth.length - 1} onClick={redo}>
              <Redo2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <div data-board-toolbar className="flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--card)] p-1 shadow-sm">
            <button type="button" aria-label={t('canvas.board.zoom.out')} className={toolButtonClass(false)} onClick={() => { void reactFlow.zoomOut({ duration: 150 }); }}>
              <Minus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              aria-label={t('canvas.board.zoom.reset')}
              onClick={resetZoom}
              className="w-11 rounded-md px-1 py-1 text-center text-[11px] tabular-nums text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button type="button" aria-label={t('canvas.board.zoom.in')} className={toolButtonClass(false)} onClick={() => { void reactFlow.zoomIn({ duration: 150 }); }}>
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
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
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={handleNodesChange}
        onNodeDragStart={handleNodeDragStart}
        onNodeDragStop={handleNodeDragStop}
        // The pane does not scroll natively, so the shared menu's scroll-close
        // never fires: dismiss the context menu on any pan/zoom under it.
        onMove={() => contextMenuRef.current?.close()}
        onMoveEnd={handleMoveEnd}
        onNodeDoubleClick={handleNodeDoubleClick}
        onNodeClick={handleNodeClick}
        defaultViewport={defaultViewport}
        fitView={!initialViewport}
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={ZOOM_MIN}
        maxZoom={ZOOM_MAX}
        // d3-zoom's built-in double-click-zoom calls stopImmediatePropagation
        // on the pane, which kills the board's onDoubleClick before it ever
        // reaches the "double-click drops a text element" handler. A board
        // never zooms on double-click (Obsidian drops a card there instead).
        zoomOnDoubleClick={false}
        // The hand tool pans and pinches through React Flow. In select mode
        // RF's d3 gestures are fully off (its filter cannot express "one
        // finger selects, two fingers pan" — turning pan off rejects the
        // whole touch stream), so the rubber-band and the two-finger
        // pan/pinch are implemented in the board's pointer handlers above.
        panOnDrag={tool === 'hand'}
        selectionOnDrag={false}
        zoomOnPinch={tool === 'hand'}
        // Generous snap radius for landing a connection near a handle
        // (default 20) — the main touch-friendliness lever on the drop side.
        connectionRadius={40}
        // Selected nodes must not jump above others, or layer ordering looks broken.
        elevateNodesOnSelect={false}
        nodesDraggable={!readOnly && tool === 'select'}
        nodesConnectable={!readOnly && tool === 'select'}
        // Elements stay clickable even with a drawing tool active, so
        // selecting always switches the panel to the right element type.
        elementsSelectable={true}
        onConnect={handleConnect}
        onlyRenderVisibleElements
        // Both keys delete: many keyboards label Backspace "Del", so users
        // pressing the key they see must get the same behavior. (RF ignores
        // key events aimed at inputs/editors, so typing is unaffected.)
        deleteKeyCode={['Delete', 'Backspace']}
        onNodesDelete={handleNodesDelete}
        onEdgesDelete={handleEdgesDelete}
        onEdgeClick={(_event, edge) => selectEdge(edge.id)}
        onPaneClick={() => selectEdge(null)}
        onNodeContextMenu={handleNodeContextMenu}
        onPaneContextMenu={handlePaneContextMenu}
        onEdgeContextMenu={handleEdgeContextMenu}
        // A stationary touch press must not start a node drag (it would freeze
        // mid-gesture once the long-press menu opens and the board starts
        // swallowing the gesture). Align the threshold with the long-press
        // slop so "press + drift within slop + hold" still opens the menu and
        // "press + real move" still drags; fine pointers stay at the default.
        nodeDragThreshold={isCoarsePointer ? LONG_PRESS_SLOP_PX : 1}
        onSelectionChange={handleSelectionChange}
      >
        {/* Plain whiteboard background: the board is a canvas, not a grid sheet. */}
        <ViewportPortal>
          {marquee ? (() => {
            const [sx, sy] = marquee.start;
            const [ex, ey] = marquee.end;
            const x = Math.min(sx, ex);
            const y = Math.min(sy, ey);
            const w = Math.abs(ex - sx);
            const h = Math.abs(ey - sy);
            return (
              <svg
                style={{
                  position: 'absolute',
                  left: x - 1,
                  top: y - 1,
                  width: w + 2,
                  height: h + 2,
                  pointerEvents: 'none',
                }}
              >
                <rect
                  x={1}
                  y={1}
                  width={Math.max(0, w)}
                  height={Math.max(0, h)}
                  fill="color-mix(in srgb, var(--foreground) 6%, transparent)"
                  stroke="var(--foreground)"
                  strokeDasharray="4 3"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            );
          })() : null}
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
                {previewShape.shape === 'arrow' || previewShape.shape === 'line' ? (
                  <path
                    d={roughLineSketch(previewShape.x, previewShape.y, previewShape.x2 ?? previewShape.x, previewShape.y2 ?? previewShape.y, previewShape, { preview: true }).d}
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
          {/* Committed strokes render as selectable nodes; only the in-progress
              stroke needs this portal layer. */}
          {livePath && liveBounds ? (
            <svg
              style={{
                position: 'absolute',
                left: liveBounds.x,
                top: liveBounds.y,
                zIndex: INK_Z_INDEX,
                width: liveBounds.w,
                height: liveBounds.h,
                pointerEvents: 'none',
              }}
            >
              <g transform={`translate(${-liveBounds.x},${-liveBounds.y})`}>
                <path d={livePath} fill={penColor} />
              </g>
            </svg>
          ) : null}
        </ViewportPortal>
      </ReactFlow>
      <CanvasBoardContextMenu ref={contextMenuRef} />
      <NoteCardInsertDialog
        open={insertDialogOpen}
        onClose={() => setInsertDialogOpen(false)}
        onInsert={insertNoteCard}
      />
    </div>
  );
}
