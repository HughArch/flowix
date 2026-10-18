'use client';

import { lazy, Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { useUserSettings, useUserSettingsActions } from '@features/preferences/hooks/use-user-settings';
import { SectionHeader } from '@features/preferences/sections/primitives';
import { useI18n } from '@/lib/i18n';

const FormatSection = lazy(() =>
  import('@features/preferences/sections/format').then((module) => ({ default: module.FormatSection })),
);

export function FormatPreferencesTab() {
  const { t } = useI18n();
  const format = useUserSettings((settings) => settings.format);
  const { updateSettings } = useUserSettingsActions();

  return (
    <Suspense fallback={(
      <div className="flex min-h-0 flex-1 flex-col space-y-6" aria-busy="true">
        <SectionHeader title={t('preferences.format.title')} />
        <div className="flex flex-1 items-center justify-center" role="status" aria-label={t('preferences.general.loading')}>
          <Loader2 className="size-6 flowix-spin text-[var(--muted-foreground)]" />
          <span className="sr-only">{t('preferences.general.loading')}</span>
        </div>
      </div>
    )}>
      <FormatSection settings={format} updateSettings={updateSettings} />
    </Suspense>
  );
}
