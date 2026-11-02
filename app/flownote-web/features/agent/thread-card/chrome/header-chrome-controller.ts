import type { EditorView } from "@tiptap/pm/view";
import {
  cancelBlockDragForView,
  dropBlockDragAtForView,
  startBlockDragForView,
  updateBlockDragPositionForView,
} from "@features/editor/extensions/block-drag";
import {
  getEventElement,
  isAgentThreadCardInteractiveTarget,
} from "@features/agent/thread-card/agent-thread-card-dom";
import {
  createBlockDragPreview,
  removeBlockDragPreview,
  updateBlockDragPreview,
  type BlockDragPreview,
} from "@features/editor/components/drag-context-menu/block-drag-preview";

interface HeaderDragState {
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  started: boolean;
}

export interface AgentThreadCardHeaderChromeControllerOptions {
  dom: HTMLElement;
  header: HTMLDivElement;
  view: EditorView;
  getPos: () => number | undefined;
  getNodeSize: () => number;
  isFullscreen: () => boolean;
  closeTransientUi: () => void;
  dragThresholdPx: number;
}

export class AgentThreadCardHeaderChromeController {
  private readonly dom: HTMLElement;
  private readonly header: HTMLDivElement;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;
  private readonly getNodeSize: () => number;
  private readonly isFullscreen: () => boolean;
  private readonly closeTransientUi: () => void;
  private readonly dragThresholdPx: number;
  private dragState: HeaderDragState | null = null;
  private dragPreview: BlockDragPreview | null = null;
  private moveFrame: number | null = null;
  private suppressNextHeaderClick = false;

  constructor(options: AgentThreadCardHeaderChromeControllerOptions) {
    this.dom = options.dom;
    this.header = options.header;
    this.view = options.view;
    this.getPos = options.getPos;
    this.getNodeSize = options.getNodeSize;
    this.isFullscreen = options.isFullscreen;
    this.closeTransientUi = options.closeTransientUi;
    this.dragThresholdPx = options.dragThresholdPx;
  }

  attach(): void {
    this.header.addEventListener("pointerdown", this.handlePointerDown);
    this.header.addEventListener("pointermove", this.handlePointerMove);
    this.header.addEventListener("pointerup", this.handlePointerUp);
    this.header.addEventListener("pointercancel", this.handlePointerCancel);
    this.header.addEventListener("lostpointercapture", this.handleLostPointerCapture);
    this.header.addEventListener("click", this.handleClick, true);
  }

  dispose(): void {
    this.header.removeEventListener("pointerdown", this.handlePointerDown);
    this.header.removeEventListener("pointermove", this.handlePointerMove);
    this.header.removeEventListener("pointerup", this.handlePointerUp);
    this.header.removeEventListener("pointercancel", this.handlePointerCancel);
    this.header.removeEventListener("lostpointercapture", this.handleLostPointerCapture);
    this.header.removeEventListener("click", this.handleClick, true);
    this.cancelScheduledMove();
    if (this.dragState) {
      cancelBlockDragForView(this.view);
      this.releasePointerCapture(this.dragState.pointerId);
      this.dragState = null;
    }
    this.clearDragVisuals();
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.isFullscreen()) return;
    const target = getEventElement(event);
    if (!target || !this.header.contains(target)) return;
    if (isAgentThreadCardInteractiveTarget(target)) return;

    this.dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
      started: false,
    };
    this.header.setPointerCapture(event.pointerId);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const drag = this.dragState;
    if (!drag || drag.pointerId !== event.pointerId) return;

    drag.currentX = event.clientX;
    drag.currentY = event.clientY;

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.started) {
      if (Math.hypot(dx, dy) < this.dragThresholdPx) return;
      const pos = this.getPos();
      if (pos === undefined) {
        this.dragState = null;
        this.releasePointerCapture(event.pointerId);
        return;
      }
      if (
        !startBlockDragForView(this.view, {
          pos,
          nodeSize: this.getNodeSize(),
        })
      ) {
        this.dragState = null;
        this.releasePointerCapture(event.pointerId);
        return;
      }
      drag.started = true;
      this.dom.classList.add("agent-thread-card--dragging");
      document.documentElement.classList.add("flownote-block-dragging");
      this.dragPreview = createBlockDragPreview(this.dom, event.clientX, event.clientY);
      this.closeTransientUi();
    }

    event.preventDefault();
    event.stopPropagation();
    this.scheduleDragUpdate();
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    const drag = this.dragState;
    if (!drag || drag.pointerId !== event.pointerId) return;

    this.dragState = null;
    if (drag.started) {
      this.cancelScheduledMove();
      dropBlockDragAtForView(this.view, event.clientX, event.clientY);
      this.finishDragInteraction();
      event.preventDefault();
      event.stopPropagation();
    }
    this.releasePointerCapture(event.pointerId);
  };

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    const drag = this.dragState;
    if (!drag || drag.pointerId !== event.pointerId) return;

    this.dragState = null;
    if (drag.started) {
      this.cancelScheduledMove();
      cancelBlockDragForView(this.view);
      this.finishDragInteraction();
      event.preventDefault();
      event.stopPropagation();
    }
    this.releasePointerCapture(event.pointerId);
  };

  private readonly handleLostPointerCapture = (event: PointerEvent): void => {
    this.handlePointerCancel(event);
  };

  private readonly handleClick = (event: MouseEvent): void => {
    if (!this.suppressNextHeaderClick) return;
    this.suppressNextHeaderClick = false;
    event.preventDefault();
    event.stopPropagation();
  };

  private releasePointerCapture(pointerId: number): void {
    if (this.header.hasPointerCapture(pointerId)) {
      this.header.releasePointerCapture(pointerId);
    }
  }

  private scheduleDragUpdate(): void {
    if (this.moveFrame !== null) return;
    this.moveFrame = window.requestAnimationFrame(() => {
      this.moveFrame = null;
      const drag = this.dragState;
      if (!drag?.started) return;
      updateBlockDragPreview(this.dragPreview, drag.currentX, drag.currentY);
      updateBlockDragPositionForView(this.view, drag.currentX, drag.currentY);
    });
  }

  private cancelScheduledMove(): void {
    if (this.moveFrame === null) return;
    window.cancelAnimationFrame(this.moveFrame);
    this.moveFrame = null;
  }

  private clearDragVisuals(): void {
    removeBlockDragPreview(this.dragPreview);
    this.dragPreview = null;
    this.dom.classList.remove("agent-thread-card--dragging");
    document.documentElement.classList.remove("flownote-block-dragging");
  }

  private finishDragInteraction(): void {
    this.clearDragVisuals();
    this.suppressNextHeaderClick = true;
    window.setTimeout(() => {
      this.suppressNextHeaderClick = false;
    }, 0);
  }
}
