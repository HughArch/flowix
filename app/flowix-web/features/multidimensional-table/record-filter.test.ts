import { describe, expect, it } from 'vitest';
import type { NoteEntry } from '@platform/tauri/client';
import { noteMatchesCollectionFilter } from './record-filter';
import type { TableField } from './model';

const primaryField: TableField = {
  id: `fld_${'a'.repeat(32)}`,
  type: 'primary',
  property_key: 'note',
};

const note = {
  relativePath: 'Release.md',
  title: 'Release notes',
  properties: { workflow: 'release candidate' },
} as unknown as NoteEntry;

describe('noteMatchesCollectionFilter', () => {
  it('matches a note property that is not configured as a table field', () => {
    const filter = { all: [], any: [{ field: 'workflow', op: 'contains', value: 'release' }] };

    expect(noteMatchesCollectionFilter(note, [primaryField], primaryField.id, filter)).toBe(true);
  });

  it('still matches configured fields through their property key', () => {
    const statusField: TableField = { id: `fld_${'b'.repeat(32)}`, type: 'Text', property_key: 'status' };
    const filter = { all: [{ field: statusField.id, op: 'equals', value: 'done' }], any: [] };
    const statusNote = { ...note, properties: { status: 'done' } } as NoteEntry;

    expect(noteMatchesCollectionFilter(statusNote, [primaryField, statusField], primaryField.id, filter)).toBe(true);
  });
});
