import { describe, expect, it } from 'vitest';
import { FLAG_ASSET_URLS, flagAssetUrlForIcon } from './flag-assets';

describe('flag artwork', () => {
  it('bundles Twemoji SVGs for the flag group', () => {
    expect(Object.keys(FLAG_ASSET_URLS).length).toBeGreaterThan(260);
    expect(FLAG_ASSET_URLS['1f1e8-1f1f3']).toBeTruthy();
  });

  it('resolves emoji characters to their artwork', () => {
    expect(flagAssetUrlForIcon('🇨🇳')).toBeTruthy();
    expect(flagAssetUrlForIcon('🇺🇸')).toBeTruthy();
    expect(flagAssetUrlForIcon('😀')).toBeUndefined();
  });

  it('falls back to the text glyph for flags missing from Twemoji', () => {
    expect(flagAssetUrlForIcon('🇨🇶')).toBeUndefined();
  });
});
