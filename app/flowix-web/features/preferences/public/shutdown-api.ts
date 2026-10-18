import { useUserSettingsStore } from '../store/user-settings-store';

export function flushPreferencesForShutdown(): Promise<void> {
  return useUserSettingsStore.getState().flushPending();
}
