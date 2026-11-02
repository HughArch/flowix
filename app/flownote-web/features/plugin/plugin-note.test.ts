import { describe, expect, it } from 'vitest';
import type { MemoItem } from '@/types/memo-item';
import { getPluginNoteInfo } from './plugin-note';

function memo(properties: Record<string, unknown>): MemoItem {
  return {
    relativePath: 'memo-1.md',
    filename: 'note.md',
    preview: '',
    tags: [],
    todos: [],
    agents: [],
    createdAt: 0,
    updatedAt: 0,
    favorited: false,
    icon: null,
    colors: [],
    properties,
  };
}

describe('getPluginNoteInfo', () => {
  it('reads a supported artifact renderer from pointer metadata', () => {
    expect(getPluginNoteInfo(memo({
      flownote_note_type: 'report',
      flownote_plugin: 'report-plugin',
      flownote_artifact: { renderer: 'html' },
    }))).toEqual({
      noteType: 'report',
      pluginId: 'report-plugin',
      renderer: 'html',
    });
  });

  it('recognizes a webpage artifact renderer', () => {
    expect(getPluginNoteInfo(memo({
      flownote_note_type: 'webpage',
      flownote_plugin: 'webpage',
      flownote_artifact: { renderer: 'webpage' },
    }))?.renderer).toBe('webpage');
  });

  it('keeps valid plugin pointers with missing or unknown renderers resolvable', () => {
    expect(getPluginNoteInfo(memo({
      flownote_note_type: 'legacy',
      flownote_plugin: 'legacy-plugin',
      flownote_artifact: { renderer: 'future-renderer' },
    }))).toEqual({
      noteType: 'legacy',
      pluginId: 'legacy-plugin',
      renderer: null,
    });
  });

  it('rejects ordinary notes and incomplete pointer metadata', () => {
    expect(getPluginNoteInfo(memo({}))).toBeNull();
    expect(getPluginNoteInfo(memo({ flownote_note_type: 'mindmap' }))).toBeNull();
  });
});
