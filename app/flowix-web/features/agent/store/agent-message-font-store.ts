import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { STORAGE_KEYS } from '@/lib/constants';
import {
  getTypographyFontFamily,
  TYPOGRAPHY_FONT_MODES,
  type TypographyFontMode,
} from '@/lib/typography-font-mode';

export type AgentMessageFontMode = TypographyFontMode;
export const AGENT_MESSAGE_SIZE_MODES = ['small', 'medium', 'large'] as const;
export type AgentMessageSizeMode = (typeof AGENT_MESSAGE_SIZE_MODES)[number];

export const AGENT_MESSAGE_SIZE_SCALE: Record<AgentMessageSizeMode, number> = {
  small: 14 / 15,
  medium: 1,
  large: 16 / 15,
};

export function getAgentMessageTypographyCssVars(
  fontMode: AgentMessageFontMode,
  sizeMode: AgentMessageSizeMode,
) {
  return {
    '--agent-message-font-family': `'Flowix Small Emoji', ${getTypographyFontFamily(fontMode)}`,
    '--agent-message-base-font-size': '15px',
    '--agent-message-size-scale': AGENT_MESSAGE_SIZE_SCALE[sizeMode],
  } as const;
}

interface AgentMessageFontStore {
  fontMode: AgentMessageFontMode;
  setFontMode: (fontMode: AgentMessageFontMode) => void;
  sizeMode: AgentMessageSizeMode;
  setSizeMode: (sizeMode: AgentMessageSizeMode) => void;
}

function isAgentMessageFontMode(value: unknown): value is AgentMessageFontMode {
  return typeof value === 'string' && (TYPOGRAPHY_FONT_MODES as readonly string[]).includes(value);
}

function isAgentMessageSizeMode(value: unknown): value is AgentMessageSizeMode {
  return typeof value === 'string' && (AGENT_MESSAGE_SIZE_MODES as readonly string[]).includes(value);
}

export const useAgentMessageFontStore = create<AgentMessageFontStore>()(
  persist(
    (set) => ({
      fontMode: 'standard',
      setFontMode: (fontMode) => set({ fontMode }),
      sizeMode: 'medium',
      setSizeMode: (sizeMode) => set({ sizeMode }),
    }),
    {
      name: STORAGE_KEYS.AGENT_MESSAGE_FONT,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ fontMode, sizeMode }) => ({ fontMode, sizeMode }),
      merge: (persisted, current) => {
        const storedMode = (persisted as Partial<AgentMessageFontStore> | undefined)?.fontMode;
        return {
          ...current,
          fontMode: isAgentMessageFontMode(storedMode) ? storedMode : 'standard',
          sizeMode: isAgentMessageSizeMode((persisted as Partial<AgentMessageFontStore> | undefined)?.sizeMode)
            ? (persisted as Partial<AgentMessageFontStore>).sizeMode!
            : 'medium',
        };
      },
    },
  ),
);

// Zustand's persist middleware writes localStorage but does not subscribe to
// changes made by sibling windows. Keep dedicated conversation windows and
// the editor's embedded Thread Cards on the same typography selection.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEYS.AGENT_MESSAGE_FONT || event.key === null) {
      void useAgentMessageFontStore.persist.rehydrate();
    }
  });
}
