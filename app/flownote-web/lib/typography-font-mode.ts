import { FONT_FAMILY_OPTIONS } from '@/lib/constants';

export const TYPOGRAPHY_FONT_MODES = ['standard', 'serif', 'wenkai'] as const;
export type TypographyFontMode = (typeof TYPOGRAPHY_FONT_MODES)[number];

const FONT_ID_BY_MODE: Record<TypographyFontMode, string> = {
  standard: 'inter',
  serif: 'noto-serif-sc',
  wenkai: 'lxgw-wenkai',
};

export function getTypographyFontId(mode: TypographyFontMode): string {
  return FONT_ID_BY_MODE[mode];
}

export function getTypographyFontMode(fontId: string | undefined): TypographyFontMode {
  if (fontId === FONT_ID_BY_MODE.serif) return 'serif';
  if (fontId === FONT_ID_BY_MODE.wenkai) return 'wenkai';
  return 'standard';
}

export function getTypographyFontFamily(mode: TypographyFontMode): string {
  const fontId = getTypographyFontId(mode);
  return FONT_FAMILY_OPTIONS.find((font) => font.id === fontId)?.value
    ?? FONT_FAMILY_OPTIONS[0].value;
}
