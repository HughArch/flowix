import type { ActiveSettingsTab as RegistryActiveSettingsTab } from '@features/preferences/preferences-tab-config';

/**
 * Active tab IDs come from the preferences tab registry. This file only adds
 * the legacy identifiers that remain accepted at the route boundary.
 */
export type ActiveSettingsTab = RegistryActiveSettingsTab;

/** Legacy URL identifiers accepted by PreferencesView's compatibility map. */
export type LegacySettingsTab =
  | 'fileDisplayRules'
  | 'theme'
  | 'cli'
  | 'connections'
  | 'tools'
  | 'history'
  | 'codex'
  | 'plugins'
  | 'agent'
  | 'agents'
  | 'modelConfig'
  | 'imageGeneration'
  | 'videoGeneration';

export type SettingsTab = ActiveSettingsTab | LegacySettingsTab;
