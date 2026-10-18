/**
 * Single-select value input for `Select` property rows. Supports plain
 * string options and value/label pairs used by table fields.
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@shared/ui/select';
import { useI18n } from '@/lib/i18n';
import { stableTextHue } from '@/lib/color';
import { cn } from '@/lib/utils';

interface SelectValueInputProps {
  value: string;
  options: readonly (string | { value: string; label: string })[];
  disabled?: boolean;
  variant?: 'default' | 'table';
  onChange: (next: string) => void;
}

export function SelectValueInput({
  value,
  options,
  disabled = false,
  variant = 'default',
  onChange,
}: SelectValueInputProps) {
  const { t } = useI18n();
  const normalizedOptions = options.map((option) => typeof option === 'string'
    ? { value: option, label: option }
    : option);
  const selectedOption = normalizedOptions.find((option) => option.value === value);
  const selectedLabel = selectedOption?.label ?? value;
  return (
    <Select
      value={value}
      onValueChange={onChange}
      disabled={disabled}
      anchorToCell={variant === 'table'}
    >
      <SelectTrigger
        className={cn(
          'h-8 gap-2 rounded-lg',
          variant === 'table' && 'multidimensional-table__select-trigger border-0 bg-transparent px-0 text-left shadow-none hover:bg-transparent focus:border-0',
          disabled && 'cursor-not-allowed opacity-50 disabled:cursor-not-allowed'
        )}
      >
        <SelectValue placeholder={variant === 'table' ? '' : t('document.properties.select.placeholder')}>
          {variant === 'table'
            ? selectedLabel
              ? <span
                className="multidimensional-table__option-chip min-w-0 max-w-full truncate"
                title={selectedLabel}
                style={{ '--multidimensional-table-option-hue': stableTextHue(selectedLabel) } as React.CSSProperties}
              >{selectedLabel}</span>
              : null
            : selectedOption?.label}
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        align="start"
        className={cn('min-w-[160px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]', variant === 'table' && '!z-[170]')}
      >
        {normalizedOptions.length === 0 ? (
          <div className="px-3 py-2 text-xs text-[var(--muted-foreground)]">
            {t('document.properties.select.empty')}
          </div>
        ) : (
          normalizedOptions.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              className="h-8 !min-h-8 rounded-lg px-2 py-0 text-left hover:bg-[var(--hover-bg)]"
            >
              <span
                className="multidimensional-table__option-chip max-w-full truncate"
                style={{ '--multidimensional-table-option-hue': stableTextHue(option.label) } as React.CSSProperties}
              >
                {option.label}
              </span>
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}
