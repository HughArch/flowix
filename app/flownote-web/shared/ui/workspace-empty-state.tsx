import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import backgroundImage from '@/assets/bg.document.svg';

export interface WorkspaceEmptyStateProps {
  message: ReactNode;
  tone?: 'document' | 'agent';
  className?: string;
}

/** Shared full-surface empty state used by workspace hosts and their views. */
export function WorkspaceEmptyState({ message, tone = 'document', className }: WorkspaceEmptyStateProps) {
  return (
    <div
      className={cn(
        'relative flex h-full w-full items-center justify-center',
        tone === 'agent'
          ? 'bg-[var(--editor-block-bg,var(--document-bg))]'
          : 'bg-[var(--document-bg)]',
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-no-repeat bg-bottom bg-[length:auto_800px] opacity-[0.42]"
        style={{ backgroundImage: `url(${backgroundImage})` }}
      />
      <span className="relative text-center text-sm text-[var(--muted-foreground)]">
        {message}
      </span>
    </div>
  );
}
