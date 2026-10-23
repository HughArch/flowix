import type { FlowixTextColor } from '../flowix-text-mark';

/**
 * Built-in callout scenarios. The first entry is also the default used when a
 * new callout is created (slash menu / `!!` shortcut).
 *
 * Parsing is unrelated: a fence without a `color` attribute still resolves to
 * `DEFAULT_CALLOUT_COLOR` (gray), so documents written before these presets
 * existed keep their appearance.
 */
export type CalloutPresetId = 'info' | 'success' | 'warning' | 'error';

export interface CalloutPreset {
  id: CalloutPresetId;
  icon: string;
  color: FlowixTextColor;
}

export const CALLOUT_PRESETS: readonly CalloutPreset[] = [
  { id: 'info', icon: '💡', color: 'orange' },
  { id: 'success', icon: '✅', color: 'green' },
  { id: 'warning', icon: '⚠️', color: 'yellow' },
  { id: 'error', icon: '❌', color: 'red' },
];

/** Attributes applied by `setCallout` and the `!!` shortcut. */
export const DEFAULT_CALLOUT_PRESET = CALLOUT_PRESETS[0];
