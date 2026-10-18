'use client';

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { subscribe } from '@platform/tauri/event-bus';
import type { FontDownloadProgress } from '@platform/tauri/client/general';
import { ensureDownloadedFontRegistered } from '@features/preferences/public/font-api';
import { TypographyFontSwitcher } from '@shared/ui/typography-font-switcher';
import { FontSizeSwitcher } from '@shared/ui/font-size-switcher';
import { getTypographyFontId } from '@/lib/typography-font-mode';
import {
  useAgentMessageFontStore,
  type AgentMessageFontMode,
  type AgentMessageSizeMode,
} from '@features/agent/store/agent-message-font-store';

export function useAgentMessageFontSwitch() {
  const { t } = useI18n();
  const fontMode = useAgentMessageFontStore((state) => state.fontMode);
  const sizeMode = useAgentMessageFontStore((state) => state.sizeMode);
  const setFontMode = useAgentMessageFontStore((state) => state.setFontMode);
  const [downloadingMode, setDownloadingMode] = useState<Exclude<AgentMessageFontMode, 'standard'> | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const requestId = useRef(0);
  const downloadingFontId = useRef<string | null>(null);

  useEffect(() => subscribe<FontDownloadProgress>('font-download-progress', (progress) => {
    if (progress.fontId === downloadingFontId.current) setPercent(progress.percent);
  }), []);

  useEffect(() => () => {
    requestId.current += 1;
    downloadingFontId.current = null;
  }, []);

  async function selectFontMode(mode: AgentMessageFontMode) {
    const request = ++requestId.current;
    const fontId = getTypographyFontId(mode);
    downloadingFontId.current = mode === 'standard' ? null : fontId;
    setDownloadingMode(mode === 'standard' ? null : mode);
    setPercent(null);

    try {
      if (mode !== 'standard') await ensureDownloadedFontRegistered(fontId);
      if (requestId.current !== request) return;
      setFontMode(mode);
    } catch (error) {
      if (requestId.current !== request) return;
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('preferences.format.fontDownloadFailed', { message }));
    } finally {
      if (requestId.current === request) {
        downloadingFontId.current = null;
        setDownloadingMode(null);
        setPercent(null);
      }
    }
  }

  return { fontMode, sizeMode, downloadingMode, percent, selectFontMode };
}

export function AgentMessageFontSwitcher({
  fontMode,
  sizeMode,
  downloadingMode,
  percent,
  onSelect,
}: {
  fontMode: AgentMessageFontMode;
  sizeMode: AgentMessageSizeMode;
  downloadingMode: Exclude<AgentMessageFontMode, 'standard'> | null;
  percent: number | null;
  onSelect: (mode: AgentMessageFontMode) => void;
}) {
  const setSizeMode = useAgentMessageFontStore((state) => state.setSizeMode);
  return (
    <div>
      <TypographyFontSwitcher fontMode={fontMode} downloadingMode={downloadingMode} percent={percent} onSelect={onSelect} />
      <FontSizeSwitcher sizeMode={sizeMode} onSelect={setSizeMode} />
    </div>
  );
}
