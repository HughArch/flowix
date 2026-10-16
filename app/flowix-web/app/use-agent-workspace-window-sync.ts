import { useAgentDataStore } from "@features/agent/store/agent-data-store";
import { useEffect } from 'react';
import { listenToAgentWorkspaceChanges, boot } from '@platform/tauri/client';

/** Each Webview owns a store, including the preferences window. */
export function useAgentWorkspaceWindowSync() {
  const loadInitial = useAgentDataStore((state) => state.workspaceActions.loadInitial);
  const initializePiMode = useAgentDataStore((state) => state.initializePiMode);
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    const initialize = async () => {
      if ('__TAURI_INTERNALS__' in window || '__TAURI__' in window) {
        await boot.waitForStartupReady();
      }
      if (!active) return;
      void initializePiMode().catch((error) => console.warn('Pi mode initialization failed:', error));
      const reload = () => { if (active) void loadInitial(); };
      unlisten = listenToAgentWorkspaceChanges(reload, { onListenerReady: reload });
      reload();
    };
    void initialize().catch((error) => console.warn('Workspace initialization deferred:', error));
    return () => { active = false; unlisten?.(); };
  }, [initializePiMode, loadInitial]);
}
