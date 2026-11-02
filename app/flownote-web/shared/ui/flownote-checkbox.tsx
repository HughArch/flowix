import type { FocusEventHandler } from 'react';
import { cn } from '@/lib/utils';

interface FlownoteCheckboxBaseProps {
  checked: boolean;
  className?: string;
  disabled?: boolean;
}

export type FlownoteCheckboxProps = FlownoteCheckboxBaseProps & (
  | {
      interactive?: true;
      onCheckedChange: (checked: boolean) => void;
      'aria-label': string;
      onBlur?: FocusEventHandler<HTMLButtonElement>;
    }
  | {
      interactive: false;
      onCheckedChange?: never;
      'aria-label'?: never;
      onBlur?: never;
    }
);

export function FlownoteCheckbox({
  checked,
  onCheckedChange,
  'aria-label': ariaLabel,
  interactive = true,
  className,
  disabled = false,
  onBlur,
}: FlownoteCheckboxProps) {
  const checkboxClassName = cn(
    'flownote-hand-checkbox',
    interactive && 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
    checked && 'flownote-hand-checkbox--checked',
    disabled && 'disabled:cursor-not-allowed disabled:opacity-50',
    className,
  );
  const mark = checked && <span className="flownote-hand-checkbox__mark" aria-hidden="true" />;

  if (!interactive) {
    return <span aria-hidden="true" className={checkboxClassName}>{mark}</span>;
  }

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      onBlur={onBlur}
      className={checkboxClassName}
    >
      {mark}
    </button>
  );
}
