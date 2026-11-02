import { PAGE_WIDTH_SCALE_DEFAULT } from '@/lib/constants';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';

/**
 * Page-width controls used by document chrome.
 *
 * The scale is a percentage applied on top of `format.documentWidth`, so a
 * document that is already narrowed in Preferences keeps its own width and
 * only shrinks proportionally from there.
 */
export function useEditorPageWidthScale() {
  const pageWidthScale = useUserSettingsStore(
    (state) => state.settings.format.pageWidthScale ?? PAGE_WIDTH_SCALE_DEFAULT,
  );
  const updateSettings = useUserSettingsStore((state) => state.updateSettings);
  return {
    pageWidthScale,
    setPageWidthScale: (value: number) => updateSettings({ format: { pageWidthScale: value } }),
  };
}
