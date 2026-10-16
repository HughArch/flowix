'use client';

import { lazy, Suspense, useEffect, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import {
  workspaceSurfaceAppearance,
  workspaceSurfaceCapabilities,
  workspaceSurfaceRegistry,
  resolveWorkspaceFileSurfaceKind,
} from '@features/workspace/public/surface-api';
import type {
  SurfaceAppearance,
  SurfaceState,
  WorkspaceSurfaceCapability,
  WorkspaceSurfaceHost,
  WorkspaceSurfaceKind,
} from '@features/workspace/public/surface-api';
import { WorkspaceSurfaceErrorBoundary, WorkspaceSurfaceStateView } from './workspace-surface-state-view';
import { registerStartupSurfaceHostView, useWorkspaceSurfacePresentation } from './workspace-surface-runtime';

export type { WorkspaceSurfaceRendererData, WorkspaceSurfaceRenderContext } from './workspace-surface-renderer-contract';
import type { WorkspaceSurfaceRendererData, WorkspaceSurfaceRenderContext } from './workspace-surface-renderer-contract';
type EnsureSurfaceData<K extends WorkspaceSurfaceRendererData['kind']> = K;
// Adding a public surface kind requires a typed renderer data variant.
type WorkspaceSurfaceRendererKind = EnsureSurfaceData<WorkspaceSurfaceKind>;
type RendererId = typeof workspaceSurfaceRegistry[WorkspaceSurfaceKind]['rendererId'];
type SurfaceKindsForRenderer<R extends RendererId> = {
  [K in WorkspaceSurfaceKind]: typeof workspaceSurfaceRegistry[K]['rendererId'] extends R ? K : never
}[WorkspaceSurfaceKind];
type RendererProps<R extends RendererId> = {
  surface: Extract<WorkspaceSurfaceRendererData, { kind: SurfaceKindsForRenderer<R> }>;
  context: WorkspaceSurfaceRenderContext;
};

interface RendererImplementation {
  render: (surface: WorkspaceSurfaceRendererData, context: WorkspaceSurfaceRenderContext) => ReactNode;
}

export interface WorkspaceSurfaceRendererDefinition extends RendererImplementation {
  kind: WorkspaceSurfaceRendererKind;
  hosts: readonly WorkspaceSurfaceHost[];
  appearance: Readonly<SurfaceAppearance>;
  capabilities: readonly WorkspaceSurfaceCapability[];
}

function implementRenderer<R extends RendererId>(
  rendererId: R,
  Renderer: LazyExoticComponent<ComponentType<RendererProps<R>>>,
): RendererImplementation {
  return {
    render(surface, context) {
      if (workspaceSurfaceRegistry[surface.kind].rendererId !== rendererId) {
        throw new Error(`Surface '${surface.kind}' does not use renderer '${rendererId}'`);
      }
      // The public renderer ID check above correlates the data variant with the
      // component. Keep the generic assertion at this single implementation boundary.
      return <Renderer surface={surface as RendererProps<R>['surface']} context={context} />;
    },
  };
}

const MarkdownRenderer = lazy(() => import('./workspace-surface-renderers').then((module) => ({ default: module.MarkdownRenderer })));
const CodeRenderer = lazy(() => import('./workspace-surface-renderers').then((module) => ({ default: module.CodeRenderer })));
const CsvRenderer = lazy(() => import('./workspace-surface-renderers').then((module) => ({ default: module.CsvRenderer })));
const ImageRenderer = lazy(() => import('./workspace-surface-renderers').then((module) => ({ default: module.ImageRenderer })));
const VideoRenderer = lazy(() => import('./workspace-surface-renderers').then((module) => ({ default: module.VideoRenderer })));
const TableRenderer = lazy(() => import('./workspace-surface-renderers').then((module) => ({ default: module.TableRenderer })));
const MediaLibraryRenderer = lazy(() => import('./workspace-surface-renderers').then((module) => ({ default: module.MediaLibraryRenderer })));
const HtmlRenderer = lazy(() => import('./workspace-surface-renderers').then((module) => ({ default: module.HtmlRenderer })));
const DocxRenderer = lazy(() => import('./workspace-surface-renderers').then((module) => ({ default: module.DocxRenderer })));
const UnavailableRenderer = lazy(() => import('./workspace-surface-renderers').then((module) => ({ default: module.UnavailableRenderer })));
const PluginDocumentRenderer = lazy(() => import('./workspace-surface-renderers').then((module) => ({ default: module.PluginDocumentRenderer })));
const PluginWorkbenchRenderer = lazy(() => import('./workspace-surface-renderers').then((module) => ({ default: module.PluginWorkbenchRenderer })));
const CollectionRenderer = lazy(() => import('./workspace-surface-renderers').then((module) => ({ default: module.CollectionRenderer })));

/** Implementations have no host registration or independent support declarations. */
const rendererImplementations = {
  'file-markdown': implementRenderer('file-markdown', MarkdownRenderer),
  'file-code': implementRenderer('file-code', CodeRenderer),
  'file-csv': implementRenderer('file-csv', CsvRenderer),
  'file-image': implementRenderer('file-image', ImageRenderer),
  'file-video': implementRenderer('file-video', VideoRenderer),
  'file-table': implementRenderer('file-table', TableRenderer),
  'file-media-library': implementRenderer('file-media-library', MediaLibraryRenderer),
  'file-html': implementRenderer('file-html', HtmlRenderer),
  'file-docx': implementRenderer('file-docx', DocxRenderer),
  'file-unavailable': implementRenderer('file-unavailable', UnavailableRenderer),
  media: implementRenderer('media', lazy(() => import('./workspace-surface-renderers').then((module) => ({ default: module.MediaResourceRenderer })))),
  'agent-conversation': implementRenderer('agent-conversation', lazy(() => import('./workspace-surface-renderers').then((module) => ({ default: module.AgentConversationRenderer })))),
  'plugin-document': implementRenderer('plugin-document', PluginDocumentRenderer),
  'plugin-workbench': implementRenderer('plugin-workbench', PluginWorkbenchRenderer),
  collection: implementRenderer('collection', CollectionRenderer),
  web: implementRenderer('web', lazy(() => import('./workspace-web-surface-renderer').then((module) => ({ default: module.WebRenderer })))),
  'file-browser': implementRenderer('file-browser', lazy(() => import('./workspace-file-browser-surface-renderer').then((module) => ({ default: module.FileBrowserRenderer })))),
} satisfies Record<RendererId, RendererImplementation>;

function buildWorkspaceSurfaceRendererRegistry() {
  // Every entry is populated from the exhaustive public registry below.
  const definitions = {} as Record<WorkspaceSurfaceKind, WorkspaceSurfaceRendererDefinition>;
  for (const kind of Object.keys(workspaceSurfaceRegistry) as WorkspaceSurfaceKind[]) {
    const registration = workspaceSurfaceRegistry[kind];
    definitions[kind] = Object.freeze({
      kind,
      hosts: registration.hosts,
      appearance: registration.appearance,
      capabilities: registration.capabilities,
      render(surface: WorkspaceSurfaceRendererData, context: WorkspaceSurfaceRenderContext) {
        if (surface.kind !== kind) throw new Error(`Expected surface '${kind}', received '${surface.kind}'`);
        return rendererImplementations[registration.rendererId].render(surface, context);
      },
    });
  }
  return Object.freeze(definitions);
}

/** Derived from the public registration: hosts never maintain renderer maps. */
export const workspaceSurfaceRendererRegistry = buildWorkspaceSurfaceRendererRegistry();

export function workspaceSurfaceRendererSupportsHost(kind: WorkspaceSurfaceRendererData['kind'], host: WorkspaceSurfaceHost): boolean {
  return workspaceSurfaceRendererRegistry[kind].hosts.includes(host);
}

/** File-browser is a shell; its current content determines chrome and capabilities. */
export function getWorkspaceSurfaceRendererDefinition(surface: WorkspaceSurfaceRendererData): WorkspaceSurfaceRendererDefinition {
  const definition = workspaceSurfaceRendererRegistry[surface.kind];
  if (surface.kind !== 'file-browser' || !surface.props.activeFilePath) return definition;
  const props = surface.props;
  const fileKind = props.collectionType === 'table' ? 'table'
    : props.collectionType === 'media_library' ? 'media-library'
    : resolveWorkspaceFileSurfaceKind(props.activeFilePath!);
  const contentKind = `file-${fileKind}` as const;
  return { ...definition, appearance: workspaceSurfaceAppearance(contentKind), capabilities: workspaceSurfaceCapabilities(contentKind) };
}

export function WorkspaceSurfaceRendererView({
  surface,
  context,
  state = { status: 'ready' },
}: {
  surface: WorkspaceSurfaceRendererData;
  context: WorkspaceSurfaceRenderContext;
  state?: SurfaceState;
}) {
  const definition = getWorkspaceSurfaceRendererDefinition(surface);
  const runtime = useWorkspaceSurfacePresentation(context.viewId);
  useEffect(() => registerStartupSurfaceHostView(context.host, context.viewId), [context.host, context.viewId]);
  const appearance = runtime.appearance ?? definition.appearance;
  const resolvedState = runtime.state ?? state;
  const contentIdentity = surface.kind === 'file-browser'
    ? surface.props.fileIdentity?.displayId ?? surface.props.activeFilePath ?? 'folder'
    : 'fileIdentity' in surface ? surface.fileIdentity.displayId : '';
  if (!definition.hosts.includes(context.host)) {
    throw new Error(`Workspace host '${context.host}' does not support '${surface.kind}'`);
  }
  const backgroundClass = appearance.contentBackground === 'document'
    ? 'bg-[var(--document-bg)]'
    : 'bg-[var(--agent-bg,var(--document-bg))]';
  return <div data-workspace-surface={surface.kind} data-surface-capabilities={(runtime.capabilities ?? definition.capabilities).join(' ')} className={`flex h-full min-h-0 w-full flex-col ${backgroundClass}`}>
    <WorkspaceSurfaceErrorBoundary key={`${context.viewId}:${surface.kind}:${contentIdentity}`} appearance={appearance}>
      <WorkspaceSurfaceStateView state={resolvedState} appearance={appearance} keepContentMounted>
        <Suspense fallback={<WorkspaceSurfaceStateView
          appearance={appearance}
          state={{ status: 'loading', phase: 'renderer', message: { key: 'memo.navigation.loading' }, retainContent: false }}
        />}>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{definition.render(surface, context)}</div>
        </Suspense>
      </WorkspaceSurfaceStateView>
    </WorkspaceSurfaceErrorBoundary>
  </div>;
}
