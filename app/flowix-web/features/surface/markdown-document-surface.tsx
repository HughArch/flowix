'use client';

import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { notes } from '@platform/tauri/client';
import { DocumentContainer } from '@features/document/components/document-container';
import { PluginArtifactRenderer } from '@features/plugin/plugin-artifact-renderer';
import { normalizePluginArtifactRenderer, type PluginArtifactRendererId } from '@features/plugin/plugin-note';
import { extractFrontmatter } from '@features/document/properties/frontmatter-model';
import { workspaceSurfaceAppearance, workspaceSurfaceCapabilities } from '@features/workspace/public/surface-api';
import type { FileDisplayIdentity } from '@/lib/file-display-registry';
import type { SurfacePresentationUpdate } from '@features/workspace/model/surface-contract';
import type { SurfaceLifecycle } from '@features/workspace/model/surface-contract';
import { useWorkspaceSurfaceLifecycleBridge } from './workspace-surface-lifecycle-bridge';

type DocumentProps = Omit<ComponentProps<typeof DocumentContainer>, 'fileIdentity' | 'externalEditorMode' | 'navigationViewId'>;

function pluginPreview(content: string | null) {
  if (!content) return null;
  const frontmatter = extractFrontmatter(content);
  const pluginValue = frontmatter.data.flowix_plugin;
  const metadata = pluginValue && typeof pluginValue === 'object' && !Array.isArray(pluginValue)
    ? pluginValue as Record<string, unknown> : null;
  const pluginId = typeof metadata?.id === 'string' ? metadata.id : null;
  const renderer = normalizePluginArtifactRenderer(typeof metadata?.renderer === 'string'
    ? metadata.renderer : pluginId === 'mindmap' ? 'markmap' : null);
  return frontmatter.hasFrontmatter && !frontmatter.parseError && pluginId && renderer
    ? { renderer, content: frontmatter.body.trimStart() } : null;
}

export function MarkdownDocumentSurface({
  fileIdentity,
  documentProps,
  navigationViewId,
  reportPresentation,
  registerLifecycle,
}: {
  fileIdentity: FileDisplayIdentity;
  documentProps: DocumentProps;
  navigationViewId?: string;
  reportPresentation?: (update: SurfacePresentationUpdate) => void;
  registerLifecycle?: (lifecycle: SurfaceLifecycle | null, owner?: object) => void;
}) {
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [pluginRenderer, setPluginRenderer] = useState<PluginArtifactRendererId | null>(null);
  const [preview, setPreview] = useState(false);
  const flushRef = useRef<Parameters<NonNullable<DocumentProps['onFlushReady']>>[0]>(null);
  const currentPath = useRef(fileIdentity.path);
  currentPath.current = fileIdentity.path;
  const onFlushReady = useCallback<NonNullable<DocumentProps['onFlushReady']>>((flush, discard) => {
    flushRef.current = flush;
    documentProps.onFlushReady?.(flush, discard);
  }, [documentProps.onFlushReady]);
  const lifecycleDocumentProps = useWorkspaceSurfaceLifecycleBridge(documentProps, registerLifecycle);

  useEffect(() => {
    let cancelled = false;
    setPreviewContent(null);
    setPluginRenderer(null);
    setPreview(false);
    void notes.readDocument(fileIdentity.path).then((content) => {
      if (cancelled || !content) return;
      const value = pluginPreview(content);
      if (value) {
        setPluginRenderer(value.renderer);
        setPreviewContent(value.content);
        setPreview(true);
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [fileIdentity.path]);

  useEffect(() => {
    const previewKind = preview && pluginRenderer === 'markmap' ? 'mindmap' : preview ? 'plugin-artifact' : 'file-markdown';
    reportPresentation?.({
      appearance: workspaceSurfaceAppearance(previewKind),
      capabilities: workspaceSurfaceCapabilities(previewKind),
    });
  }, [pluginRenderer, preview, reportPresentation]);

  return <div className="relative flex h-full min-h-0 flex-col">
    <div className="min-h-0 flex-1" style={{ display: preview ? 'none' : undefined }}>
      <DocumentContainer {...lifecycleDocumentProps} fileIdentity={fileIdentity} navigationViewId={navigationViewId} onFlushReady={onFlushReady} externalEditorMode="markdown" />
    </div>
    {preview && previewContent !== null && pluginRenderer && <div className="min-h-0 flex-1"><PluginArtifactRenderer renderer={pluginRenderer} content={previewContent} /></div>}
    {previewContent !== null && pluginRenderer && <button type="button" className="mindmap-markdown-toggle"
        onClick={() => {
          if (!preview) {
            const path = fileIdentity.path;
            // Flush this view's editor (including Browser's isolated session).
            // No global Work session is consulted when entering plugin preview.
            if (!flushRef.current) return;
            void flushRef.current()
              .then((saved) => saved ? notes.readDocument(path) : null)
              .then((content) => {
                if (currentPath.current !== path) return;
                const value = pluginPreview(content);
                if (value) {
                  setPluginRenderer(value.renderer);
                  setPreviewContent(value.content);
                  setPreview(true);
                }
              }).catch(() => undefined);
          } else {
            setPreview(false);
          }
        }}>{preview ? '编辑 Markdown' : pluginRenderer === 'markmap' ? '预览思维导图' : '预览产物'}</button>}
  </div>;
}
