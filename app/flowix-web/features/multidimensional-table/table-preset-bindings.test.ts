import { describe, expect, it } from 'vitest';
import { createTableDocument, addKanbanView, addTableView, parseTableDocument, serializeTableDocument, validateTableDocument, type TableField } from './model';
import { retireTablePreset } from './table-preset-bindings';

describe('retireTablePreset', () => {
  it('keeps kanban and calendar layouts when their configured field is removed', () => {
    const kanban = addKanbanView(createTableDocument());
    const kanbanPreset = { id: kanban.field.id, key: 'status', type: 'Select' as const, revision: 1 };
    const retiredKanban = retireTablePreset(kanban.document, kanbanPreset);
    const savedKanban = retiredKanban.views.items.find((view) => view.id === kanban.view.id)!;

    expect(savedKanban.layout).toBe('kanban');
    expect(savedKanban.config.group_by).toBe(kanban.field.id);
    expect(retiredKanban.dataset.schema.fields.some((field) => field.id === kanban.field.id)).toBe(false);
    expect(parseTableDocument(serializeTableDocument(retiredKanban)).views.items.find((view) => view.id === kanban.view.id)?.layout).toBe('kanban');

    const calendar = createTableDocument();
    const dateField: TableField = { id: `fld_${'d'.repeat(32)}`, property_key: 'meeting_date', type: 'Date' };
    calendar.dataset.schema.fields.push(dateField);
    calendar.dataset.schema.field_order.push(dateField.id);
    const withCalendar = addTableView(calendar, 'calendar', dateField.id).document;
    const retiredCalendar = retireTablePreset(withCalendar, { id: dateField.id, key: 'meeting_date', type: 'Date', revision: 1 });
    const savedCalendar = retiredCalendar.views.items.find((view) => view.layout === 'calendar')!;

    expect(savedCalendar.config.date_field).toBe(dateField.id);
    expect(retiredCalendar.dataset.schema.fields.some((field) => field.id === dateField.id)).toBe(false);
    expect(validateTableDocument(parseTableDocument(serializeTableDocument(retiredCalendar))).views.items.find((view) => view.id === savedCalendar.id)?.layout).toBe('calendar');
  });
});
