'use client';

import { ArrowsOutLineHorizontalIcon } from '@phosphor-icons/react';
import {
  PAGE_WIDTH_SCALE_MAX,
  PAGE_WIDTH_SCALE_MIN,
  PAGE_WIDTH_SCALE_STEP,
} from '@/lib/constants';
import { useI18n } from '@/lib/i18n';
import { useEditorPageWidthScale } from '@features/preferences/public/page-width-api';

/**
 * Page width control for the document titlebar "…" menu.
 *
 * The slider is a ratio, not a length: 100% leaves the current document width
 * untouched, while lower values scale the content column down and let the
 * surrounding editor surface become the side margin.
 */
export function DocumentPageWidthSlider() {
  const { t } = useI18n();
  const { pageWidthScale, setPageWidthScale } = useEditorPageWidthScale();
  const filledPercent =
    ((pageWidthScale - PAGE_WIDTH_SCALE_MIN) / (PAGE_WIDTH_SCALE_MAX - PAGE_WIDTH_SCALE_MIN)) * 100;

  return (
    <div className="flex flex-col gap-1.5 rounded-lg px-2 py-1">
      <div className="flex h-5 items-center gap-2 text-sm text-[var(--foreground)]">
        <ArrowsOutLineHorizontalIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1">{t('document.titlebar.pageWidth')}</span>
        <span className="shrink-0 text-xs tabular-nums text-[var(--muted-foreground)]">
          {pageWidthScale}%
        </span>
      </div>
      <input
        type="range"
        aria-label={t('document.titlebar.pageWidth')}
        min={PAGE_WIDTH_SCALE_MIN}
        max={PAGE_WIDTH_SCALE_MAX}
        step={PAGE_WIDTH_SCALE_STEP}
        value={pageWidthScale}
        onChange={(event) => { void setPageWidthScale(Number(event.target.value)); }}
        className="preferences-range-slider h-1.5 w-full cursor-pointer appearance-none rounded-full accent-[var(--primary)]"
        style={{
          background: `linear-gradient(to right, var(--primary) 0%, var(--primary) ${filledPercent}%, var(--muted) ${filledPercent}%, var(--muted) 100%)`,
        }}
      />
    </div>
  );
}
