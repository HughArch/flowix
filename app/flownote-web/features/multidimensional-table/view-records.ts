import type { NoteEntry } from '@platform/tauri/client';
import type { TableField, TableRecord, TableView } from './model';
import { NOTE_CREATED_AT_FIELD_ID, NOTE_UPDATED_AT_FIELD_ID, NOTE_PATH_FIELD_ID, NOTE_SIZE_FIELD_ID, builtinPresetTableField, builtinPresetValue } from './builtin-fields';
import { noteMatchesCollectionFilter } from './record-filter';

function viewSortValue(field: string, record: TableRecord, note: NoteEntry | undefined, fields: TableField[]): unknown {
  if (builtinPresetTableField(field)) {
    const value = builtinPresetValue(field, note);
    return value === '' || (Array.isArray(value) && !value.length) ? null : value;
  }
  if (field === NOTE_UPDATED_AT_FIELD_ID) return note?.updatedAt;
  if (field === NOTE_CREATED_AT_FIELD_ID) return note?.createdAt;
  if (field === NOTE_SIZE_FIELD_ID) return note?.sizeBytes;
  if (field === NOTE_PATH_FIELD_ID) return note?.relativePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  if (field === 'modified_at') return note?.updatedAt ?? (Date.parse(record.updated_at) || null);
  if (field === 'created_at') return note?.createdAt;
  if (field === 'file_name') return record.note_path.split('/').pop() ?? record.note_path;
  if (field === 'path') return record.note_path.split('/').slice(0, -1).join('/');
  const configured = fields.find((item) => item.id === field || item.property_key === field);
  if (configured?.type === 'primary') return note?.title;
  return configured?.property_key ? note?.properties[configured.property_key] : note?.properties[field];
}

function compareValues(left: unknown, right: unknown): number {
  if (left == null) return right == null ? 0 : 1;
  if (right == null) return -1;
  const leftValue = Array.isArray(left) ? left.join(', ') : left;
  const rightValue = Array.isArray(right) ? right.join(', ') : right;
  if (typeof leftValue === 'number' && typeof rightValue === 'number') return leftValue - rightValue;
  if (typeof leftValue === 'boolean' && typeof rightValue === 'boolean') return Number(leftValue) - Number(rightValue);
  return String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true, sensitivity: 'base' });
}

/** Applies the active view once, before layout grouping and pagination. */
export function applyTableView(
  records: TableRecord[],
  view: TableView | undefined,
  fields: TableField[],
  primaryFieldId: string,
  noteForRecord: (record: TableRecord) => NoteEntry | undefined,
): TableRecord[] {
  if (!view) return records;
  const filter = view.filter && typeof view.filter === 'object' ? view.filter : null;
  const sorts = Array.isArray(view.sort) ? view.sort : [];
  const filterHasRules = (Array.isArray(filter?.all) && filter.all.length > 0)
    || (Array.isArray(filter?.any) && filter.any.length > 0);
  const filtered = filterHasRules
    ? records.filter((record) => {
      const note = noteForRecord(record);
      return note ? noteMatchesCollectionFilter(note, fields, primaryFieldId, filter) : false;
    })
    : records;
  if (!sorts.length) return filtered;

  return filtered.map((record, index) => ({
    record,
    index,
    values: sorts.map((sort) => viewSortValue(sort.field, record, noteForRecord(record), fields)),
  })).sort((left, right) => {
    for (const [sortIndex, sort] of sorts.entries()) {
      const leftValue = left.values[sortIndex];
      const rightValue = right.values[sortIndex];
      const comparison = compareValues(leftValue, rightValue);
      if (comparison) {
        if (leftValue == null || rightValue == null) return comparison;
        return sort.direction === 'desc' ? -comparison : comparison;
      }
    }
    return left.index - right.index;
  }).map(({ record }) => record);
}
