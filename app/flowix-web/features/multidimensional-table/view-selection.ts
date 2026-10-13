import { reviseCollection } from '@features/collection/model';
import type { MultidimensionalTableDocument, TableView } from './model';

/** Embedded reference, then the file's remembered view, then document order. */
export function resolveTableView(document: MultidimensionalTableDocument, preferredId?: string | null): TableView | undefined {
  return document.views.items.find((view) => view.id === preferredId)
    ?? document.views.items.find((view) => view.id === document.views.default_id)
    ?? document.views.items[0];
}

export function rememberTableView(document: MultidimensionalTableDocument, viewId: string): MultidimensionalTableDocument {
  if (document.views.default_id === viewId || !document.views.items.some((view) => view.id === viewId)) return document;
  return { ...document, collection: reviseCollection(document.collection), views: { ...document.views, default_id: viewId } };
}

export function removeTableView(document: MultidimensionalTableDocument, viewId: string): MultidimensionalTableDocument {
  const items = document.views.items.filter((view) => view.id !== viewId);
  if (!items.length || items.length === document.views.items.length) return document;
  const next = { ...document, views: { ...document.views, items } };
  return { ...next, collection: reviseCollection(document.collection),
    views: { ...next.views, default_id: resolveTableView(next)!.id } };
}
