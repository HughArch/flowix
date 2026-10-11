import { describe, expect, it } from 'vitest';
import { createTableDocument, createUuidV7 } from './model';
import { changeFieldType, removeField, renameField } from './table-commands';

function documentWithField() {
  const document = createTableDocument();
  const fieldId = `fld_${createUuidV7()}`;
  document.dataset.schema.fields.push({ id: fieldId, type: 'Text', property_key: 'status' });
  document.views.items[0].config.visible_fields = [document.dataset.schema.primary_field_id, fieldId];
  document.dataset.records.include.push({ id: `rec_${createUuidV7()}`, updated_at: '', note_path: 'note.md' });
  return { document, fieldId };
}

describe('table field commands', () => {
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

  it('rejects changing a field type required by a view', () => {
    const { document, fieldId } = documentWithField();
    document.dataset.schema.fields[1].type = 'Select';
    document.views.items.push({ id: `view_${createUuidV7()}`, name: '看板', layout: 'kanban', filter: { all: [], any: [] }, sort: [], config: { group_by: fieldId } });
    expect(() => changeFieldType(document, fieldId, 'Text')).toThrow('请先调整依赖此属性的视图');
  });
});
