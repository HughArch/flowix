'use client';

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
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
  const requestId = useRef(0);

  useEffect(() => () => {
    requestId.current += 1;
  }, []);

  async function selectFontMode(mode: AgentMessageFontMode) {
    const request = ++requestId.current;
    const fontId = getTypographyFontId(mode);
    setDownloadingMode(mode === 'standard' ? null : mode);

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
        setDownloadingMode(null);
      }
    }
  }

  return { fontMode, sizeMode, downloadingMode, selectFontMode };
}

export function AgentMessageFontSwitcher({
  fontMode,
  sizeMode,
  downloadingMode,
  onSelect,
}: {
  fontMode: AgentMessageFontMode;
  sizeMode: AgentMessageSizeMode;
  downloadingMode: Exclude<AgentMessageFontMode, 'standard'> | null;
  onSelect: (mode: AgentMessageFontMode) => void;
}) {
  const setSizeMode = useAgentMessageFontStore((state) => state.setSizeMode);
  return (
    <div>
      <TypographyFontSwitcher fontMode={fontMode} downloadingMode={downloadingMode} onSelect={onSelect} />
      <FontSizeSwitcher sizeMode={sizeMode} onSelect={setSizeMode} />
    </div>
  );
}
