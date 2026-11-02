import { cn } from '@/lib/utils';

const CONVERSATIONS = [0, 0, 0] as const;
const ACCESS_SPACE = [0, 1, 1, 0, 1, 1] as const;

/** Mirrors conversation and access-space groups without loading file data. */
export function FileTreeLoadingSkeleton({
  ariaLabel,
  className,
  compact = false,
  variant = 'notebook',
}: {
  ariaLabel: string;
  className?: string;
  compact?: boolean;
  variant?: 'notebook' | 'folder';
}) {
  const groups = compact
    ? [ACCESS_SPACE.slice(0, 3)]
    : [CONVERSATIONS, ACCESS_SPACE];

  return (
    <div role="status" aria-label={ariaLabel} aria-busy="true"
      data-file-tree-loading-skeleton
      className={cn('overflow-hidden bg-[var(--list-bg)] px-[6px] py-1', className)}>
      <div aria-hidden="true" className="space-y-3 motion-safe:animate-pulse">
        {groups.map((rows, groupIndex) => (
          <div key={groupIndex} data-skeleton-tree-group>
            {!compact && (
              <div className="mb-0.5 flex h-7 items-center px-1.5">
                <span className="h-3 w-14 rounded bg-[var(--muted)]" />
              </div>
            )}
            <div className={cn(variant === 'notebook' && 'space-y-0.5')}>
              {rows.map((depth, index) => (
                <div key={index}
                  className={cn('flex items-center px-1.5', variant === 'notebook' ? 'h-8' : 'h-7')}
                  style={{ marginLeft: depth * 20 }}>
                  <span className={cn('h-4 rounded bg-[var(--muted)]',
                    (!compact && groupIndex === 0) || depth > 0 ? 'w-4/5' : 'w-28 max-w-[75%]',
                  )} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
