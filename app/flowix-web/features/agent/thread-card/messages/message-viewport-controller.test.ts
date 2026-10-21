import { describe, expect, it, vi } from "vitest";
import { MessageViewportController } from "@features/agent/thread-card/messages/message-viewport-controller";

function createController() {
  const body = document.createElement("div");
  Object.defineProperties(body, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 1000 },
  });

  return {
    body,
    controller: new MessageViewportController({
      body,
      bottomFollowThresholdPx: 64,
      topHistoryLoadThresholdPx: 64,
      scrollDeltaEpsilonPx: 2,
      isCollapsed: () => false,
      isFullscreen: () => false,
      getRuntimeThreadId: () => null,
      getConversationMessageState: () => null,
      loadMoreMessages: vi.fn(),
    }),
  };
}

describe("MessageViewportController run-end scroll behavior", () => {
  it("preserves an upward reading position when streaming ends", () => {
    const { body, controller } = createController();
    body.scrollTop = 300;
    controller.handleScroll();

    const scrollState = controller.captureRenderScrollState();
    body.scrollTop = 0;
    controller.applyAfterRender({ isLoading: false, ...scrollState });

    expect(body.scrollTop).toBe(300);
  });

  it("continues following the bottom when the user was already there", () => {
    const { body, controller } = createController();
    body.scrollTop = 600;
    controller.handleScroll();

    const scrollState = controller.captureRenderScrollState();
    body.scrollTop = 0;
    controller.applyAfterRender({ isLoading: false, ...scrollState });

    expect(body.scrollTop).toBe(1000);
  });

  it("detaches from the bottom on a small upward wheel gesture", () => {
    const { body, controller } = createController();
    body.scrollTop = 600;
    controller.handleScroll();

    controller.handleUserScrollIntent(-12);
    const scrollState = controller.captureRenderScrollState();
    body.scrollTop = 0;
    controller.applyAfterRender({ isLoading: true, ...scrollState });

    expect(body.scrollTop).toBe(600);
  });
});


it("does not restore a request-time position after a failed history load", () => {
  const body = document.createElement("div");
  Object.defineProperties(body, { clientHeight: { value: 100 }, scrollHeight: { value: 1000 } });
  const loadMore = vi.fn();
  const controller = new MessageViewportController({
    body, bottomFollowThresholdPx: 64, topHistoryLoadThresholdPx: 48, scrollDeltaEpsilonPx: 0.5,
    isCollapsed: () => false, isFullscreen: () => true, getRuntimeThreadId: () => "thread",
    getConversationMessageState: () => ({ loadingMore: false, hasMoreHistory: true, oldestSequence: 10 }),
    loadMoreMessages: loadMore,
  });
  body.scrollTop = 20;
  controller.handleScroll();
  expect(loadMore).toHaveBeenCalledOnce();
  // The failed request changed no rows. A later update must preserve the
  // reader's new position, rather than the position when the request began.
  body.scrollTop = 250;
  controller.handleScroll();
  controller.applyAfterRender({ isLoading: false, ...controller.captureRenderScrollState() });
  expect(body.scrollTop).toBe(250);
});
