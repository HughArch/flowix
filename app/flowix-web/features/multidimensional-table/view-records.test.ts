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

it('sorts builtin metadata using raw values, keeps missing notes last, and clears to dataset order', () => {
  const document = createTableDocument();
  const records = [record('z/first.md'), record('a/second.md'), record('missing.md')];
  const notes = new Map([
    [records[0].note_path, { ...note(records[0].note_path, 20, ''), sizeBytes: 900_000 }],
    [records[1].note_path, { ...note(records[1].note_path, 10, ''), sizeBytes: 10_000_000 }],
  ]);
  const apply = (field: string, direction: 'asc' | 'desc') => applyTableView(records,
    { ...document.views.items[0], sort: [{ field, direction }] }, document.dataset.schema.fields,
    document.dataset.schema.primary_field_id, (record) => notes.get(record.note_path));
  expect(apply('__note_size__', 'asc')).toEqual(records);
  expect(apply('__note_size__', 'desc')).toEqual([records[1], records[0], records[2]]);
  for (const field of ['__note_created_at__', '__note_updated_at__', '__note_relative_path__']) {
    expect(apply(field, 'asc')).toEqual([records[1], records[0], records[2]]);
  }
  expect(applyTableView(records, { ...document.views.items[0], sort: [] }, document.dataset.schema.fields,
    document.dataset.schema.primary_field_id, (record) => notes.get(record.note_path))).toEqual(records);
});

it('sorts pin and description presets using pending property values and keeps missing notes last', () => {
  const document = createTableDocument();
  const records = [record('one.md'), record('two.md'), record('missing.md')];
  const notes = [
    { ...note('one.md', 0, ''), favorited: true, properties: { flowix_favorited: false, description: 'B' } },
    { ...note('two.md', 0, ''), favorited: false, properties: { flowix_favorited: true, description: 'A' } },
  ];
  const apply = (field: string, direction: 'asc' | 'desc') => applyTableView(records,
    { ...document.views.items[0], sort: [{ field, direction }] }, document.dataset.schema.fields,
    document.dataset.schema.primary_field_id, (item) => notes.find((note) => note.relativePath === item.note_path));
  expect(apply('__note_pinned__', 'desc')).toEqual([records[1], records[0], records[2]]);
  expect(apply('__note_pinned__', 'asc')).toEqual(records);
  expect(apply('__note_description__', 'asc')).toEqual([records[1], records[0], records[2]]);
});
