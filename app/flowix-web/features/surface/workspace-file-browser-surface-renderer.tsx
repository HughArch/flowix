'use client';

import { collectionDisplayDescriptor, findCollectionDisplayPath } from '@/lib/collection-display-registry';
import { useExternalFileContentDetection } from '@features/editor/use-external-file-content-detection';
import { resolveWorkspaceFileSurfaceKind, workspaceSurfaceAppearance } from '@features/workspace/public/surface-api';
import { FileBrowserView } from './file-browser-view';
import { useLayoutEffect } from 'react';
import { getWorkspaceSurfaceRendererDefinition } from './workspace-surface-renderer-registry';
import type { WorkspaceSurfaceRendererData, WorkspaceSurfaceRenderContext } from './workspace-surface-renderer-contract';
import { WorkspaceSurfaceStateView } from './workspace-surface-state-view';
import { resetCurrentCollectionView } from '@features/workspace/use-cases/workspace-navigation';
import { toast } from '@/lib/toast';
import { workspaceSurfaceCapabilities } from '@features/workspace/public/surface-api';

export function FileBrowserRenderer({ surface: data, context }: {
  surface: Extract<WorkspaceSurfaceRendererData, { kind: 'file-browser' }>;
  context: WorkspaceSurfaceRenderContext;
}) {
  const surface = data.props;
  const fileSurfaceKind = surface.activeFilePath
    ? resolveWorkspaceFileSurfaceKind(surface.activeFilePath)
    : null;
  const { isTextContent, loading: contentDetectionLoading } = useExternalFileContentDetection(
    surface.activeFilePath,
    surface.scopePath,
    fileSurfaceKind === 'unavailable',
  );
  const fileKind = surface.collectionType === 'media_library'
    ? 'media-library'
    : surface.collectionType === 'table'
      ? 'table'
      : resolveWorkspaceFileSurfaceKind(surface.activeFilePath ?? '', null, isTextContent);
  const dynamicKind = `file-${fileKind}` as const;
  const collectionLocationLoading = Boolean(surface.fileIdentity
    && collectionDisplayDescriptor(surface.fileIdentity.displayId)
    && !findCollectionDisplayPath(surface.fileIdentity.displayId));
  // Publish the resolver baseline before content renderers publish their state.
  useLayoutEffect(() => {
    if (!surface.activeFilePath) {
      context.reportPresentation?.({
        appearance: workspaceSurfaceAppearance('file-browser'),
        capabilities: workspaceSurfaceCapabilities('file-browser'),
        state: { status: 'ready' },
      });
      return;
    }
    const state = contentDetectionLoading
          ? { status: 'loading' as const, phase: 'content' as const, message: { key: 'document.file.loading' }, retainContent: true }
        : surface.collectionUnavailableReason
          ? { status: 'unavailable' as const, reason: 'unsupported' as const, message: { key: 'document.file.unavailable', fallbackText: surface.collectionUnavailableReason } }
          : collectionLocationLoading
            ? { status: 'loading' as const, phase: 'navigation' as const, message: { key: 'document.file.loading' }, retainContent: true }
          : { status: 'loading' as const, phase: 'renderer' as const, message: { key: 'document.file.loading' }, retainContent: true };
    context.reportPresentation?.({
      appearance: workspaceSurfaceAppearance(dynamicKind),
      capabilities: workspaceSurfaceCapabilities(dynamicKind),
      state,
    });
  }, [collectionLocationLoading, context.reportPresentation, dynamicKind, contentDetectionLoading, surface.activeFilePath, surface.collectionUnavailableReason]);
  if (!surface.activeFilePath) {
    return <FileBrowserView surface={{ ...surface, sourceMenuEnabled: false }} />;
  }

  const stateAppearance = workspaceSurfaceAppearance(`file-${fileSurfaceKind ?? 'unavailable'}`);
  if (surface.collectionUnavailableReason) return <WorkspaceSurfaceStateView
    appearance={stateAppearance}
    state={{
      status: 'unavailable', reason: 'unsupported', message: { key: 'document.file.loading' },
      actions: [{
        id: 'reset-current-collection-view', label: { key: 'collection.resetCurrentView' }, enabled: true,
        run: async () => {
          try { await resetCurrentCollectionView(surface.activeFilePath!, surface.scopePath, surface.notebookId, { host: 'browser-column', tabId: context.viewId }); }
          catch (error) { toast.error(error instanceof Error ? error.message : '重置当前视图失败'); }
        },
      }],
    }}
    messageOverride={surface.collectionUnavailableReason}
  />;
  if (surface.fileIdentity && collectionDisplayDescriptor(surface.fileIdentity.displayId) && !findCollectionDisplayPath(surface.fileIdentity.displayId)) return <WorkspaceSurfaceStateView
    appearance={stateAppearance}
    state={{ status: 'loading', phase: 'navigation', message: { key: 'document.file.loading' }, retainContent: false }}
    messageOverride="正在解析集合位置…"
  />;
  if (contentDetectionLoading) return null;
  const filePath = surface.activeFilePath;
  const fileIdentity = surface.fileIdentity;
  if (!filePath || !fileIdentity) return <FileBrowserView surface={{ ...surface, sourceMenuEnabled: false }} />;

  const expectedCollectionId = collectionDisplayDescriptor(fileIdentity.displayId)?.collectionId ?? null;
  let fileSurface: WorkspaceSurfaceRendererData;
  switch (fileKind) {
    case 'markdown':
      fileSurface = { kind: 'file-markdown', fileIdentity, scopePath: surface.scopePath, documentProps: surface.documentProps };
      break;
    case 'code':
      fileSurface = { kind: 'file-code', fileIdentity, scopePath: surface.scopePath, documentProps: surface.documentProps, instanceKey: context.viewId };
      break;
    case 'csv':
      fileSurface = { kind: 'file-csv', fileIdentity, scopePath: surface.scopePath };
      break;
    case 'image':
      fileSurface = { kind: 'file-image', fileIdentity, scopePath: surface.scopePath };
      break;
    case 'video':
      fileSurface = { kind: 'file-video', fileIdentity, scopePath: surface.scopePath };
      break;
    case 'table':
      fileSurface = {
        kind: 'file-table', fileIdentity,
        props: {
          filePath, fileIdentity, notebookPath: surface.scopePath, notebookId: surface.notebookId ?? null,
          expectedCollectionId, initialViewId: surface.collectionDisplay?.viewId,
          onActiveViewChange: context.onCollectionActiveViewChange,
        },
      };
      break;
    case 'media-library':
      fileSurface = {
        kind: 'file-media-library', fileIdentity, notebookPath: surface.scopePath,
        notebookId: surface.notebookId ?? null, expectedCollectionId,
      };
      break;
    case 'html':
      fileSurface = { kind: 'file-html', fileIdentity, scopePath: surface.scopePath, documentProps: surface.documentProps };
      break;
    case 'docx':
      fileSurface = { kind: 'file-docx', fileIdentity, scopePath: surface.scopePath };
      break;
    case 'unavailable':
      fileSurface = { kind: 'file-unavailable', fileIdentity, scopePath: surface.scopePath, documentProps: surface.documentProps };
      break;
  }

  // The outer workspace view owns presentation and Suspense/error boundaries.
  // Rendering content directly avoids applying the same state/notices twice.
  return getWorkspaceSurfaceRendererDefinition(fileSurface).render(fileSurface, {
      ...context,
      viewId: context.viewId,
      readOnly: Boolean(surface.documentProps.readOnly),
      wrapInFileBrowser: (content) => <FileBrowserView surface={{
        ...surface,
        fileTreeEnabled: false,
        sourceMenuEnabled: false,
        content,
      }} />,
    });
}
