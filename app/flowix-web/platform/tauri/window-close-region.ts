/** Publishes the close-button region and reports native input-routing health. */
import { invoke } from './core';
import { createLogger } from '@/lib/logger';

const buttons = new Set<HTMLElement>();
let revision = 0;
const log = createLogger('window:close-region');
type RoutingListener = (ready: boolean) => void;
const routingListeners = new Set<RoutingListener>();
let routingTimer: ReturnType<typeof setTimeout> | undefined;
let routingCheckInFlight = false;
let nativeInputReady: boolean | undefined;
let latestRegionPublished: boolean | undefined;
let lastReportedAvailability: boolean | undefined;

function reportAvailability() {
  if (nativeInputReady === undefined) return;
  const ready = nativeInputReady && latestRegionPublished === true;
  if (ready === lastReportedAvailability) return;
  lastReportedAvailability = ready;
  routingListeners.forEach(listener => listener(ready));
}

function scheduleRoutingCheck(delay = 2_000) {
  if (routingTimer !== undefined || routingListeners.size === 0) return;
  routingTimer = setTimeout(() => {
    routingTimer = undefined;
    if (routingCheckInFlight || routingListeners.size === 0) return;
    routingCheckInFlight = true;
    void invoke<boolean>('native_close_routing_ready')
      .then(ready => { nativeInputReady = ready; })
      .catch(() => { nativeInputReady = false; })
      .finally(() => {
        routingCheckInFlight = false;
        reportAvailability();
        scheduleRoutingCheck();
      });
  }, delay);
}

function publish() {
  const button = [...buttons].reverse().find(button => button.isConnected && button.getClientRects().length > 0);
  const bounds = button?.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const region = bounds ? {
    rightInset: Math.max(0, window.innerWidth - bounds.right) * scale,
    top: bounds.top * scale,
    width: bounds.width * scale,
    height: bounds.height * scale,
  } : null;
  const publishedRevision = ++revision;
  void invoke('set_window_close_region', { revision: publishedRevision, region })
    .then(() => {
      if (publishedRevision === revision) {
        latestRegionPublished = true;
        reportAvailability();
      }
    })
    .catch(() => {
      if (publishedRevision === revision) {
        latestRegionPublished = false;
        reportAvailability();
      }
      log.error('native close region registration failed');
    });
}

export function subscribeNativeCloseRouting(listener: RoutingListener): () => void {
  routingListeners.add(listener);
  if (lastReportedAvailability !== undefined) listener(lastReportedAvailability);
  scheduleRoutingCheck();
  return () => {
    routingListeners.delete(listener);
    if (routingListeners.size === 0 && routingTimer !== undefined) {
      clearTimeout(routingTimer);
      routingTimer = undefined;
    }
  };
}

export function registerWindowCloseRegion(button: HTMLElement): () => void {
  buttons.add(button);
  const observer = new ResizeObserver(publish);
  observer.observe(button);
  window.addEventListener('resize', publish);
  publish();
  return () => {
    observer.disconnect();
    window.removeEventListener('resize', publish);
    buttons.delete(button);
    publish();
  };
}
