'use client';

import { useEffect, useRef, useState } from 'react';
import {
  beginTypographyFontSelection,
  commitTypographyFontSelection,
  ensureDownloadedFontRegistered,
  useTypographyFontId,
} from '@features/preferences/public/font-api';
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
  const requestId = useRef(0);

  useEffect(() => () => {
    requestId.current += 1;
  }, []);

  async function selectFontMode(mode: DocumentEditorFontMode): Promise<boolean> {
    const request = ++requestId.current;
    const fontId = getTypographyFontId(mode);
    setDownloadingMode(mode === 'standard' ? null : mode);
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
        setDownloadingMode(null);
      }
    }
  }

  return { fontMode, downloadingMode, selectFontMode };
}

export function EditorFontSwitcher({
  fontMode,
  downloadingMode,
  onSelect,
}: {
  fontMode: DocumentEditorFontMode;
  downloadingMode: 'serif' | 'wenkai' | null;
  onSelect: (mode: DocumentEditorFontMode) => void;
}) {
  return <TypographyFontSwitcher fontMode={fontMode} downloadingMode={downloadingMode} onSelect={onSelect} />;
}
