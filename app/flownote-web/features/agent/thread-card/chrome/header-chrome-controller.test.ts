import { beforeEach, describe, expect, it, vi } from "vitest";

const dragMocks = vi.hoisted(() => ({
  cancelBlockDragForView: vi.fn(),
  dropBlockDragAtForView: vi.fn(),
  startBlockDragForView: vi.fn(() => true),
  updateBlockDragPositionForView: vi.fn(),
}));

vi.mock("@features/editor/extensions/block-drag", () => dragMocks);

import { AgentThreadCardHeaderChromeController } from "./header-chrome-controller";

function pointerEvent(
  type: string,
  target: EventTarget,
  options: { button?: number; pointerId?: number; clientX?: number; clientY?: number } = {},
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: options.button ?? 0 },
    pointerId: { value: options.pointerId ?? 1 },
    clientX: { value: options.clientX ?? 0 },
    clientY: { value: options.clientY ?? 0 },
  });
  target.dispatchEvent(event);
}

function setupController() {
  const editorRoot = document.createElement("div");
  editorRoot.className = "ProseMirror";
  editorRoot.contentEditable = "true";
  const dom = document.createElement("section");
  dom.className = "agent-thread-card";
  dom.contentEditable = "false";
  const header = document.createElement("div");
  const title = document.createElement("div");
  title.className = "agent-thread-card__title";
  header.append(title);
  dom.append(header);
  editorRoot.append(dom);
  document.body.append(editorRoot);

  Object.defineProperties(header, {
    setPointerCapture: { value: vi.fn() },
    hasPointerCapture: { value: vi.fn(() => false) },
    releasePointerCapture: { value: vi.fn() },
  });

  const controller = new AgentThreadCardHeaderChromeController({
    dom,
    header,
    view: { isDestroyed: false } as never,
    getPos: () => 10,
    getNodeSize: () => 20,
    isFullscreen: () => false,
    closeTransientUi: vi.fn(),
    dragThresholdPx: 4,
  });
  controller.attach();

  return { controller, dom, header, title };
}

describe("AgentThreadCardHeaderChromeController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts and drops a block drag when dragging from the title", async () => {
    const { controller, title } = setupController();

    pointerEvent("pointerdown", title, { clientX: 10, clientY: 20 });
    pointerEvent("pointermove", title, { clientX: 10, clientY: 30 });
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
    pointerEvent("pointerup", title, { clientX: 10, clientY: 80 });

    expect(dragMocks.startBlockDragForView).toHaveBeenCalledWith(
      expect.anything(),
      { pos: 10, nodeSize: 20 },
    );
    expect(dragMocks.updateBlockDragPositionForView).toHaveBeenCalledWith(
      expect.anything(),
      10,
      30,
    );
    expect(dragMocks.dropBlockDragAtForView).toHaveBeenCalledWith(
      expect.anything(),
      10,
      80,
    );

    controller.dispose();
  });
});
