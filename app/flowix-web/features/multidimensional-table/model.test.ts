import { describe, expect, it } from 'vitest';
import { addCalendarDateView, addTableView, canEditTableAutoCollectFilter, createTableDocument, parseTableDocument, serializeTableDocument, validateTableDocument, withTableAutoCollect } from './model';
import { NOTE_CALENDAR_DATE_FIELD_ID, NOTE_ICON_FIELD_ID, NOTE_TAGS_FIELD_ID } from './builtin-fields';

describe('table format v2', () => {
  it('creates normalized field state with only tags and icon as default presets', () => {
    const table = createTableDocument();
    expect(table.dataset.schema.preset_fields).toEqual([NOTE_TAGS_FIELD_ID, NOTE_ICON_FIELD_ID]);
    expect(table.dataset.schema.field_order[0]).toBe(table.dataset.schema.primary_field_id);
    expect(table.dataset.schema.field_order).toContain(NOTE_TAGS_FIELD_ID);
    expect(table.dataset.schema.field_order).toContain(NOTE_ICON_FIELD_ID);
  });

  it('round trips a new table', () => {
    const table = createTableDocument();
    expect(table.collection.type).toBe('table');
    expect(parseTableDocument(serializeTableDocument(table))).toEqual(table);
  });

  it('creates each view type over the shared records without requiring a data table view', () => {
    for (const type of ['table', 'kanban', 'calendar', 'gallery'] as const) {
      const document = createTableDocument(type);
      expect(document.views.items).toHaveLength(1);
      expect(document.views.items[0].layout).toBe(type);
      expect(document.dataset.records).toEqual({ include: [], exclude: [] });
      expect(parseTableDocument(serializeTableDocument(document))).toEqual(document);
    }
  });

  it('adds a second data table view without copying records', () => {
    const document = createTableDocument('gallery');
    const added = addTableView(document, 'table');
    expect(added.document.views.items.map((view) => view.layout)).toEqual(['gallery', 'table']);
    expect(added.document.dataset.records).toBe(document.dataset.records);
  });

  it('rejects unsupported versions', () => {
    const table = createTableDocument();
    expect(() => parseTableDocument(serializeTableDocument(table).replace('schema_version: 2', 'schema_version: 3'))).toThrow('不支持');
  });

  it('rejects duplicate linked notes', () => {
    const table = createTableDocument();
    const records = ['a', 'b'].map((suffix) => ({
      id: `rec_${suffix.repeat(32)}`, updated_at: '', note_path: 'same.md',
    }));
    expect(() => parseTableDocument(serializeTableDocument({ ...table, dataset: { ...table.dataset, records: { ...table.dataset.records, include: records } } }))).toThrow('重复关联');
  });

  it('rejects property values duplicated in table records', () => {
    const table = createTableDocument();
    const record = {
      id: `rec_${'a'.repeat(32)}`,
      updated_at: '',
      note_path: '计划/项目.md',
      values: { status: '进行中' },
    };
    expect(() => validateTableDocument({ ...table, dataset: { ...table.dataset, records: { ...table.dataset.records, include: [record] } } })).toThrow('表格记录格式无效');
  });

  it('keeps conditions for note properties that are not table fields', () => {
    const table = createTableDocument();
    const withCondition = withTableAutoCollect(table, {
          condition: {
            property_match: 'union' as const,
            property_conditions: [{ field_id: 'workflow', operator: 'contains' as const, value: 'release' }],
          },
        });

    expect(parseTableDocument(serializeTableDocument(withCondition))).toEqual(withCondition);
  });

  it('prevents the compact rule editor from rewriting filters it cannot represent', () => {
    const table = createTableDocument();
    const filter = { all: [{ field: 'workflow', op: 'in', value: ['ready', 'blocked'] }], any: [] };
    expect(canEditTableAutoCollectFilter({ ...table, dataset: { ...table.dataset, filter } })).toBe(false);
    expect(canEditTableAutoCollectFilter(table)).toBe(true);
  });
});


it('creates calendars with the editable date preset and round trips the shared backend fixture', async () => {
  const calendar = createTableDocument('calendar');
  expect(calendar.views.items[0].config.date_field).toBe(NOTE_CALENDAR_DATE_FIELD_ID);
  expect(calendar.dataset.schema.preset_fields).toContain(NOTE_CALENDAR_DATE_FIELD_ID);
  const fixture = (await import('../../../fixtures/collections/table-calendar-preset.yaml?raw')).default;
  const parsed = parseTableDocument(fixture);
  expect(parseTableDocument(serializeTableDocument(parsed))).toEqual(parsed);
  expect(parsed.views.items[0].config.date_field).toBe(calendar.views.items[0].config.date_field);
});

it('reuses existing date fields and rejects conflicting types across calendar creation paths', () => {
  const document = createTableDocument();
  const existing = { id: 'fld_dddddddddddddddddddddddddddddddd', type: 'Date' as const, property_key: 'calendar_date' };
  document.dataset.schema.fields.push(existing);
  const reused = addCalendarDateView(document);
  expect(reused.view.config.date_field).toBe(existing.id);
  expect(reused.document.dataset.schema.preset_fields).not.toContain(NOTE_CALENDAR_DATE_FIELD_ID);
  document.dataset.schema.fields[1] = { ...existing, type: 'Text' };
  expect(() => addCalendarDateView(document)).toThrow('不是日期类型');
  const first = addCalendarDateView(createTableDocument());
  const second = addCalendarDateView(first.document);
  expect(second.document.dataset.schema.preset_fields.filter((id) => id === NOTE_CALENDAR_DATE_FIELD_ID)).toHaveLength(1);
});
