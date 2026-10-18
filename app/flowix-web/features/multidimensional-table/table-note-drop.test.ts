import { describe, expect, it } from 'vitest';
import type { NoteEntry } from '@platform/tauri/client';
import { createTableDocument, type TableRecord } from './model';
import { planTableNoteDrop } from './table-note-drop';
import { applyTableView } from './view-records';

const record = (path: string): TableRecord => ({ id: `existing:${path}`, note_path: path, updated_at: '' });
const note = (path: string, updatedAt: number, workflow = 'keep'): NoteEntry => ({
  relativePath: path, title: path, preview: '', thumbnail: null, tags: [], todos: [], agents: [],
  createdAt: 0, updatedAt, favorited: false, icon: null, colors: [], properties: { workflow },
});

function fixture() {
  const document = createTableDocument('gallery');
  const old = note('old.md', 10);
  const automatic = note('automatic.md', 30);
  const incoming = note('incoming.md', 20);
  const notes = new Map([old, automatic, incoming].map((entry) => [entry.relativePath, entry]));
  return {
    explicitRecords: [record(old.relativePath)], automaticRecords: [record(automatic.relativePath)],
    draggedNotes: [incoming], beforeRecordId: 'existing:old.md', view: document.views.items[0],
    fields: document.dataset.schema.fields, primaryFieldId: document.dataset.schema.primary_field_id,
    noteForRecord: (entry: TableRecord) => notes.get(entry.note_path), isInSource: () => true,
  };
}

describe('table note drop planning', () => {
  it('previews the existing sort order and reproduces it after save/reload without new ordering fields', () => {
    const args = fixture();
    const plan = planTableNoteDrop(args);
    if ('reason' in plan) throw new Error(plan.reason);
    expect(plan.records.map((entry) => entry.note_path)).toEqual(['automatic.md', 'incoming.md', 'old.md']);
    expect(plan.includedRecords.map((entry) => entry.note_path)).toEqual(['old.md', 'incoming.md']);
    const persisted = JSON.parse(JSON.stringify(plan.includedRecords)) as TableRecord[];
    persisted[1].id = 'rec_00000000000000000000000000000001';
    const reloaded = applyTableView([...persisted, ...args.automaticRecords], args.view, args.fields,
      args.primaryFieldId, (entry) => args.draggedNotes.find((note) => note.relativePath === entry.note_path) ?? args.noteForRecord(entry));
    expect(reloaded.map((entry) => entry.note_path)).toEqual(plan.records.map((entry) => entry.note_path));
    expect(args.view.sort).toEqual([{ field: 'modified_at', direction: 'desc' }]);
    expect(args.view.config).not.toHaveProperty('record_order');
  });

  it('accepts matching notes under active filters and rejects only notes that would be hidden', () => {
    const args = fixture();
    args.view.filter = { all: [{ field: 'workflow', op: 'contains', value: 'keep' }], any: [] };
    expect(planTableNoteDrop(args)).not.toHaveProperty('reason');
    expect(planTableNoteDrop({ ...args, draggedNotes: [note('skip.md', 20, 'skip')] }))
      .toEqual({ reason: 'filtered' });
  });

  it('does not duplicate an automatically collected note or convert unrelated automatic records to explicit records', () => {
    const args = fixture();
    args.automaticRecords.push(record('other.md'));
    const plan = planTableNoteDrop({ ...args, draggedNotes: [note('automatic.md', 30)] });
    if ('reason' in plan) throw new Error(plan.reason);
    expect(plan.records.filter((entry) => entry.note_path === 'automatic.md')).toHaveLength(1);
    expect(plan.includedRecords.map((entry) => entry.note_path)).toEqual(['old.md', 'automatic.md']);
    expect(plan.records.some((entry) => entry.note_path === 'other.md')).toBe(true);
    expect(args.automaticRecords).toHaveLength(2);
  });

  it('inserts at the requested list position when no automatic sort is configured', () => {
    const args = fixture();
    args.view.sort = [];
    args.explicitRecords.push(record('last.md'));
    const plan = planTableNoteDrop({ ...args, beforeRecordId: 'existing:last.md' });
    if ('reason' in plan) throw new Error(plan.reason);
    expect(plan.includedRecords.map((entry) => entry.note_path)).toEqual(['old.md', 'incoming.md', 'last.md']);
    expect(args.explicitRecords).toHaveLength(2);
  });

  it('places multiple dragged notes independently according to the existing sort', () => {
    const args = fixture();
    const plan = planTableNoteDrop({ ...args, draggedNotes: [note('newest.md', 40), note('middle.md', 20)] });
    if ('reason' in plan) throw new Error(plan.reason);
    expect(plan.records.map((entry) => entry.note_path)).toEqual(['newest.md', 'automatic.md', 'middle.md', 'old.md']);
  });
});
