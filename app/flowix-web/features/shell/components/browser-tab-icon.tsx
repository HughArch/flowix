import { Globe, MessageCirclePlus } from 'lucide-react';
import { ContentIcon, classifyFileContent } from '@features/content/public/content-api';
import { AgentIcon } from '@features/agent/public/shell-api';
import { NotebookNoteTabIcon } from '@features/memo/public/shell-api';
import type { BrowserColumnTab } from '@features/workspace/public/browser-column-api';
import type { AgentTypeKey } from '@/types/agent';

const MAX_INLINE_TAB_ICON_LENGTH = 64 * 1024;

function tabIconImageSource(icon: string | null): string | null {
  if (!icon) return null;
  if (/^https?:\/\//i.test(icon)) return icon;
  if (icon.length <= MAX_INLINE_TAB_ICON_LENGTH
    && /^data:image\/(?:svg\+xml|png|jpe?g|gif|webp|avif)(?:;[^,]*)?,/i.test(icon)) return icon;
  return null;
}

export function BrowserTabIcon({ tab, agentTypeKey, noteIcon }: {
  tab: BrowserColumnTab;
  agentTypeKey?: AgentTypeKey;
  noteIcon?: string | null;
}) {
  if (tab.target.kind === 'agent_conversation') {
    return agentTypeKey ? <AgentIcon typeKey={agentTypeKey} alt="" className="h-3.5 w-3.5" /> : <MessageCirclePlus className="h-3.5 w-3.5" />;
  }
  if (tab.target.kind === 'web') {
    const imageSource = tabIconImageSource(tab.icon);
    return imageSource ? (
      <span className="relative flex h-4 w-4 items-center justify-center">
        <Globe className="h-3.5 w-3.5" />
        <img
          src={imageSource}
          alt=""
          className="absolute h-3.5 w-3.5 rounded-sm"
          onError={(event) => { event.currentTarget.style.display = 'none'; }}
        />
      </span>
    ) : <Globe className="h-3.5 w-3.5" />;
  }
  if (tab.target.kind === 'media') {
    return <ContentIcon content={{ kind: 'file', path: tab.target.filePath }} className="h-3.5 w-3.5 opacity-100" />;
  }
  if (tab.target.kind === 'folder-collection') {
    return <ContentIcon content={{ kind: 'folder' }} className="h-3.5 w-3.5 opacity-100" />;
  }
  if (tab.target.kind === 'file-browser') {
    if (tab.target.collectionType === 'table') {
      return <ContentIcon content={{ kind: 'multidimensional-table' }} className="h-3.5 w-3.5 opacity-100" />;
    }
    if (tab.target.collectionType === 'media_library') {
      return <ContentIcon content={{ kind: 'media-library' }} className="h-3.5 w-3.5 opacity-100" />;
    }
    const path = tab.target.activeFilePath;
    if (!path) return <ContentIcon content={{ kind: 'folder' }} className="h-3.5 w-3.5 opacity-100" />;
    if (classifyFileContent(path) === 'note') {
      return <NotebookNoteTabIcon icon={noteIcon ?? null} className="h-3.5 w-3.5 opacity-100" />;
    }
    return <ContentIcon content={{ kind: 'file', path }} className="h-3.5 w-3.5 opacity-100" />;
  }
  return <ContentIcon content={{ kind: 'web' }} className="h-3.5 w-3.5 opacity-100" />;
}

