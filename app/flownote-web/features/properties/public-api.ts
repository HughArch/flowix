import { useMemo } from 'react';
import { usePropertyPresetStore } from './property-preset-store';
export { getPropertyPresets, subscribePropertyPresets, getRetiredPropertyKind } from './property-preset-store';

export function usePropertyPresets() {
  const registry = usePropertyPresetStore((state) => state.registry);
  const fields = useMemo(() => [...(registry.systemFields ?? []), ...registry.fields], [registry]);
  return { fields };
}
