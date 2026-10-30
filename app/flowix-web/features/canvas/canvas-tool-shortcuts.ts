/**
 * 画布工具快捷键表 — 单一来源。
 *
 * 两处消费:
 *  - `features/shortcuts/actions.ts` 据此注册 action (裸键 + `no-input` scope
 *    + `when: isCanvasSurfaceActive`)。
 *  - 画布组件据此 `pushHandler` 真正的工具切换逻辑, 并在工具栏 Tooltip 里
 *    显示对应按键。
 *
 * 键位对齐 Obsidian Canvas / Excalidraw, 保持同一套肌肉记忆:
 *   V 选择  H 抓手  P 画笔  E 橡皮
 *   R 矩形  O 圆形  D 菱形  A 箭头  T 文字
 *   N 便签  F 画框
 */

/** 与 `BoardTool` 中的工具子集保持一致 (不依赖组件文件, 避免循环引用)。 */
export type CanvasToolShortcutTarget =
  | 'select'
  | 'hand'
  | 'pen'
  | 'eraser'
  | 'rect'
  | 'ellipse'
  | 'diamond'
  | 'arrow'
  | 'text'
  | 'sticky'
  | 'frame';

export interface CanvasToolShortcut {
  /** actions.ts 中注册的 actionId。 */
  actionId: string;
  /** 默认裸键 (单字符, 小写)。 */
  key: string;
  /** 触发后切换到的工具。 */
  tool: CanvasToolShortcutTarget;
}

export const CANVAS_TOOL_SHORTCUTS: readonly CanvasToolShortcut[] = [
  { actionId: 'canvas.tool.select', key: 'v', tool: 'select' },
  { actionId: 'canvas.tool.hand', key: 'h', tool: 'hand' },
  { actionId: 'canvas.tool.pen', key: 'p', tool: 'pen' },
  { actionId: 'canvas.tool.eraser', key: 'e', tool: 'eraser' },
  { actionId: 'canvas.tool.rect', key: 'r', tool: 'rect' },
  { actionId: 'canvas.tool.ellipse', key: 'o', tool: 'ellipse' },
  { actionId: 'canvas.tool.diamond', key: 'd', tool: 'diamond' },
  { actionId: 'canvas.tool.arrow', key: 'a', tool: 'arrow' },
  { actionId: 'canvas.tool.text', key: 't', tool: 'text' },
  { actionId: 'canvas.tool.sticky', key: 'n', tool: 'sticky' },
  { actionId: 'canvas.tool.frame', key: 'f', tool: 'frame' },
] as const;

/** actionId -> 工具, 供画布 handler 注册时查表。 */
export const CANVAS_TOOL_BY_ACTION: ReadonlyMap<string, CanvasToolShortcutTarget> =
  new Map(CANVAS_TOOL_SHORTCUTS.map((entry) => [entry.actionId, entry.tool]));

/** 工具栏按钮的 Tooltip 文案 key (`canvas.board.tool.<tool>`)。 */
export const canvasToolLabelKey = (tool: CanvasToolShortcutTarget): string =>
  `canvas.board.tool.${tool}`;
