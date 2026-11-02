import { invoke } from '@tauri-apps/api/core';
import type { PropertiesConfig, PropertyFieldConfig } from '@/lib/constants';

export interface PropertyPresetChange {
  scope: 'system' | 'user' | 'deleted_user';
  field: PropertyFieldConfig;
  expectedRevision: number | null;
}

export const propertyPresets = {
  get: () => invoke<PropertiesConfig>('get_property_presets'),
  patch: (changes: PropertyPresetChange[]) => invoke<PropertiesConfig>('patch_property_presets', { changes }),
};
