import { describe, expect, it } from 'vitest';
import { addKanbanView, addTableView, createTableDocument, parseTableDocument, serializeTableDocument } from './model';
import { rememberTableView, removeTableView, resolveTableView } from './view-selection';

describe('remembered table views', () => {
  it('restores the file selection after serialization, while embedded references take priority', () => {
    const original = createTableDocument();
    const first = original.views.items[0];
    const added = addTableView(original, 'gallery');
    const remembered = rememberTableView(added.document, first.id);
    const reopened = parseTableDocument(serializeTableDocument(remembered));
    expect(resolveTableView(reopened)?.id).toBe(first.id);
    expect(resolveTableView(reopened, added.view.id)?.id).toBe(added.view.id);
    expect(resolveTableView(reopened, 'deleted-embedded-view')?.id).toBe(first.id);
    expect(rememberTableView(remembered, first.id)).toBe(remembered);
    expect(rememberTableView(remembered, 'missing')).toBe(remembered);
    expect(remembered.collection.revision).toBe(added.document.collection.revision + 1);
  });

  it('falls back to document order, even when the first view is not a table', () => {
    const added = addTableView(createTableDocument('gallery'), 'table');
    const stale = { ...added.document, views: { ...added.document.views, default_id: 'deleted-view' } };
    expect(resolveTableView(stale, 'deleted-reference')?.layout).toBe('gallery');
    const serialized = serializeTableDocument(added.document).replace(added.view.id, 'view_ffffffffffffffffffffffffffffffff');
    const restored = parseTableDocument(serialized);
    expect(restored.views.default_id).toBe(restored.views.items[0].id);
  });

  it('creates views with their selection and deletes the remembered view atomically', () => {
    for (const added of [addTableView(createTableDocument(), 'calendar'), addKanbanView(createTableDocument())]) {
      expect(added.document.views.default_id).toBe(added.view.id);
      const next = removeTableView(added.document, added.view.id);
      const reopened = parseTableDocument(serializeTableDocument(next));
      expect(reopened.views.default_id).toBe(reopened.views.items[0].id);
      expect(reopened.views.items.some((view) => view.id === added.view.id)).toBe(false);
      expect(removeTableView(reopened, reopened.views.items[0].id)).toBe(reopened);
    }
  });

  it('retains the remembered view when a different view is deleted', () => {
    const original = createTableDocument();
    const added = addTableView(original, 'gallery');
    expect(removeTableView(added.document, original.views.items[0].id).views.default_id).toBe(added.view.id);
  });
});
