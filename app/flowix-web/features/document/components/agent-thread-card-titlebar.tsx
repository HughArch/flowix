import { useEffect, useState } from 'react';
import { Tooltip } from '@shared/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { normalizeAgentTypeKey } from '@/lib/agent-types';
import type { AgentTypeKey } from '@/types/agent';
import type { WorkspaceHostId } from '@features/workspace/public/host-api';
import { ICON_FULLSCREEN_EXIT_PATH } from '@features/agent/thread-card/agent-thread-card-icons';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import { AgentConversationMoreMenu } from '@features/agent/components/agent-conversation-more-menu';
import { AgentConversationIdentity } from '@features/agent/components/agent-conversation-identity';

const AGENT_THREAD_CARD_FULLSCREEN_CHANGE_EVENT =
  'flowix:agent-thread-card-fullscreen-change';
const AGENT_THREAD_CARD_FULLSCREEN_RENAME_EVENT =
  'flowix:agent-thread-card-fullscreen-rename';
const AGENT_THREAD_CARD_REQUEST_FULLSCREEN_EVENT =
  'flowix:agent-thread-card-request-fullscreen';

interface AgentThreadCardFullscreenInfo {
  title: string;
  typeKey: AgentTypeKey;
  /** Agent conversation instance id — used to look up runtime info (sessionId, cwd) for the badge hover card. */
  instanceId: string | null;
  /** Provider/external thread id, when the conversation has been bound to one. */
  threadId: string | null;
}

/**
 * Which workspace column's chrome should react to a fullscreen Thread Card.
 * A fullscreen card is `position: fixed` but keeps its DOM position, so the
 * hosting column resolves reliably through the closest [data-workspace-host]
 * ancestor — each column only reacts to its own cards.
 */
export type AgentThreadCardFullscreenHost = WorkspaceHostId;

function getFullscreenAgentThreadCard(
  host: AgentThreadCardFullscreenHost,
): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  // Only the active browser-column tab stays mounted, so at most one card per
  // host can be fullscreen; the first host match wins.
  const cards = document.querySelectorAll<HTMLElement>('.agent-thread-card--fullscreen');
  for (const card of cards) {
    if (card.closest(`[data-workspace-host="${host}"]`)) return card;
  }
  return null;
}

function hasFullscreenAgentThreadCard(host: AgentThreadCardFullscreenHost): boolean {
  return getFullscreenAgentThreadCard(host) !== null;
}

function getFullscreenAgentThreadCardInfo(
  host: AgentThreadCardFullscreenHost,
): AgentThreadCardFullscreenInfo | null {
  const card = getFullscreenAgentThreadCard(host);
  if (!card) return null;

  const instanceId = card.dataset.instanceId?.trim() || null;
  const threadId = card.dataset.threadId?.trim() || null;
  return {
    title: card.dataset.title?.trim() ?? '',
    typeKey: normalizeAgentTypeKey(card.dataset.agentType),
    instanceId,
    threadId,
  };
}

export function useAgentThreadCardFullscreenActive(
  host: AgentThreadCardFullscreenHost = 'main-third',
): boolean {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const update = () => setActive(hasFullscreenAgentThreadCard(host));
    update();

    window.addEventListener(AGENT_THREAD_CARD_FULLSCREEN_CHANGE_EVENT, update);

    return () => {
      window.removeEventListener(AGENT_THREAD_CARD_FULLSCREEN_CHANGE_EVENT, update);
    };
  }, [host]);

  return active;
}

export function useFullscreenAgentThreadCardInfo(
  host: AgentThreadCardFullscreenHost = 'main-third',
): AgentThreadCardFullscreenInfo | null {
  const [info, setInfo] = useState<AgentThreadCardFullscreenInfo | null>(null);

  useEffect(() => {
    const update = () => setInfo(getFullscreenAgentThreadCardInfo(host));
    update();

    window.addEventListener(AGENT_THREAD_CARD_FULLSCREEN_CHANGE_EVENT, update);

    return () => {
      window.removeEventListener(AGENT_THREAD_CARD_FULLSCREEN_CHANGE_EVENT, update);
    };
  }, [host]);

  return info;
}

/** The exit affordance for an embedded fullscreen Thread Card. */
export function AgentThreadCardFullscreenExitButton({
  className,
  host = 'main-third',
}: {
  className: string;
  host?: AgentThreadCardFullscreenHost;
}) {
  const { t } = useI18n();
  const active = useAgentThreadCardFullscreenActive(host);

  if (!active) return null;

  return (
    <Tooltip content={t('editor.threadCard.exitFullscreen')}>
      <button
        type="button"
        onClick={() => {
          window.dispatchEvent(new CustomEvent(AGENT_THREAD_CARD_REQUEST_FULLSCREEN_EVENT, {
            detail: { host, exitOthers: true },
          }));
        }}
        aria-label={t('editor.threadCard.exitFullscreen')}
        title={t('editor.threadCard.exitFullscreen')}
        className={`${className} [-webkit-app-region:no-drag]`}
      >
        <svg
          viewBox="0 0 256 256"
          aria-hidden="true"
          focusable="false"
          className="agent-thread-card__fullscreen-icon"
        >
          <path d={ICON_FULLSCREEN_EXIT_PATH} fill="currentColor" />
        </svg>
      </button>
    </Tooltip>
  );
}

/** Agent conversation menu rendered in the existing work-column titlebar slot. */
export function AgentThreadCardFullscreenMoreMenu({
  iconButtonClass,
  host = 'main-third',
}: {
  iconButtonClass: string;
  host?: AgentThreadCardFullscreenHost;
}) {
  const info = useFullscreenAgentThreadCardInfo(host);
  const storedInstance = useAgentSessionStore((state) =>
    info?.instanceId ? state.getInstance(info.instanceId) : null,
  );
  const instance: AgentConversationInstance | null = storedInstance ?? (
    info?.instanceId ? {
      instanceId: info.instanceId,
      agentType: info.typeKey,
      title: info.title,
      threadId: info.threadId,
      source: { kind: 'thread-card' },
      createdAt: 0,
      updatedAt: 0,
    } : null
  );

  if (!info || !instance) return null;

  return (
    <AgentConversationMoreMenu
      instance={instance}
      iconButtonClass={iconButtonClass}
      onRename={() => window.dispatchEvent(new CustomEvent(AGENT_THREAD_CARD_FULLSCREEN_RENAME_EVENT, {
        detail: { host, instanceId: instance.instanceId },
      }))}
    />
  );
}

/** Shared Agent identity displayed in a column titlebar while a conversation is fullscreen. */
export function AgentThreadCardFullscreenIdentity({
  host = 'main-third',
}: {
  host?: AgentThreadCardFullscreenHost;
} = {}) {
  const { t } = useI18n();
  const info = useFullscreenAgentThreadCardInfo(host);
  const [renameRequest, setRenameRequest] = useState(0);
  const instance = useAgentSessionStore((state) =>
    info?.instanceId ? state.getInstance(info.instanceId) : null,
  );

  useEffect(() => {
    const handleRename = (event: Event) => {
      const detail = (event as CustomEvent<{
        host?: AgentThreadCardFullscreenHost;
        instanceId?: string;
      }>).detail;
      if (detail?.host !== host || detail.instanceId !== info?.instanceId) return;
      setRenameRequest((request) => request + 1);
    };
    window.addEventListener(AGENT_THREAD_CARD_FULLSCREEN_RENAME_EVENT, handleRename);
    return () => window.removeEventListener(AGENT_THREAD_CARD_FULLSCREEN_RENAME_EVENT, handleRename);
  }, [host, info?.instanceId]);

  if (!info) return null;

  return (
    <AgentConversationIdentity
      instanceId={info.instanceId}
      title={instance?.title?.trim() || info.title || t('common.untitled')}
      typeKey={instance?.agentType ?? info.typeKey}
      threadId={instance?.threadId ?? info.threadId}
      sessionId={instance?.providerSessionId}
      renameRequest={renameRequest}
      className="ml-2 min-w-0"
    />
  );
}

