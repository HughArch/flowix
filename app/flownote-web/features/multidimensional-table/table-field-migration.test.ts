import { describe, expect, it, vi } from 'vitest';
import type { TableField } from './model';
import { applyFieldMigrations, migratedOptionValue, planFieldMigrations, type FieldValueMigration } from './table-field-migration';

const field: TableField = {
  id: 'fld_' + 'a'.repeat(32), type: 'MultiSelect', property_key: 'status',
  options: [{ id: 'opt_' + 'b'.repeat(32), label: 'old' }, { id: 'opt_' + 'c'.repeat(32), label: 'removed' }],
};
const options = [{ ...field.options![0], label: 'new' }];
const migration: FieldValueMigration = { noteKey: 'note.md', previousValue: ['old'], value: ['new'], remove: false };

describe('option migration', () => {
  it('renames only notes that contain the key, preserving empty values and unrelated properties', () => {
    const notes = [
      { relativePath: 'set.md', properties: { status: 'old', other: 'keep' } },
      { relativePath: 'empty.md', properties: { status: null } },
      { relativePath: 'absent.md', properties: { renamed: 'unrelated' } },
    ];
    const before = JSON.stringify(notes);
    expect(planFieldMigrations(notes, { ...field, type: 'Text' }, 'renamed'))
      .toEqual([
        { noteKey: 'set.md', previousValue: 'old', value: 'old', remove: false },
        { noteKey: 'empty.md', previousValue: null, value: null, remove: false },
      ]);
    expect(JSON.stringify(notes)).toBe(before);
  });

  it('rejects a destination key that already exists without overwriting it', () => {
    expect(() => planFieldMigrations([
      { relativePath: 'collision.md', properties: { status: 'old', renamed: null } },
    ], field, 'renamed')).toThrow('已存在属性');
  });

  it('combines a key rename and an option rename in the same migration', () => {
    expect(planFieldMigrations([
      { relativePath: 'note.md', properties: { status: ['old', 'unknown'] } },
    ], field, 'renamed', options)).toEqual([
      { noteKey: 'note.md', previousValue: ['old', 'unknown'], value: ['new', 'unknown'], remove: false },
    ]);
  });
  it('preserves unknown strings and non-string values while renaming known options and retaining removed values', () => {
    expect(migratedOptionValue(field, options, ['old', 'unknown', 7, 'removed']))
      .toEqual({ value: ['new', 'unknown', 7, 'removed'], remove: false });
    expect(migratedOptionValue(field, [...field.options!].reverse(), ['old', 'unknown']))
      .toBeNull();
  });

  it('leaves unmatched single-select values alone', () => {
    expect(migratedOptionValue({ ...field, type: 'Select' }, options, 'unknown')).toBeNull();
  });

  it('saves the current table before synchronizing note values', async () => {
    const calls: string[] = [];
    const result = await applyFieldMigrations([migration], async () => {
      calls.push('write'); return true;
    }, async () => { calls.push('commit'); return true; });
    expect(calls).toEqual(['commit', 'write']);
    expect(result).toEqual({ saved: true, retained: [migration], failed: [] });
  });

  it('preserves a successful table save and successful notes when another note conflicts', async () => {
    const second = { ...migration, noteKey: 'second.md' };
    const write = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const commit = vi.fn().mockResolvedValue(true);
    const result = await applyFieldMigrations([migration, second], write, commit);
    expect(result).toEqual({ saved: true, retained: [migration], failed: [second] });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('does not mutate notes when the current table could not be saved', async () => {
    const write = vi.fn();
    expect(await applyFieldMigrations([migration], write, async () => false))
      .toEqual({ saved: false, retained: [], failed: [] });
    expect(write).not.toHaveBeenCalled();
  });

  it('reports individual document errors and continues with remaining documents', async () => {
    const second = { ...migration, noteKey: 'second.md' };
    const write = vi.fn().mockRejectedValueOnce(new Error('disk error')).mockResolvedValueOnce(true);
    expect(await applyFieldMigrations([migration, second], write, async () => true))
      .toEqual({ saved: true, retained: [second], failed: [migration] });
  });
});
