import { describe, expect, it } from 'vitest';
import { getAllPresets } from '@features/document/properties/presets';
import { addCalendarDateView, addTableView, createTableDocument, createUuidV7 } from './model';
import { addPresetField, toggleDatasetTableFieldVisibility, changeFieldType, removeBuiltinField, removeField, removePresetField, renameField } from './table-commands';

function documentWithField() {
  const document = createTableDocument();
  const fieldId = `fld_${createUuidV7()}`;
  document.dataset.schema.fields.push({ id: fieldId, type: 'Text', property_key: 'status' });
  document.views.items[0].config.visible_fields = [document.dataset.schema.primary_field_id, fieldId];
  document.dataset.records.include.push({ id: `rec_${createUuidV7()}`, updated_at: '', note_path: 'note.md' });
  return { document, fieldId };
}

describe('table field commands', () => {
  it('keeps preset registration separate from visibility and only removes hidden presets', () => {
    const document = createTableDocument();
    const preset = getAllPresets([], (key) => key).find((item) => item.key === 'flowix_colors')!;
    const added = addPresetField(document, preset);
    const fieldId = added.dataset.schema.fields.find((field) => field.property_key === 'flowix_colors')!.id;
    expect(fieldId).toMatch(/^fld_/);
    expect(added.dataset.schema.preset_fields).not.toContain('__note_colors__');
    expect(added.views.items[0].config.visible_fields).toContain(fieldId);
    expect(() => removePresetField(added, preset)).toThrow('仅支持移除隐藏字段');

    const hidden = toggleDatasetTableFieldVisibility(added, fieldId);
    const removed = removePresetField(hidden, preset);
    expect(removed.dataset.schema.preset_fields).not.toContain('__note_colors__');
    expect(removed.dataset.schema.field_order).not.toContain(fieldId);
  });

  it('adds and removes custom presets through the same field lifecycle', () => {
    const document = createTableDocument();
    const preset = { source: 'custom', category: 'custom', key: 'rating', label: '评分', kind: 'Number' } as const;
    const added = addPresetField(document, preset);
    const field = added.dataset.schema.fields.find((item) => item.property_key === 'rating');
    expect(field?.type).toBe('Number');
    expect(added.views.items[0].config.visible_fields).toContain(field?.id);

    const hidden = toggleDatasetTableFieldVisibility(added, field!.id);
    const removed = removePresetField(hidden, preset);
    expect(removed.dataset.schema.fields.some((item) => item.id === field!.id)).toBe(false);
  });

  it('renames only the display label', () => {
    const { document, fieldId } = documentWithField();
    const next = renameField(document, fieldId, '状态');
    expect(next.dataset.schema.fields[1]).toMatchObject({ name: '状态', property_key: 'status' });
    expect(document.dataset.schema.fields[1].name).toBeUndefined();
  });

  it('changes the field type without changing record values', () => {
    const { document, fieldId } = documentWithField();
    const next = changeFieldType(document, fieldId, 'URL');
    expect(next.dataset.schema.fields[1].type).toBe('URL');
    expect(next.dataset.records).toEqual(document.dataset.records);
  });

  it('removes the field while keeping linked note references intact', () => {
    const { document, fieldId } = documentWithField();
    const next = removeField(document, fieldId);
    expect(next.dataset.schema.fields).toHaveLength(1);
    expect(next.dataset.records).toEqual(document.dataset.records);
    expect(next.views.items[0].config.visible_fields).not.toContain(fieldId);
  });

  it('keeps a view when a required grouping field removal is attempted', () => {
    const { document, fieldId } = documentWithField();
    document.views.items.push({ id: `view_${createUuidV7()}`, name: '看板', layout: 'kanban', filter: { all: [], any: [] }, sort: [], config: { group_by: fieldId } });
    expect(() => removeField(document, fieldId)).toThrow('请先调整依赖此属性的视图');
    expect(document.views.items.map((view) => view.layout)).toEqual(['table', 'kanban']);
  });

  it('keeps a dependent view configured when its field type changes', () => {
    const { document, fieldId } = documentWithField();
    document.dataset.schema.fields[1].type = 'Select';
    document.views.items.push({ id: `view_${createUuidV7()}`, name: '看板', layout: 'kanban', filter: { all: [], any: [] }, sort: [], config: { group_by: fieldId } });
    const next = changeFieldType(document, fieldId, 'Text');
    expect(next.dataset.schema.fields[1].type).toBe('Text');
    expect(next.views.items[1]).toMatchObject({ layout: 'kanban', config: { group_by: fieldId } });
  });
});

it('shares dataset column visibility across table views and preserves other layouts', () => {
  let document = createTableDocument('table', '项目', 'folder');
  document = addTableView(document, 'table').document;
  document = addTableView(document, 'calendar').document;
  document = addTableView(document, 'gallery').document;
  const fieldId = '__note_size__';
  document.views.items[0].config.visible_fields = [...document.views.items[0].config.visible_fields as string[], fieldId];
  const before = document.views.items.slice(2);
  const shown = toggleDatasetTableFieldVisibility(document, fieldId);
  expect(shown.views.items.slice(0, 2).every((view) => (view.config.visible_fields as string[]).includes(fieldId))).toBe(true);
  expect(shown.views.items.slice(2)).toEqual(before);
  const hidden = toggleDatasetTableFieldVisibility(shown, fieldId);
  expect(hidden.views.items.slice(0, 2).every((view) => !(view.config.visible_fields as string[]).includes(fieldId))).toBe(true);
  expect(hidden.views.items.slice(2)).toEqual(before);
  expect(toggleDatasetTableFieldVisibility(document, document.dataset.schema.primary_field_id)).toBe(document);
  const calendar = createTableDocument('calendar');
  expect(toggleDatasetTableFieldVisibility(calendar, fieldId)).toBe(calendar);
});

it('removes field sort references while preserving unrelated sorts and note properties', () => {
  const { document, fieldId } = documentWithField();
  document.views.items[0].sort = [
    { field: fieldId, direction: 'asc' },
    { field: 'status', direction: 'desc' },
    { field: 'modified_at', direction: 'desc' },
  ];
  const next = removeField(document, fieldId);
  expect(next.views.items[0].sort).toEqual([{ field: 'modified_at', direction: 'desc' }]);
  expect(next.dataset.records).toBe(document.dataset.records);
  expect(document.views.items[0].sort).toHaveLength(3);
});


it('prevents both removal paths from removing a date preset used by a calendar', () => {
  const { document } = addCalendarDateView(createTableDocument());
  const preset = getAllPresets([], (key) => key).find((item) => item.key === 'calendar_date')!;
  expect(() => removePresetField(document, preset)).toThrow('请先调整依赖此属性的视图');
  expect(() => removeBuiltinField(document, '__note_calendar_date__')).toThrow('请先调整依赖此属性的视图');
});
