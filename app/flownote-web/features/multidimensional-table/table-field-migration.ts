import type { TableField, TableFieldOption } from './model';

export interface FieldValueMigration {
  noteKey: string;
  previousValue: unknown;
  value: unknown;
  remove: boolean;
}

export function planFieldMigrations(
  notes: readonly { relativePath: string; properties: Record<string, unknown> }[],
  field: TableField,
  nextKey: string,
  options?: readonly TableFieldOption[],
): FieldValueMigration[] {
  const previousKey = field.property_key;
  if (!previousKey) return [];
  const keyChanged = previousKey !== nextKey;
  const migrations = new Map<string, FieldValueMigration>();
  for (const note of notes) {
    const noteKey = note.relativePath.replace(/\\/g, '/');
    if (migrations.has(noteKey) || !Object.prototype.hasOwnProperty.call(note.properties, previousKey)) continue;
    if (keyChanged && Object.prototype.hasOwnProperty.call(note.properties, nextKey)) {
      throw new Error(`笔记“${noteKey}”已存在属性“${nextKey}”，未执行改名`);
    }
    const previousValue = note.properties[previousKey];
    const update = (options ? migratedOptionValue(field, options, previousValue) : null)
      ?? (keyChanged ? { value: previousValue, remove: false } : null);
    if (update) migrations.set(noteKey, { noteKey, previousValue, ...update });
  }
  return [...migrations.values()];
}

/** Unknown values belong to the note and must survive option edits. */
export function migratedOptionValue(field: TableField, options: readonly TableFieldOption[], value: unknown) {
  const nextById = new Map(options.map((option) => [option.id, option]));
  const oldOptionFor = (item: unknown) => field.options?.find((option) => option.label === item || option.id === item);
  if (field.type === 'Select') {
    const old = oldOptionFor(value);
    if (!old) return null;
    const next = nextById.get(old.id);
    return !next || next.label === value ? null : { value: next.label, remove: false };
  }
  if (field.type !== 'MultiSelect' || !Array.isArray(value)) return null;
  const nextValue = value.flatMap((item) => {
    const old = oldOptionFor(item);
    if (!old) return [item];
    const next = nextById.get(old.id);
    return next ? [next.label] : [item];
  });
  return JSON.stringify(value) === JSON.stringify(nextValue) ? null : { value: nextValue, remove: false };
}

/** Save the current table first. Related note writes are independent and never
 * roll back a successfully saved table or overwrite concurrently changed values.
 */
export async function applyFieldMigrations(
  migrations: readonly FieldValueMigration[],
  write: (migration: FieldValueMigration) => Promise<boolean>,
  commit: () => Promise<boolean>,
) {
  try {
    if (!await commit()) return { saved: false, retained: [], failed: [] };
  } catch { return { saved: false, retained: [], failed: [] }; }
  const retained: FieldValueMigration[] = [];
  const failed: FieldValueMigration[] = [];
  for (const migration of migrations) {
    try {
      if (await write(migration)) { retained.push(migration); continue; }
    } catch { /* A related document failure leaves the primary save intact. */ }
    failed.push(migration);
  }
  return { saved: true, retained, failed };
}
