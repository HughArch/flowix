import { describe, expect, it } from 'vitest';
import { CALLOUT_EMOJI_GROUPS } from './emoji-catalog';

describe('generated callout emoji catalog', () => {
  it('covers the nine visible Unicode groups', () => {
    expect(CALLOUT_EMOJI_GROUPS.map((group) => group.id)).toEqual([
      'smileys-emotion',
      'people-body',
      'animals-nature',
      'food-drink',
      'travel-places',
      'activities',
      'objects',
      'symbols',
      'flags',
    ]);
  });

  it('contains the full renderable base set without component swatches', () => {
    const total = CALLOUT_EMOJI_GROUPS.reduce((sum, group) => sum + group.emojis.length, 0);
    // Emoji 16+ entries without system-font glyphs or artwork are omitted, so
    // the renderable total sits just under 1900.
    expect(total).toBeGreaterThan(1850);
    expect(CALLOUT_EMOJI_GROUPS.some((group) => group.id === 'component')).toBe(false);
  });

  it('has unique characters and usable labels', () => {
    const seen = new Set<string>();
    for (const group of CALLOUT_EMOJI_GROUPS) {
      expect(group.nameEn.length).toBeGreaterThan(0);
      expect(group.nameZh.length).toBeGreaterThan(0);
      for (const emoji of group.emojis) {
        expect(emoji.u.length).toBeGreaterThan(0);
        expect(emoji.n.length).toBeGreaterThan(0);
        expect(emoji.z.length).toBeGreaterThan(0);
        expect(seen.has(emoji.u)).toBe(false);
        seen.add(emoji.u);
      }
    }
  });

  it('uses compact category labels', () => {
    const labels = Object.fromEntries(
      CALLOUT_EMOJI_GROUPS.map((group) => [group.id, [group.nameZh, group.nameEn]]),
    );
    expect(labels['smileys-emotion']).toEqual(['表情', 'Smileys']);
    expect(labels['people-body']).toEqual(['动作', 'People']);
    expect(labels['animals-nature']).toEqual(['动物', 'Animals']);
    expect(labels['food-drink']).toEqual(['食物', 'Food']);
    expect(labels['travel-places']).toEqual(['旅行', 'Travel']);
    expect(labels.activities).toEqual(['活动', 'Activities']);
    expect(labels.objects).toEqual(['物品', 'Objects']);
    expect(labels.symbols).toEqual(['符号', 'Symbols']);
    expect(labels.flags).toEqual(['旗帜', 'Flags']);
  });

  it('marks flag entries with their artwork key', () => {
    const flags = CALLOUT_EMOJI_GROUPS.find((group) => group.id === 'flags');
    expect(flags).toBeDefined();
    // Emoji 16's Sark flag has no artwork yet and is omitted.
    expect(flags!.emojis).toHaveLength(269);
    expect(flags!.emojis.every((emoji) => typeof emoji.f === 'string')).toBe(true);
    expect(flags!.emojis.find((emoji) => emoji.f === '1f1e8-1f1f3')?.u).toBe('🇨🇳');
  });

  it('includes Chinese search keywords for common emoji', () => {
    const grinning = CALLOUT_EMOJI_GROUPS
      .flatMap((group) => group.emojis)
      .find((emoji) => emoji.u === '😀');
    expect(grinning).toBeDefined();
    expect(grinning!.z).toBeTruthy();
    expect(grinning!.k).toContain('笑');
  });
});
