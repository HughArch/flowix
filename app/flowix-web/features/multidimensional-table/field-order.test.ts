import { expect, it } from 'vitest';
import { createTableDocument, parseTableDocument, serializeTableDocument } from './model';
import { sortFields } from './field-order';
import { removeField } from './table-commands';

it('persists mixed builtin and custom field order, keeps primary first and appends new fields', () => {
  const doc = createTableDocument();
  const id = `fld_${'a'.repeat(32)}`;
  doc.dataset.schema.fields.push({ id, type: 'Text', property_key: 'status' });
  doc.dataset.schema.field_order = [doc.dataset.schema.primary_field_id, '__note_tags__', id];
  const reloaded = parseTableDocument(serializeTableDocument(doc));
  expect(reloaded.dataset.schema.field_order.slice(0, 3)).toEqual(doc.dataset.schema.field_order);
  expect(sortFields([{ id }, { id: '__note_tags__' }], (item) => item.id, reloaded.dataset.schema.field_order)).toEqual([{ id: '__note_tags__' }, { id }]);
  expect(removeField(doc, id).dataset.schema.field_order).not.toContain(id);
  doc.dataset.schema.field_order = [id];
  expect(() => parseTableDocument(serializeTableDocument(doc))).toThrow('顺序');
});
