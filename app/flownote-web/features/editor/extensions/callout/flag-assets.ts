/// <reference types="vite/client" />

/**
 * Flag artwork URLs keyed by lowercase emoji hexcode.
 *
 * Windows' system emoji font has no national-flag glyphs, so the picker renders
 * flags as local Twemoji SVGs instead of relying on font fallback. The files are
 * emitted as standalone assets (never inlined) and fetched only when a flag is
 * displayed.
 *
 * Source: https://github.com/jdecked/twemoji — CC-BY 4.0. See FLAG-ASSETS.md.
 */
const modules = import.meta.glob('./flag-assets/*.svg', {
  eager: true,
  query: '?url&no-inline',
  import: 'default',
}) as Record<string, string>;

const PREFIX = './flag-assets/';
const SUFFIX = '.svg';

export const FLAG_ASSET_URLS: Record<string, string> = Object.fromEntries(
  Object.entries(modules).map(([file, url]) => [
    file.slice(PREFIX.length, file.length - SUFFIX.length),
    url,
  ]),
);

/** Resolve the artwork for an emoji character, e.g. 🇨🇳 → 1f1e8-1f1f3.svg. */
export function flagAssetUrlForIcon(icon: string): string | undefined {
  const key = Array.from(icon)
    .map((codepoint) => codepoint.codePointAt(0)?.toString(16))
    .filter(Boolean)
    .join('-');
  return FLAG_ASSET_URLS[key];
}
