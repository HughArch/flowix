import { DropdownMenuItem } from '@shared/ui/dropdown-menu';
import { AgentIcon } from '@features/agent/components/agent-icon';
import { useI18n } from '@/lib/i18n';
import type { AgentType, AgentTypeKey } from '@/types/agent';

interface AgentConversationTypeMenuItemsProps {
  options: readonly AgentType[];
  disabled?: boolean;
  onSelect: (agentType: AgentTypeKey) => void;
}

export function AgentConversationTypeMenuItems({
  options,
  disabled = false,
  onSelect,
}: AgentConversationTypeMenuItemsProps) {
  const { t } = useI18n();

  return options.map((type) => {
    const name = type.nameKey
      ? t(type.nameKey as Parameters<typeof t>[0])
      : type.name;

    return (
      <DropdownMenuItem
        key={type.id}
        disabled={disabled}
        onClick={() => onSelect(type.id)}
        className="agent-conversation-new-agent-item group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
      >
        <AgentIcon typeKey={type.id} alt="" className="h-4 w-4 shrink-0 object-contain" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {type.runtimeKind === 'external-cli' && (
          <span
            className="ml-auto shrink-0 text-xs text-[var(--muted-foreground)] opacity-50 group-hover:text-[var(--primary-foreground)] group-focus-visible:text-[var(--primary-foreground)] group-data-[highlighted]:text-[var(--primary-foreground)]"
          >
            {t('agent.chat.localRuntime')}
          </span>
        )}
      </DropdownMenuItem>
    );
  });
}
