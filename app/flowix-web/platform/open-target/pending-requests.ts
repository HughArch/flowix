import { invoke } from '@tauri-apps/api/core';
import { subscribe, type UnlistenFn } from '@platform/tauri/event-bus';
import { createLogger } from '@/lib/logger';

export type OpenTargetConsumer = 'path' | 'external-documents';
export type PendingOpenTarget = {
  id: string;
  target:
    | { kind: 'path'; path: string }
    | { kind: 'external-documents'; filePaths: string[] }
    | { kind: 'error'; message: string };
};

const logger = createLogger('open-target');
// Serialize deliveries across effect cleanup/remount while an open is still in flight.
const deliveries = new Map<OpenTargetConsumer, Promise<void>>();

/** Events are wakeups. Snapshot + acknowledgement also works after a missed event. */
export function subscribePendingOpenTargets(
  consumer: OpenTargetConsumer,
  receive: (request: PendingOpenTarget) => void | Promise<void>,
): UnlistenFn {
  let disposed = false;
  let running = false;
  let reconcileAgain = false;
  const reconcile = async () => {
    if (disposed) return;
    if (running) { reconcileAgain = true; return; }
    running = true;
    const previous = deliveries.get(consumer) ?? Promise.resolve();
    const delivery = previous.catch(() => undefined).then(async () => {
      if (disposed) return;
      do {
        reconcileAgain = false;
        const requests = await invoke<PendingOpenTarget[]>('get_pending_open_targets', { consumer });
        for (const request of requests) {
          if (disposed) return;
          await receive(request);
          await invoke('acknowledge_open_targets', { ids: [request.id] });
        }
      } while (reconcileAgain && !disposed);
    });
    deliveries.set(consumer, delivery);
    try {
      await delivery;
    } catch (error) {
      // Leave unacknowledged requests available for the next readiness/event reconciliation.
      logger.warn('could not consume pending requests', { consumer, error: String(error) });
    } finally {
      if (deliveries.get(consumer) === delivery) deliveries.delete(consumer);
      running = false;
      if (reconcileAgain && !disposed) void reconcile();
    }
  };
  const wake = () => { void reconcile(); };
  const unlisten = subscribe('flowix:open-targets-changed', wake, { onListenerReady: wake });
  return () => { disposed = true; unlisten(); };
}
