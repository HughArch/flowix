import type { NoteEntry } from '@platform/tauri/client';
import type { TableField, TableRecord, TableView } from './model';
import { applyTableView } from './view-records';

export interface TableNoteDropPreview {
  records: TableRecord[];
  draggedPaths: string[];
}

export type TableNoteDropRejection = { reason: 'filtered' | 'unavailable' };

/** Preview and save use the same prospective dataset and the existing view rules. */
export function planTableNoteDrop({
  explicitRecords, automaticRecords, draggedNotes, beforeRecordId, view, fields,
  primaryFieldId, noteForRecord, isInSource,
}: {
  explicitRecords: TableRecord[];
  automaticRecords: TableRecord[];
  draggedNotes: NoteEntry[];
  beforeRecordId: string | null;
  view: TableView;
  fields: TableField[];
  primaryFieldId: string;
  noteForRecord: (record: TableRecord) => NoteEntry | undefined;
  isInSource: (path: string) => boolean;
}): (TableNoteDropPreview & { includedRecords: TableRecord[] }) | TableNoteDropRejection {
  const pathKey = (path: string) => path.replace(/\\/g, '/');
  const notesByPath = new Map(draggedNotes.map((note) => [pathKey(note.relativePath), note]));
  if (!notesByPath.size) return { reason: 'unavailable' };
  const existingByPath = new Map([...automaticRecords, ...explicitRecords].map((record) => [pathKey(record.note_path), record]));
  const linkedRecords = [...notesByPath].map(([path, note]): TableRecord => existingByPath.get(path) ?? {
    id: `drop-note:${path}`,
    note_path: path,
    updated_at: new Date(note.updatedAt).toISOString(),
  });
  const remaining = explicitRecords.filter((record) => !notesByPath.has(pathKey(record.note_path)));
  const requestedIndex = view.sort.length ? -1 : explicitRecords.findIndex((record) => record.id === beforeRecordId);
  const anchor = requestedIndex >= 0
    ? explicitRecords.slice(requestedIndex).find((record) => !notesByPath.has(pathKey(record.note_path)))
    : undefined;
  const insertAt = anchor ? remaining.findIndex((record) => record.id === anchor.id) : remaining.length;
  const includedRecords = [...remaining.slice(0, insertAt), ...linkedRecords, ...remaining.slice(insertAt)];
  const includedPaths = new Set(includedRecords.map((record) => pathKey(record.note_path)));
  const dataset = [
    ...includedRecords.filter((record) => isInSource(record.note_path)),
    ...automaticRecords.filter((record) => !includedPaths.has(pathKey(record.note_path))),
  ];
  const records = applyTableView(dataset, view, fields, primaryFieldId,
    (record) => notesByPath.get(pathKey(record.note_path)) ?? noteForRecord(record))
    .filter((record) => record.note_path.trim().length > 0);
  const visiblePaths = new Set(records.map((record) => pathKey(record.note_path)));
  if ([...notesByPath.keys()].some((path) => !visiblePaths.has(path))) return { reason: 'filtered' };
  return { includedRecords, records, draggedPaths: [...notesByPath.keys()] };
}
