import { describe, expect, it } from 'vitest';
import { addCalendarDateView, addTableView, canEditTableAutoCollectFilter, createTableDocument, parseTableDocument, serializeTableDocument, validateTableDocument, withTableAutoCollect } from './model';
import { NOTE_CALENDAR_DATE_FIELD_ID, NOTE_ICON_FIELD_ID, NOTE_TAGS_FIELD_ID } from './builtin-fields';

describe('table format v2', () => {
  it.each(['Tags', 'noteTag'])('migrates legacy %s fields to Tag on load and save', (legacyType) => {
    const table = createTableDocument();
    table.dataset.schema.fields.push({
      id: 'fld_' + 'a'.repeat(32), type: 'Tag', property_key: 'topics',
    });
    const source = serializeTableDocument(table).replace('type: Tag', `type: ${legacyType}`);
    const parsed = parseTableDocument(source);
    expect(parsed.dataset.schema.fields.find((field) => field.property_key === 'topics')?.type).toBe('Tag');
    expect(serializeTableDocument(parsed)).not.toContain(`type: ${legacyType}`);
  });

  it('rejects duplicate option labels even when the option IDs differ', () => {
    const table = createTableDocument();
    table.dataset.schema.fields.push({
      id: 'fld_' + 'a'.repeat(32), type: 'Select', property_key: 'status',
      options: [
        { id: 'opt_' + 'b'.repeat(32), label: 'done' },
        { id: 'opt_' + 'c'.repeat(32), label: ' done ' },
      ],
    });
    expect(() => validateTableDocument(table)).toThrow('选项名称重复');
  });
  it('drops legacy table tombstone copies on save and still validates old input', () => {
    const table = createTableDocument();
    table.dataset.schema.deleted_presets = [{
      id: 'fld_' + 'a'.repeat(32), key: 'topics', type: 'Tag', revision: 2,
    }];
    expect(parseTableDocument(serializeTableDocument(table)).dataset.schema.deleted_presets).toBeUndefined();
    table.dataset.schema.deleted_presets[0]!.id = 'invalid';
    expect(() => validateTableDocument(table)).toThrow('已删除预设定义无效');
  });
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

  it('can reopen files with widths saved by the previous manual-resize UI', () => {
    const table = createTableDocument();
    table.views.items[0].config.tag_column_width = 320;
    expect(parseTableDocument(serializeTableDocument(table))).toEqual(table);
    table.views.items[0].config.tag_column_width = 321;
    expect(() => validateTableDocument(table)).toThrow('标签列宽度无效');
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


describe('dataset editor preservation', () => {
  it.each(['all', 'any'])('rejects duplicate legacy file conditions in %s', (match) => {
    const document = createTableDocument();
    document.dataset.filter = { all: [], any: [], [match]: [
      { field: 'file_name', op: 'contains', value: 'release' },
      { field: 'file_name', op: 'contains', value: 'draft' },
    ] };
    expect(canEditTableAutoCollectFilter(parseTableDocument(serializeTableDocument(document)))).toBe(false);
  });
  it('accepts condition reordering but still rejects lost duplicate rules', () => {
    const document = createTableDocument();
    const file = { field: 'file_name', op: 'contains', value: 'draft' };
    document.dataset.filter = { path: null, match: 'any', conditions: [file, { field: 'status', op: 'eq', value: 'ready' }] };
    expect(canEditTableAutoCollectFilter(document)).toBe(true);
    document.dataset.filter.conditions = [file, file];
    expect(canEditTableAutoCollectFilter(document)).toBe(false);
  });
});
