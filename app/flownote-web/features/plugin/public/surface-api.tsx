import { lazy, type ComponentProps } from 'react';

export type PluginDocumentViewProps = ComponentProps<
  typeof import('../plugin-document-view').PluginDocumentView
>;
export type PluginWorkbenchProps = ComponentProps<
  typeof import('../plugin-workbench').PluginWorkbench
>;

export const LazyPluginDocumentView = lazy(() =>
  import('../plugin-document-view').then((module) => ({
    default: module.PluginDocumentView,
  })),
);

export const LazyPluginWorkbench = lazy(() =>
  import('../plugin-workbench').then((module) => ({
    default: module.PluginWorkbench,
  })),
);
