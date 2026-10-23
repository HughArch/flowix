import type { NoteFilterFieldType } from './note-filter';

export const NOTE_CREATED_AT_FIELD_ID = '__note_created_at__';
export const NOTE_UPDATED_AT_FIELD_ID = '__note_updated_at__';
export const NOTE_PATH_FIELD_ID = '__note_relative_path__';
export const NOTE_SIZE_FIELD_ID = '__note_size__';
/** Filename without Markdown extension; the stored identifier stays compatible. */
export const NOTE_TITLE_FIELD_ID = '__note_filename__';
export const NOTE_FILENAME_FIELD_ID = NOTE_TITLE_FIELD_ID;

export const NOTE_FILTER_READONLY_FIELDS: ReadonlyArray<{ id: string; label: string; type: Exclude<NoteFilterFieldType, 'primary'> }> = [
  { id: NOTE_CREATED_AT_FIELD_ID, label: '创建时间', type: 'Date' },
  { id: NOTE_UPDATED_AT_FIELD_ID, label: '更新时间', type: 'Date' },
  { id: NOTE_PATH_FIELD_ID, label: '相对路径', type: 'Text' },
  { id: NOTE_SIZE_FIELD_ID, label: '文档大小', type: 'Number' },
];

/** Persisted IDs from the table preset adapter; resolved only when reading old drafts. */
export const LEGACY_NOTE_FILTER_PROPERTY_KEYS: Readonly<Record<string, string>> = {
  __note_status__: 'status', __note_calendar_date__: 'calendar_date',
  __note_description__: 'description', __note_tags__: 'tags', __note_colors__: 'flowix_colors',
  __note_icon__: 'flowix_icon', __note_pinned__: 'flowix_favorited',
};
