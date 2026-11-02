import { afterEach, describe, expect, it, vi } from "vitest";
import { readHistoryWithTimeout, HISTORY_READ_TIMEOUT_MS } from "@features/agent/services/history-read-timeout";
import type { ChatMessage } from "@/types";
import { loadAgentThreadCardCache } from "@features/agent/thread-card/agent-thread-card-cache";
import { ThreadCacheController } from "@features/agent/thread-card/messages/thread-cache-controller";

vi.mock("@features/agent/thread-card/agent-thread-card-cache", () => ({
  loadAgentThreadCardCache: vi.fn(async () => ({
    resolvedSessionId: null,
    loadedThreadId: "thread-1",
    messages: [],
  })),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ThreadCacheController", () => {
  it("releases loading and permits retry when the reader deadline expires", async () => {
    vi.useFakeTimers();
    let idleCallback: IdleRequestCallback | undefined;
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn((callback: IdleRequestCallback) => {
        idleCallback = callback;
        return 1;
      }),
    );
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    vi.mocked(loadAgentThreadCardCache).mockImplementationOnce(
      () => readHistoryWithTimeout(() => new Promise(() => {})),
    );

    const render = vi.fn();
    const controller = new ThreadCacheController({
      element: document.createElement("div"),
      isDestroyed: () => false,
      getThreadId: () => "thread-1",
      getTypeKey: () => "codex",
      getMessageCount: () => 0,
      shouldLoad: () => true,
      render,
      applyResolvedSession: vi.fn(),
    });

    controller.requestIfNeeded();
    idleCallback?.({ didTimeout: false, timeRemaining: () => 50 });
    expect(controller.isLoading).toBe(true);
    expect(render).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(HISTORY_READ_TIMEOUT_MS);

    expect(controller.isLoading).toBe(false);
    expect(render).toHaveBeenCalledTimes(2);
    controller.requestIfNeeded();
    idleCallback?.({ didTimeout: false, timeRemaining: () => 50 });
    await vi.advanceTimersByTimeAsync(0);
    expect(loadAgentThreadCardCache).toHaveBeenCalledTimes(2);
    expect(controller.isLoading).toBe(false);
    controller.dispose();
  });

  it("schedules visible history loading while idle", async () => {
    let idleCallback: IdleRequestCallback | undefined;
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      idleCallback = callback;
      return 1;
    });
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", vi.fn());

    const render = vi.fn();
    const controller = new ThreadCacheController({
      element: document.createElement("div"),
      isDestroyed: () => false,
      getThreadId: () => "thread-1",
      getTypeKey: () => "codex",
      getMessageCount: () => 0,
      shouldLoad: () => true,
      render,
      applyResolvedSession: vi.fn(),
    });

    controller.requestIfNeeded();
    expect(loadAgentThreadCardCache).not.toHaveBeenCalled();
    expect(requestIdleCallback).toHaveBeenCalledTimes(1);

    idleCallback?.({
      didTimeout: false,
      timeRemaining: () => 50,
    });

    await vi.waitFor(() =>
      expect(loadAgentThreadCardCache).toHaveBeenCalledTimes(1),
    );
    expect(loadAgentThreadCardCache).toHaveBeenCalledWith({
      threadId: "thread-1",
      typeKey: "codex",
    });

    await vi.waitFor(() => expect(controller.isLoading).toBe(false));
    expect(controller.isLoading).toBe(false);
    expect(render).toHaveBeenCalled();

    controller.dispose();
  });

  it("applies resolved session metadata and renders from the canonical history", async () => {
    let idleCallback: IdleRequestCallback | undefined;
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn((callback: IdleRequestCallback) => {
        idleCallback = callback;
        return 1;
      }),
    );
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    const pendingLoad: {
      resolve?: (value: {
        resolvedSessionId: string;
        loadedThreadId: string;
        messages: ChatMessage[];
      }) => void;
    } = {};
    vi.mocked(loadAgentThreadCardCache).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          pendingLoad.resolve = resolve;
        }),
    );

    const messages = [{ id: "message-1" }] as ChatMessage[];
    const callOrder: string[] = [];
    const applyResolvedSession = vi.fn(() => {
      callOrder.push("apply");
    });
    const controller = new ThreadCacheController({
      element: document.createElement("div"),
      isDestroyed: () => false,
      getThreadId: () => "thread-1",
      getTypeKey: () => "codex",
      getMessageCount: () => 0,
      shouldLoad: () => true,
      render: vi.fn(),
      applyResolvedSession,
    });

    controller.requestIfNeeded();
    idleCallback?.({
      didTimeout: false,
      timeRemaining: () => 50,
    });
    await vi.waitFor(() =>
      expect(loadAgentThreadCardCache).toHaveBeenCalledTimes(1),
    );
    pendingLoad.resolve?.({
      resolvedSessionId: "session-1",
      loadedThreadId: "session-1",
      messages,
    });

    await vi.waitFor(() =>
      expect(applyResolvedSession).toHaveBeenCalledWith(
        "thread-1",
        "session-1",
        "codex",
      ),
    );
    expect(callOrder).toEqual(["apply"]);

    controller.dispose();
  });
});


it("allows another load after history fails without marking the thread loaded", async () => {
  let idleCallback: IdleRequestCallback | undefined;
  vi.stubGlobal("requestIdleCallback", vi.fn((callback: IdleRequestCallback) => { idleCallback = callback; return 1; }));
  vi.stubGlobal("cancelIdleCallback", vi.fn());
  vi.mocked(loadAgentThreadCardCache).mockRejectedValueOnce(new Error("offline"));
  const controller = new ThreadCacheController({
    element: document.createElement("div"), isDestroyed: () => false,
    getThreadId: () => "thread-1", getTypeKey: () => "codex", getMessageCount: () => 0,
    shouldLoad: () => true, render: vi.fn(), applyResolvedSession: vi.fn(),
  });
  controller.requestIfNeeded();
  idleCallback?.({ didTimeout: false, timeRemaining: () => 50 });
  await vi.waitFor(() => expect(controller.isLoading).toBe(false));
  controller.requestIfNeeded();
  idleCallback?.({ didTimeout: false, timeRemaining: () => 50 });
  await vi.waitFor(() => expect(loadAgentThreadCardCache).toHaveBeenCalledTimes(2));
  controller.dispose();
});
