import { describe, expect, it } from 'vitest';
import type { NoteEntry } from '@platform/tauri/client';
import { createTableDocument, type TableRecord } from './model';
import { applyTableView } from './view-records';

const record = (path: string): TableRecord => ({ id: path, note_path: path, updated_at: '' });
const note = (path: string, updatedAt: number, workflow: string): NoteEntry => ({
  relativePath: path,
  title: path,
  preview: '',
  thumbnail: null,
  tags: [],
  todos: [],
  agents: [],
  createdAt: updatedAt - 100,
  updatedAt,
  favorited: false,
  icon: null,
  colors: [],
  properties: { workflow },
});

describe('applyTableView', () => {
  it('filters and sorts the shared dataset before layouts consume it', () => {
    const document = createTableDocument();
    const view = {
      ...document.views.items[0],
      filter: { all: [{ field: 'workflow', op: 'contains', value: 'keep' }], any: [] },
      sort: [{ field: 'modified_at', direction: 'desc' as const }],
    };
    const records = [record('old.md'), record('skip.md'), record('new.md')];
    const notes = new Map([
      ['old.md', note('old.md', 10, 'keep')],
      ['skip.md', note('skip.md', 30, 'skip')],
      ['new.md', note('new.md', 20, 'keep')],
    ]);

    expect(applyTableView(records, view, document.dataset.schema.fields, document.dataset.schema.primary_field_id, (item) => notes.get(item.note_path)))
      .toEqual([records[2], records[0]]);
  });

  it('keeps draft records when a view has no filter rules', () => {
    const document = createTableDocument();
    const draft = record('');
    expect(applyTableView([draft], document.views.items[0], document.dataset.schema.fields, document.dataset.schema.primary_field_id, () => undefined))
      .toEqual([draft]);
  });
});
