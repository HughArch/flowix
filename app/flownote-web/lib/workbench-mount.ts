import { useWorkspaceStartupStore } from './store/workspace-startup-store';

let mounted = false;
let resolveMounted!: () => void;

const workbenchMounted = new Promise<void>((resolve) => {
  resolveMounted = resolve;
});

/** Signal that the main workbench subtree has committed inside its Suspense boundary. */
export function notifyWorkbenchMounted(): void {
  if (mounted) return;
  mounted = true;
  useWorkspaceStartupStore.setState({ workbenchMounted: true });
  resolveMounted();
}

/** Wait for the workbench subtree before declaring the first interactive paint. */
export function waitForWorkbenchMounted(): Promise<void> {
  return workbenchMounted;
}
