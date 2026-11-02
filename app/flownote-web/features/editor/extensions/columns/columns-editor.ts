import { ColumnsNode, ColumnNode } from './columns';
import { columnNodeView, columnsNodeView } from './columns-node-view';

/**
 * Editor-only variants. The worker registry imports `columns.ts` directly so
 * it never pulls in NodeViews or their i18n/store dependencies.
 */
export const ColumnsEditorNode = ColumnsNode.extend({
  addNodeView() {
    return columnsNodeView;
  },
});

export const ColumnEditorNode = ColumnNode.extend({
  addNodeView() {
    return columnNodeView;
  },
});
