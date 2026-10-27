/** Observation-only timing trace for one document-open transaction. */

import { invoke } from '@tauri-apps/api/core';

// One invocation per open keeps the probe from competing with the work it
// measures. `-1` is the trace-independent bucket for module-load notes.
const pendingMirror = new Map<number, Record<string, unknown>[]>();
let mirrorFlushTimer: number | null = null;

function flushMirror(transitionId?: number): void {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
  const ids = transitionId === undefined ? [...pendingMirror.keys()] : [transitionId];
  for (const id of ids) {
    const entries = pendingMirror.get(id);
    if (!entries || entries.length === 0) continue;
    pendingMirror.delete(id);
    // One invocation per open keeps the bridge from competing with the work it
    // measures; the whole run travels as a single log line.
    void invoke('record_frontend_trace', {
      event: 'perf.open_doc_trace',
      message: JSON.stringify({ transitionId: id, entries }),
    }).catch(() => undefined);
  }
  if (transitionId === undefined) {
    if (mirrorFlushTimer !== null) window.clearTimeout(mirrorFlushTimer);
    mirrorFlushTimer = null;
  }
}

/** Queue a mark for the native app.log (WebView console is ephemeral). */
function mirrorToNativeLog(transitionId: number, phase: string, payload: Record<string, unknown>): void {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
  const entries = pendingMirror.get(transitionId) ?? [];
  entries.push({ phase, ...payload });
  pendingMirror.set(transitionId, entries);
  if (phase === 'editor:first-visible-frame') {
    flushMirror(transitionId);
    return;
  }
  mirrorFlushTimer ??= window.setTimeout(() => flushMirror(), 3_000);
}

interface OpenDocumentTrace {
  startedAt: number;
  lastAt: number;
}

const traces = new Map<number, OpenDocumentTrace>();
const TRACE_RETENTION_MS = 30_000;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function writeTrace(
  transitionId: number,
  phase: string,
  trace: OpenDocumentTrace,
  meta?: Record<string, unknown>,
): void {
  const timestamp = now();
  const payload = {
    transitionId,
    phase,
    elapsedMs: round(timestamp - trace.startedAt),
    deltaMs: round(timestamp - trace.lastAt),
    // Absolute clock so marks emitted outside the trace (module loads) align.
    atPerf: round(timestamp),
    ...meta,
  };
  console.info('[perf:open-doc-trace]', payload);
  mirrorToNativeLog(transitionId, phase, payload);
  trace.lastAt = timestamp;
}

/**
 * Trace-independent mark for work that happens outside a navigation (lazy
 * module loads). `atPerf` aligns it with `writeTrace` marks.
 */
export function recordOpenPerfNote(phase: string, meta?: Record<string, unknown>): void {
  const payload = { phase, atPerf: round(now()), ...meta };
  console.info('[perf:open-doc-trace]', payload);
  mirrorToNativeLog(-1, phase, payload);
}

/**
 * Trace-independent long-task probe. Main-thread work that hides behind a
 * mark's delta (render passes, module evaluation) shows up here instead.
 */
export function observeLongTasks(): void {
  if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        recordOpenPerfNote('main-thread:long-task', {
          atPerf: round(entry.startTime + entry.duration),
          startPerf: round(entry.startTime),
          durationMs: round(entry.duration),
          name: entry.name,
        });
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    // Browser without long-task reporting; the trace marks still work.
  }
}

let longTasksObserved = false;

export function startDocumentOpenTrace(
  transitionId: number | null | undefined,
  meta?: Record<string, unknown>,
): void {
  if (!longTasksObserved) {
    longTasksObserved = true;
    observeLongTasks();
  }
  if (transitionId === null || transitionId === undefined) return;

  const timestamp = now();
  const trace = { startedAt: timestamp, lastAt: timestamp };
  traces.set(transitionId, trace);
  writeTrace(transitionId, 'navigation:start', trace, meta);

  window.setTimeout(() => {
    if (traces.get(transitionId) === trace) traces.delete(transitionId);
  }, TRACE_RETENTION_MS);
}

export function markDocumentOpenTrace(
  transitionId: number | null | undefined,
  phase: string,
  meta?: Record<string, unknown>,
): void {
  if (transitionId === null || transitionId === undefined) return;

  const trace = traces.get(transitionId);
  if (!trace) {
    const timestamp = now();
    const fallback = { startedAt: timestamp, lastAt: timestamp };
    traces.set(transitionId, fallback);
    writeTrace(transitionId, phase, fallback, { traceStartedLate: true, ...meta });
    return;
  }

  writeTrace(transitionId, phase, trace, meta);
}
