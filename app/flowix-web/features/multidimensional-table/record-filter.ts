import type { NoteEntry } from '@platform/tauri/client';
import type { TableField } from './model';
import { matchesCollectionFilter, type CollectionRuleFilter } from '@features/collection/rule-filter';

export function noteMatchesCollectionFilter(
  note: NoteEntry,
  fields: TableField[],
  primaryFieldId: string,
  filter: Record<string, unknown>,
): boolean {
  const path = note.relativePath.replace(/\\/g, '/');
  const filename = path.split('/').pop() ?? path;
  const directory = path.split('/').slice(0, -1).join('/');
  const ruleMatches = (rule: Record<string, unknown>): boolean => {
    const field = String(rule.field ?? '');
    const operator = String(rule.op ?? '');
    const expected = rule.value;
    let actual: unknown;
    if (field === 'kind') actual = 'note';
    else if (field === 'file_name') actual = filename;
    else if (field === 'path') actual = directory;
    else if (field === primaryFieldId) actual = note.title;
    else {
      const configured = fields.find((item) => item.id === field || item.property_key === field);
      actual = configured?.type === 'primary'
        ? note.title
        : configured?.property_key
          ? note.properties[configured.property_key]
          : note.properties[field];
    }
    const values = Array.isArray(actual) ? actual : [actual];
    if (operator === 'in' && Array.isArray(expected)) {
      return values.some((value) => expected.some((candidate) => value != null && String(value) === String(candidate)));
    }
    if (expected === null || typeof expected === 'object') return false;
    return values.some((value) => {
      if (value == null) return false;
      const normalized = String(value);
      if (operator === 'eq' || operator === 'equals') return normalized === String(expected);
      if (operator !== 'contains') return false;
      if (typeof expected !== 'string') return false;
      if (field === 'path') {
        const prefix = expected.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase();
        const directory = normalized.toLocaleLowerCase();
        return directory === prefix || directory.startsWith(`${prefix}/`);
      }
      if (field === 'file_name') return normalized.toLocaleLowerCase().includes(expected.trim().toLocaleLowerCase());
      return normalized.includes(expected);
    });
  };
  return matchesCollectionFilter(filter as unknown as CollectionRuleFilter, ruleMatches);
}
