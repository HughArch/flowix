import type { AgentTypeKey } from "@/types/agent";
import { createLogger } from "@/lib/logger";

import { loadAgentThreadCardCache } from "@features/agent/thread-card/agent-thread-card-cache";

const logger = createLogger("agent-thread-cache");

export interface ThreadCacheControllerOptions {
  element: HTMLElement;
  isDestroyed: () => boolean;
  getThreadId: () => string | null;
  getTypeKey: () => AgentTypeKey;
  getMessageCount: () => number;
  shouldLoad: () => boolean;
  render: () => void;
  applyResolvedSession: (
    threadId: string,
    sessionId: string,
    typeKey: AgentTypeKey,
  ) => void;
}

export class ThreadCacheController {
  private readonly element: HTMLElement;
  private readonly isDestroyed: () => boolean;
  private readonly getThreadId: () => string | null;
  private readonly getTypeKey: () => AgentTypeKey;
  private readonly getMessageCount: () => number;
  private readonly shouldLoad: () => boolean;
  private readonly render: () => void;
  private readonly applyResolvedSession: (
    threadId: string,
    sessionId: string,
    typeKey: AgentTypeKey,
  ) => void;

  private loading = false;
  private loadedFor: string | null = null;
  private loadEligible = false;
  private loadingFor: string | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private idleId: number | null = null;
  private visibilityObserver: IntersectionObserver | null = null;
  private viewportReady =
    typeof window === "undefined" || !("IntersectionObserver" in window);

  constructor(options: ThreadCacheControllerOptions) {
    this.element = options.element;
    this.isDestroyed = options.isDestroyed;
    this.getThreadId = options.getThreadId;
    this.getTypeKey = options.getTypeKey;
    this.getMessageCount = options.getMessageCount;
    this.shouldLoad = options.shouldLoad;
    this.render = options.render;
    this.applyResolvedSession = options.applyResolvedSession;
  }

  get isLoading(): boolean {
    return this.loading;
  }

  isPresentationHidden(): boolean {
    return (
      !!this.getThreadId() &&
      this.getMessageCount() === 0 &&
      this.loading
    );
  }

  requestIfNeeded(): void {
    if (this.shouldLoad()) {
      // A collapsed/hidden -> open transition is a consistency boundary.
      // Keep the rendered cache visible, but allow one silent snapshot check.
      if (!this.loadEligible) this.loadedFor = null;
      this.loadEligible = true;
      this.scheduleLoad();
      return;
    }
    this.loadEligible = false;
    this.cancelScheduledLoad();
  }

  observeVisibility(): void {
    if (
      this.viewportReady ||
      this.visibilityObserver ||
      typeof window === "undefined" ||
      !("IntersectionObserver" in window)
    ) {
      return;
    }

    this.visibilityObserver = new IntersectionObserver(
      (entries) => {
        if (this.isDestroyed() || !entries.some((entry) => entry.isIntersecting)) {
          return;
        }

        this.viewportReady = true;
        this.visibilityObserver?.disconnect();
        this.visibilityObserver = null;
        this.requestIfNeeded();
      },
      { root: null, rootMargin: "600px 0px", threshold: 0 },
    );
    this.visibilityObserver.observe(this.element);
  }

  canLoadForViewport(isFullscreen: boolean): boolean {
    return this.viewportReady || isFullscreen;
  }

  dispose(): void {
    this.cancelScheduledLoad();
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = null;
  }

  private scheduleLoad(): void {
    const threadId = this.getThreadId();
    if (!threadId || this.isDestroyed() || !this.shouldLoad()) return;
    if (this.loadedFor === threadId || this.loadingFor === threadId) return;

    this.loadingFor = threadId;
    this.loading = true;
    this.render();

    const run = async (): Promise<void> => {
      try {
        if (!this.isDestroyed() && this.getThreadId() === threadId) {
          const typeKey = this.getTypeKey();
          const result = await loadAgentThreadCardCache({ threadId, typeKey });
          if (this.isDestroyed() || this.getThreadId() !== threadId) return;
          if (result.resolvedSessionId) {
            this.applyResolvedSession(threadId, result.resolvedSessionId, typeKey);
          }
          this.loadedFor = threadId;
        }
      } catch (error) {
        logger.error("Failed to load thread history", { error: String(error) });
      } finally {
        if (this.loadingFor === threadId) {
          this.loadingFor = null;
          this.loading = false;
        }
        if (!this.isDestroyed() && this.getThreadId() === threadId) this.render();
      }
    };

    if ("requestIdleCallback" in window) {
      this.idleId = window.requestIdleCallback(
        () => {
          this.idleId = null;
          void run();
        },
        { timeout: 1200 },
      );
    } else {
      this.timeoutId = globalThis.setTimeout(() => {
        this.timeoutId = null;
        void run();
      }, 300);
    }
  }

  private cancelScheduledLoad(): void {
    const hadScheduledLoad = this.timeoutId !== null || this.idleId !== null;
    if (this.timeoutId !== null) {
      globalThis.clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (this.idleId !== null && "cancelIdleCallback" in window) {
      window.cancelIdleCallback(this.idleId);
      this.idleId = null;
    }
    if (hadScheduledLoad && this.loadingFor) {
      this.loadingFor = null;
      this.loading = false;
      this.render();
    }
  }
}
