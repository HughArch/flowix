'use client';

import type { ProductInfo } from '@platform/tauri/client';
import { GeneralSection } from '@features/preferences/sections/general';
import { ThemeSection } from '@features/preferences/sections/theme';
import { useUserSettings, useUserSettingsActions } from '@features/preferences/hooks/use-user-settings';

export function GeneralPreferencesTab({ productInfo = null }: { productInfo?: ProductInfo | null }) {
  const language = useUserSettings((settings) => settings.language);
  const theme = useUserSettings((settings) => settings.theme);
  const windowCloseAction = useUserSettings((settings) => settings.windowCloseAction);
  const { updateSettings } = useUserSettingsActions();

  return (
    <GeneralSection
      language={language}
      productInfo={productInfo}
      windowCloseAction={windowCloseAction}
      updateSettings={updateSettings}
      afterGeneral={<ThemeSection settings={{ theme }} updateSettings={updateSettings} />}
    />
  );
}
