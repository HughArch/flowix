import { useEffect } from 'react';
import { useAgentAccessStore } from '@features/agent/store/agent-access-store';
import { listenToAgentAccessChanges } from '@platform/tauri/client';

/** Each Webview owns a store, including the preferences window. */
export function useAgentAccessWindowSync() {
  const loadInitial = useAgentAccessStore((state) => state.loadInitial);
  useEffect(() => {
    const reload = () => { void loadInitial(); };
    const unlisten = listenToAgentAccessChanges(reload, { onListenerReady: reload });
    reload();
    return unlisten;
  }, [loadInitial]);
}
