'use client';

import { Loader2 } from 'lucide-react';
import standardIcon from '@/assets/editor-font-icons/standard.svg';
import serifIcon from '@/assets/editor-font-icons/serif.svg';
import wenkaiIcon from '@/assets/editor-font-icons/wenkai.svg';
import { useI18n } from '@/lib/i18n';
import { TYPOGRAPHY_FONT_MODES, type TypographyFontMode } from '@/lib/typography-font-mode';

const FONT_MODE_ICONS: Record<TypographyFontMode, string> = {
  standard: standardIcon,
  serif: serifIcon,
  wenkai: wenkaiIcon,
};

export function TypographyFontSwitcher({
  fontMode,
  downloadingMode,
  onSelect,
}: {
  fontMode: TypographyFontMode;
  downloadingMode: Exclude<TypographyFontMode, 'standard'> | null;
  onSelect: (mode: TypographyFontMode) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="mb-1">
      <div className="flex justify-center gap-0.5" role="group" aria-label={t('document.font.label')}>
        {TYPOGRAPHY_FONT_MODES.map((mode) => {
          const active = fontMode === mode;
          const isLoading = downloadingMode === mode;
          return (
            <button
              key={mode}
              type="button"
              aria-pressed={active}
              disabled={isLoading}
              onClick={() => onSelect(mode)}
              className={`group flex h-[58px] w-[58px] shrink-0 flex-col items-center justify-center gap-1 rounded-lg text-[11px] leading-tight transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)] ${active ? 'text-[var(--foreground)]' : 'text-[var(--muted-foreground)]'}`}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center">
                {isLoading
                  ? <Loader2 aria-hidden="true" className="h-4 w-4 flowix-spin text-[var(--brand)]" />
                  : <img aria-hidden="true" src={FONT_MODE_ICONS[mode]} alt="" className="h-6 w-6 shrink-0 dark:invert" />}
              </span>
              <span className="max-w-full truncate">
                {t(mode === 'standard' ? 'document.font.standard' : mode === 'serif' ? 'document.font.serif' : 'document.font.wenkai')}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
