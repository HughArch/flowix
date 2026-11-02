import type { BoardShape, BoardShapeKind } from './model';

/** Fraction of the shape box the label may occupy (per axis). Ellipse and
 *  diamond labels are constrained to the inscribed rectangle so the text
 *  never crosses the curved or slanted outline; rect labels span the box. */
export const SHAPE_LABEL_FACTORS: Partial<Record<BoardShapeKind, number>> = {
  ellipse: 1 / Math.SQRT2,
  diamond: 0.5,
};

/** Wrap width for a label that must stay inside the drawn outline (the
 *  ellipse/diamond inscribed rectangle); null wraps at the node container
 *  (rects, text elements, arrows and lines). */
export function shapeLabelWidth(shape: Pick<BoardShape, 'shape' | 'w'>): number | null {
  const factor = SHAPE_LABEL_FACTORS[shape.shape];
  if (!factor) return null;
  return Math.max(24, Math.round(shape.w * factor) - 8);
}

/** Re-measure slack. After a grow, the recomputed usable height is the grown
 *  height times the factor — with an irrational factor (ellipse) floating-
 *  point dust can land that an ulp below the content height, and without
 *  slack the grow would chase itself forever (observed as a frozen app on
 *  circles). Half a pixel is far above the dust and far below perception. */
const GROW_SLACK_PX = 0.5;

/** Height the label editor grows a shape to when its label no longer fits
 *  the usable band, or null when it fits. Returns the node-box height
 *  (shape + selection-ring padding); callers center that box on the shape.
 *
 *  Closed shapes grow so the label fits the inscribed rectangle implied by
 *  `SHAPE_LABEL_FACTORS` (full box for rects, 1/√2 for ellipses, 1/2 for
 *  diamonds — the same width the label wraps at). Text elements just hug
 *  their content: their visible bounds are the selection ring. Arrows and
 *  lines keep their two-point geometry and never grow. */
export function shapeGrowBoxHeight(
  kind: BoardShapeKind,
  shapeHeight: number,
  contentH: number,
  nodePadding: number,
): number | null {
  if (kind === 'text') {
    return contentH + 2 > shapeHeight + nodePadding * 2 ? contentH + 2 : null;
  }
  const factor = SHAPE_LABEL_FACTORS[kind];
  if (kind !== 'rect' && !factor) return null;
  const f = factor ?? 1;
  if (contentH > shapeHeight * f - 8 + GROW_SLACK_PX) {
    return Math.round((contentH + 8) / f) + nodePadding * 2;
  }
  return null;
}
