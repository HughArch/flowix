/** Opt in from DevTools: globalThis.__FLOWIX_AGENT_VIEWPORT_TRACE__ = [];
 * Set to undefined to disable. Geometry reads occur only while enabled.
 * No message content or filesystem paths are collected.
 */
interface ViewportSnapshot {
  connected: boolean;
  rowCount: number;
  visibleRowCount: number;
  listHeight: number;
  listTop: number | null;
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
}

interface ViewportTrace {
  kind: "history-request" | "render";
  at: number;
  viewportId: number;
  before: ViewportSnapshot;
  after?: ViewportSnapshot;
  messageCount?: number;
  durationMs?: number;
}

type TraceGlobal = typeof globalThis & {
  __FLOWIX_AGENT_VIEWPORT_TRACE__?: ViewportTrace[];
};

const viewportIds = new WeakMap<HTMLElement, number>();
let nextViewportId = 1;

function viewportId(body: HTMLElement): number {
  let id = viewportIds.get(body);
  if (id === undefined) {
    id = nextViewportId++;
    viewportIds.set(body, id);
  }
  return id;
}

function traceBuffer(): ViewportTrace[] | undefined {
  const buffer = (globalThis as TraceGlobal).__FLOWIX_AGENT_VIEWPORT_TRACE__;
  return Array.isArray(buffer) ? buffer : undefined;
}

function snapshot(body: HTMLElement): ViewportSnapshot {
  const list = body.querySelector<HTMLElement>(":scope > .agent-thread-card__messages");
  const bounds = list?.getBoundingClientRect();
  const viewport = body.getBoundingClientRect();
  let visibleRowCount = 0;
  if (list) {
    for (const row of Array.from(list.children)) {
      const rowBounds = row.getBoundingClientRect();
      if (rowBounds.bottom > viewport.top && rowBounds.top < viewport.bottom) visibleRowCount += 1;
    }
  }
  return {
    connected: body.isConnected,
    rowCount: list?.childElementCount ?? 0,
    visibleRowCount,
    listHeight: bounds?.height ?? 0,
    listTop: bounds ? bounds.top - viewport.top : null,
    scrollTop: body.scrollTop,
    scrollHeight: body.scrollHeight,
    viewportHeight: body.clientHeight,
  };
}

function append(buffer: ViewportTrace[], entry: ViewportTrace): void {
  buffer.push(entry);
  if (buffer.length > 120) buffer.splice(0, buffer.length - 120);
}

export function traceMessageViewport(body: HTMLElement): void {
  const buffer = traceBuffer();
  if (buffer) append(buffer, { kind: "history-request", at: performance.now(), viewportId: viewportId(body), before: snapshot(body) });
}

export function beginMessageRenderTrace(body: HTMLElement, messageCount: number): (() => void) | undefined {
  const buffer = traceBuffer();
  if (!buffer) return undefined;
  const before = snapshot(body);
  const startedAt = performance.now();
  return () => {
    const durationMs = performance.now() - startedAt;
    append(buffer, {
      kind: "render", at: startedAt, viewportId: viewportId(body), messageCount,
      before, after: snapshot(body), durationMs,
    });
  };
}
