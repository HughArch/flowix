import { useWorkspaceFocusStore } from '../store/workspace-focus-store';
import type { WorkspaceSurfaceHost } from '../model/surface-contract';

/** React portals share ancestors in React, but do not interact with the host DOM. */
export function focusWorkspaceHostFromEvent(
  event: { currentTarget: HTMLElement; target: EventTarget | null },
  host: WorkspaceSurfaceHost,
): void {
  if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
  useWorkspaceFocusStore.getState().focusHost(host);
}
