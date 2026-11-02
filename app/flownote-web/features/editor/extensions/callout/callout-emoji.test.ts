import { describe, expect, it } from 'vitest';
import {
  indexCalloutEmojis,
  searchCalloutEmojis,
} from './callout-emoji';
import type { CalloutEmojiGroup } from './emoji-catalog';

const groups: CalloutEmojiGroup[] = [
  {
    id: 'smileys-emotion',
    nameEn: 'Smileys & emotion',
    nameZh: '笑脸与情感',
    emojis: [
      { u: '😀', n: 'grinning face', z: '嘿嘿', k: '笑脸 高兴 smile x' },
      { u: '😢', n: 'crying face', z: '哭', k: '难过 sad x' },
    ],
  },
  {
    id: 'food-drink',
    nameEn: 'Food & drink',
    nameZh: '食物与饮料',
    emojis: [
      { u: '🍎', n: 'red apple', z: '苹果', k: '水果 fruit' },
    ],
  },
];

describe('callout emoji search', () => {
  it('matches English labels, Chinese labels and keywords', () => {
    expect(searchCalloutEmojis(groups, 'apple').entries.map((entry) => entry.u)).toEqual(['🍎']);
    expect(searchCalloutEmojis(groups, '苹果').entries.map((entry) => entry.u)).toEqual(['🍎']);
    expect(searchCalloutEmojis(groups, 'fruit').entries.map((entry) => entry.u)).toEqual(['🍎']);
    expect(searchCalloutEmojis(groups, '嘿嘿').entries.map((entry) => entry.u)).toEqual(['😀']);
  });

  it('requires every term to match', () => {
    expect(searchCalloutEmojis(groups, 'apple 水果').entries.map((entry) => entry.u)).toEqual(['🍎']);
    expect(searchCalloutEmojis(groups, 'apple 哭').entries).toHaveLength(0);
  });

  it('returns an empty result for an unknown query', () => {
    expect(searchCalloutEmojis(groups, 'not-an-emoji')).toEqual({
      entries: [],
      truncated: false,
    });
  });

  it('caps the result set and reports truncation', () => {
    const result = searchCalloutEmojis(groups, 'x', 1);
    expect(result.entries).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('returns nothing for a blank query', () => {
    expect(searchCalloutEmojis(groups, '   ')).toEqual({ entries: [], truncated: false });
  });

  it('indexes every unicode character for common-grid titles', () => {
    const index = indexCalloutEmojis(groups);
    expect(index.get('😀')?.n).toBe('grinning face');
    expect(index.get('🍎')?.z).toBe('苹果');
    expect(index.get('🍎')?.n).toBe('red apple');
  });
});
