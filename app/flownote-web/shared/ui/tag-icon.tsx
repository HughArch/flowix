import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '@/lib/utils';

export interface TagIconProps extends Omit<ComponentPropsWithoutRef<'span'>, 'children' | 'prefix'> {
  /** Add the standard visual gap before a tag name. */
  prefix?: boolean;
}

/**
 * The shared visual representation of a tag's `#`.
 *
 * The text character is intentional: the custom font replaces only `#`, so
 * accessibility, selection/search labels, and serialized tag names remain
 * ordinary text while the rendered mark uses the Flownote tag glyph.
 */
export function TagIcon({ className, prefix = false, ...props }: TagIconProps) {
  return (
    <span
      {...props}
      aria-hidden="true"
      className={cn('flownote-tag-icon', prefix && 'flownote-tag-icon--prefix', className)}
    >
      #
    </span>
  );
}

export type TagSvgIconProps = ComponentPropsWithoutRef<'svg'>;

/** Standalone tag icon for fixed-size UI icon slots. */
export function TagSvgIcon({ className, ...props }: TagSvgIconProps) {
  return (
    <svg
      {...props}
      aria-hidden="true"
      className={cn('flownote-tag-svg-icon', className)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 5v14M16 5v14M5 8h14M5 16h14" />
    </svg>
  );
}
