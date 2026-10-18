'use client';

import { useEffect, useRef, useState } from 'react';
import {
  beginTypographyFontSelection,
  commitTypographyFontSelection,
  ensureDownloadedFontRegistered,
  useTypographyFontId,
} from '@features/preferences/public/font-api';
import type { FontDownloadProgress } from '@platform/tauri/client/general';
import { subscribe } from '@platform/tauri/event-bus';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { TypographyFontSwitcher } from '@shared/ui/typography-font-switcher';
import {
  getTypographyFontId,
  getTypographyFontMode,
  type TypographyFontMode,
} from '@/lib/typography-font-mode';

type DocumentEditorFontMode = TypographyFontMode;

export function useEditorFontSwitch() {
  const { t } = useI18n();
  const fontId = useTypographyFontId();
  const fontMode = getTypographyFontMode(fontId);
  const [downloadingMode, setDownloadingMode] = useState<'serif' | 'wenkai' | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const requestId = useRef(0);
  const downloadingFontId = useRef<string | null>(null);

  useEffect(() => subscribe<FontDownloadProgress>('font-download-progress', (progress) => {
    if (progress.fontId === downloadingFontId.current) {
      setPercent(progress.percent);
    }
  }), []);

  useEffect(() => () => {
    requestId.current += 1;
    downloadingFontId.current = null;
  }, []);

  async function selectFontMode(mode: DocumentEditorFontMode): Promise<boolean> {
    const request = ++requestId.current;
    const fontId = getTypographyFontId(mode);
    downloadingFontId.current = mode === 'standard' ? null : fontId;
    setDownloadingMode(mode === 'standard' ? null : mode);
    setPercent(null);
    try {
      const selectionId = await beginTypographyFontSelection();
      if (requestId.current !== request) return false;
      if (mode !== 'standard') await ensureDownloadedFontRegistered(fontId);
      if (requestId.current !== request) return false;
      await commitTypographyFontSelection(selectionId, fontId);
      return true;
    } catch (error) {
      if (requestId.current !== request) return false;
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('preferences.format.fontDownloadFailed', { message }));
      return false;
    } finally {
      if (requestId.current === request) {
        downloadingFontId.current = null;
        setDownloadingMode(null);
        setPercent(null);
      }
    }
  }

  return { fontMode, downloadingMode, percent, selectFontMode };
}

export function EditorFontSwitcher({
  fontMode,
  downloadingMode,
  percent,
  onSelect,
}: {
  fontMode: DocumentEditorFontMode;
  downloadingMode: 'serif' | 'wenkai' | null;
  percent: number | null;
  onSelect: (mode: DocumentEditorFontMode) => void;
}) {
  return <TypographyFontSwitcher fontMode={fontMode} downloadingMode={downloadingMode} percent={percent} onSelect={onSelect} />;
}
