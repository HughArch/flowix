'use client';

import {
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
} from 'react';
import { useDocumentStore } from '@features/document/store/document-store';
import type {
  WorkColumnContentPresentation, WorkColumnSurface,
  WorkColumnSurfaceCapability, WorkColumnSurfaceChrome,
} from './types';
import { workspaceSurfaceAppearance } from '@features/workspace/public/surface-api';
import type { SurfaceAppearance } from '@features/workspace/public/surface-api';
import {
  getWorkspaceSurfaceRendererDefinition,
  WorkspaceSurfaceRendererView,
} from './workspace-surface-renderer-registry';
import { WorkspaceSurfaceStateView } from './workspace-surface-state-view';

import { workspaceSurfaceRendererDataFromWorkSurface } from './work-column-surface-adapter';
import { registerStartupSurfaceHostView, registerWorkspaceSurfacePresentationOwner, reportEmptyWorkspaceSurfaceForIdentity, reportWorkspaceSurfacePresentation } from './workspace-surface-runtime';
import type { SurfacePresentationUpdate } from '@features/workspace/model/surface-contract';
import type { SurfaceLifecycle } from '@features/workspace/model/surface-contract';
import { registerWorkspaceSurfaceLifecycle } from '@features/workspace/public/surface-lifecycle-api';

export interface WorkColumnSurfaceDefinition {
  appearance: Readonly<SurfaceAppearance>;
  chrome: WorkColumnSurfaceChrome;
  capabilities: readonly WorkColumnSurfaceCapability[];
  render: () => ReactNode;
}

/** Work adapts navigation data; renderer registration belongs to the common registry. */
export function getWorkColumnSurfaceDefinition(
  surface: WorkColumnSurface,
  reportPresentation?: (update: SurfacePresentationUpdate) => void,
  registerLifecycle?: (lifecycle: SurfaceLifecycle | null, owner?: object) => void,
  focused = false,
): WorkColumnSurfaceDefinition {
  const data = workspaceSurfaceRendererDataFromWorkSurface(surface);
  const definition = getWorkspaceSurfaceRendererDefinition(data);
  return {
    appearance: definition.appearance,
    chrome: definition.appearance.headerStyle,
    capabilities: definition.capabilities,
    render: () => <WorkspaceSurfaceRendererView
      surface={data}
      context={{
        host: 'main-third', viewId: surface.instanceKey, focused,
        initialFocus: initialFocusForSurface(surface),
        readOnly: 'props' in surface && 'readOnly' in surface.props ? Boolean(surface.props.readOnly) : false,
        reportPresentation: reportPresentation ?? ((update) => reportWorkspaceSurfacePresentation(surface.instanceKey, update)),
        registerLifecycle,
      }}
    />,
  };
}

function initialFocusForSurface(surface: WorkColumnSurface): 'title' | 'body' | undefined {
  if (!('props' in surface) || !surface.props || !('initialFocus' in surface.props)) return undefined;
  const value = surface.props.initialFocus;
  return value === 'title' || value === 'body' ? value : undefined;
}

export function surfaceSupports(
  surface: WorkColumnSurface,
  capability: WorkColumnSurfaceCapability,
): boolean {
  return getWorkColumnSurfaceDefinition(surface).capabilities.includes(capability);
}

function transitionFinishedOnMount(surface: WorkColumnSurface): number | null {
  switch (surface.kind) {
    case 'csv-file':
      return surface.transitionId ?? null;
    case 'image-file':
    case 'video-file':
    case 'unavailable-file':
      return surface.props.transitionId ?? null;
    default:
      return null;
  }
}

function WorkColumnSurfaceMount({ surface, focused }: { surface: WorkColumnSurface; focused: boolean }) {
  const immediateTransitionId = transitionFinishedOnMount(surface);
  const presentationScope = `${surface.kind}:${surface.instanceKey}:${'fileIdentity' in surface ? surface.fileIdentity.path : ''}`;
  const presentationOwner = useMemo(() => ({}), [presentationScope]);
  const reportPresentation = useCallback((update: SurfacePresentationUpdate) => {
    reportWorkspaceSurfacePresentation(surface.instanceKey, update, presentationOwner);
  }, [presentationOwner, surface.instanceKey]);
  const registerLifecycle = useCallback((lifecycle: SurfaceLifecycle | null, owner?: object) => {
    registerWorkspaceSurfaceLifecycle(surface.instanceKey, lifecycle, owner);
  }, [surface.instanceKey]);

  useLayoutEffect(() => registerStartupSurfaceHostView('main-third', surface.instanceKey), [surface.instanceKey]);

  useLayoutEffect(() => {
    // These views have no DocumentContainer to finish the transition after
    // reading content; their own loading UI remains active.
    if (typeof immediateTransitionId === 'number') {
      useDocumentStore.getState().finishDocumentTransition(immediateTransitionId);
    }
  }, [immediateTransitionId]);

  useLayoutEffect(() => registerWorkspaceSurfacePresentationOwner(surface.instanceKey, presentationOwner),
    [presentationOwner, surface.instanceKey]);

  return getWorkColumnSurfaceDefinition(surface, reportPresentation, registerLifecycle, focused).render();
}

export function WorkColumnSurfaceHost({ surface, focused = false }: { surface: WorkColumnSurface; focused?: boolean }) {
  const instanceKey = `${surface.kind}:${surface.instanceKey}`;
  return <WorkColumnSurfaceMount key={instanceKey} surface={surface} focused={focused} />;
}

export function WorkColumnContentHost({ content, focused = false, startupIdentity = '' }: { content: WorkColumnContentPresentation; focused?: boolean; startupIdentity?: string }) {
  if (content.status === 'empty') {
    reportEmptyWorkspaceSurfaceForIdentity('main-third', startupIdentity);
    const baseAppearance = content.tone === 'agent' ? workspaceSurfaceAppearance('agent-conversation')
      : workspaceSurfaceAppearance('file-markdown');
    const appearance = content.actions?.length ? { ...baseAppearance, emptyDecoration: 'none' as const } : baseAppearance;
    return <WorkspaceSurfaceStateView
      appearance={appearance}
      state={{ status: 'empty', reason: content.reason, message: { key: 'document.file.loading' }, actions: content.actions }}
      messageOverride={content.message}
    />;
  }

  return <WorkColumnSurfaceHost surface={content.surface} focused={focused} />;
}
