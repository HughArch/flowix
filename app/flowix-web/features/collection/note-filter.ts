import type { NoteTitleFilter } from '@platform/tauri/client/notes';
import { NOTE_TITLE_FIELD_ID } from './note-filter-fields';
import type { TablePropertyKind } from '@/lib/property-types';
import type { DatasetRuleFilter } from './rule-filter';

export type NoteFilterFieldType = Exclude<TablePropertyKind, 'Note'> | 'primary';
export interface NoteFilterField {
  id: string;
  type: NoteFilterFieldType;
  property_key?: string;
}

export interface NoteFilterCondition {
  match?: 'all' | 'any';
  /** `null` means no path rule; an empty string explicitly selects all folders. */
  path?: string | null;
  property_conditions?: NoteFilterPropertyCondition[];
  /** Kept for reading older runtime drafts. */
  property_match?: 'union' | 'intersection';
  file_condition?: NoteFilterFileCondition;
}

export interface NoteFilterPropertyCondition {
  /**
   * A stable readonly field ID, table field ID, or frontmatter property key.
   * Display labels are accepted only by the legacy draft reader.
   */
  field_id: string;
  operator: 'equals' | 'contains' | 'gt' | 'lt';
  value: string;
}

export type NoteFilterFileType = '' | 'markdown';

export interface NoteFilterFileCondition {
  file_name_contains?: string;
  file_type?: NoteFilterFileType;
  path_contains?: string;
  path_scope?: 'all';
}

export interface NoteFilterConfig {
  condition: NoteFilterCondition;
  /** Opt in only when the source format is known to store display labels. */
  field_reference_format?: 'ids' | 'legacy-labels';
}

/** One interpretation for current conditions and legacy union/intersection drafts. */
export function noteFilterMatch(condition: NoteFilterCondition): 'all' | 'any' {
  return condition.match ?? (condition.property_match === 'union' ? 'any' : 'all');
}

export type NormalizedNoteFilterCondition = Omit<NoteFilterCondition, 'match' | 'path' | 'property_match'> & {
  match: 'all' | 'any';
  path: string | null;
};

export function normalizeNoteFilterCondition(condition: NoteFilterCondition): NormalizedNoteFilterCondition {
  const properties = (condition.property_conditions ?? []).map((item) => ({
    ...item, field_id: item.field_id.trim(), value: item.value.trim(),
  })).filter((item) => item.field_id && item.value);
  const file = condition.file_condition;
  const rawPath = condition.path !== undefined ? condition.path
    : file?.path_scope === 'all' ? '' : file?.path_contains?.trim() || null;
  const path = typeof rawPath === 'string'
    ? rawPath.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : null;
  const fileName = file?.file_name_contains?.trim();
  const fileType = file?.file_type?.trim().replace(/^\./, '').toLowerCase() === 'markdown' ? 'markdown' as const : '';
  return {
    match: noteFilterMatch(condition),
    path,
    ...(properties.length ? { property_conditions: properties } : {}),
    ...(fileName || fileType ? { file_condition: {
      ...(fileName ? { file_name_contains: fileName } : {}),
      ...(fileType ? { file_type: fileType } : {}),
    } } : {}),
  };
}

export function compileNoteFilter(condition: NoteFilterCondition): DatasetRuleFilter & Record<string, unknown> {
  const normalized = normalizeNoteFilterCondition(condition);
  const conditions = (normalized.property_conditions ?? []).map((item) => ({
    field: item.field_id,
    op: item.operator === 'equals' ? 'eq' : item.operator,
    value: item.value,
  }));
  if (normalized.file_condition?.file_name_contains) conditions.push({
    field: 'file_name', op: 'contains', value: normalized.file_condition.file_name_contains,
  });
  if (normalized.file_condition?.file_type) conditions.push({ field: 'kind', op: 'eq', value: 'note' });
  return { path: normalized.path ?? null, match: noteFilterMatch(normalized), conditions };
}

/** Push only necessary title predicates; an OR with other fields must stay intact. */
export function noteFilterTitleQuery(condition?: NoteFilterCondition | null): NoteTitleFilter | undefined {
  if (!condition) return undefined;
  const filter = compileNoteFilter(condition);
  const titles = filter.conditions.filter((rule) => rule.field === NOTE_TITLE_FIELD_ID
    && (rule.op === 'eq' || rule.op === 'contains'));
  if (!titles.length || (filter.match === 'any' && titles.length !== filter.conditions.length)) return undefined;
  const query: NoteTitleFilter = {
    match: filter.match,
    conditions: titles.map((rule) => ({ op: rule.op as 'eq' | 'contains', value: String(rule.value) })),
  };
  // Bound query/cursor size; larger expressions keep the general frontend evaluator.
  return titles.length <= 8 && JSON.stringify(query).length <= 512 ? query : undefined;
}
