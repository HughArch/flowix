import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { useI18n } from '@/lib/i18n';
import {
  PROPERTY_ICON_OPTIONS,
  getPropertyIconGlyph,
  getPropertyIconOption,
} from '@features/document/properties/property-icons';
import { createEmojiPickerPanel } from '@features/editor/extensions/callout/emoji-picker';
import { cn } from '@/lib/utils';

interface IconValueInputProps {
  value: string;
  disabled?: boolean;
  variant?: 'default' | 'table';
  keepParentMenuOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onChange: (next: string) => void;
}

type IconPickerTab = 'icons' | 'emoji';

export function IconValueInput({
  value,
  disabled = false,
  variant = 'default',
  keepParentMenuOpen = false,
  onOpenChange,
  onChange,
}: IconValueInputProps) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<IconPickerTab>('icons');
  const emojiHostRef = useRef<HTMLDivElement | null>(null);
  // Keep the latest callbacks out of the picker effect so typing in the
  // emoji search box does not tear the panel down on every parent render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const selected = getPropertyIconOption(value);
  const glyph = selected ? null : getPropertyIconGlyph(value);

  const changeOpen = useCallback((nextOpen: boolean) => {
    if (disabled) return;
    setOpen(nextOpen);
    if (!nextOpen) setTab('icons');
    onOpenChange?.(nextOpen);
  }, [disabled, onOpenChange]);
  const changeOpenRef = useRef(changeOpen);
  changeOpenRef.current = changeOpen;

  useEffect(() => { if (disabled) { setOpen(false); onOpenChange?.(false); } }, [disabled, onOpenChange]);

  // Host the command-style emoji panel inside the popover. It is destroyed
  // whenever the popover closes or the icon tab takes over.
  useEffect(() => {
    if (!open || tab !== 'emoji') return;
    const host = emojiHostRef.current;
    if (!host) return;
    const panel = createEmojiPickerPanel({
      language,
      inline: true,
      requestClose: () => changeOpenRef.current(false),
      onPick: (unicode) => onChangeRef.current(unicode),
    });
    host.appendChild(panel.element);
    panel.refreshLayout();
    panel.focusSearch();
    return () => panel.destroy();
  }, [open, tab, language]);

  const clearValue = (event: MouseEvent) => {
    event.stopPropagation();
    if (disabled) return;
    onChange('');
  };

  return (
    <Popover open={disabled ? false : open} onOpenChange={changeOpen} cellPopup={variant === 'table'}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={selected?.label ?? glyph ?? undefined}
          className={cn(
            'group flex h-8 w-full items-center gap-2 rounded-lg text-left text-sm transition-colors',
            variant === 'table'
              ? 'border-0 bg-transparent px-0 hover:bg-transparent focus-visible:border-0 data-[state=open]:border-0'
              : 'border border-input bg-background px-2.5 hover:bg-[var(--muted)]/40 focus-visible:border-[var(--primary)] data-[state=open]:border-[var(--primary)]',
            'focus-visible:outline-none',
            disabled && 'cursor-not-allowed opacity-50'
          )}
        >
          {selected ? (
            <img
              src={selected.src}
              alt=""
              className={cn('h-5 w-5 shrink-0 object-contain', variant === 'table' && 'multidimensional-table__icon-value')}
              draggable={false}
            />
          ) : glyph ? (
            <span
              className={cn(
                'flex h-5 w-5 shrink-0 items-center justify-center text-base leading-none',
                variant === 'table' && 'multidimensional-table__icon-value',
              )}
            >
              {glyph}
            </span>
          ) : (
            <span className={cn(
              'h-5 w-5 shrink-0 rounded-md border border-dashed',
              variant === 'table' ? 'multidimensional-table__icon-placeholder' : 'border-[var(--border)]',
            )} />
          )}
          {(selected || glyph) && !disabled && (
            <span
              role="button"
              tabIndex={-1}
              onClick={clearValue}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--muted-foreground)] opacity-0 transition-opacity hover:bg-[var(--muted)] hover:text-[var(--foreground)] group-hover:opacity-100 group-focus-visible:opacity-100"
              aria-label={t('document.properties.icon.clear')}
            >
              <X className="h-3.5 w-3.5" />
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        keepParentMenuOpen={keepParentMenuOpen}
        className={cn('z-[150] w-[280px] rounded-xl border border-[var(--border-popup)] bg-[var(--card)] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]', variant === 'table' ? '!z-[170] p-1' : 'p-2')}
      >
        <div
          className="mb-2 flex items-center gap-0.5 rounded-lg bg-[var(--muted)]/50 p-0.5"
          role="tablist"
        >
          {(['icons', 'emoji'] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={tab === item}
              disabled={disabled}
              onClick={() => setTab(item)}
              className={cn(
                'flex-1 rounded-md px-2 py-1 text-xs transition-colors',
                tab === item
                  ? 'bg-[var(--card)] text-[var(--foreground)] shadow-sm'
                  : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]',
              )}
            >
              {item === 'icons'
                ? t('document.properties.icon.tabIcons')
                : t('document.properties.icon.tabEmoji')}
            </button>
          ))}
        </div>
        {tab === 'icons' ? (
          <div className="max-h-[240px] overflow-y-auto [scrollbar-gutter:stable]">
            <div className="grid grid-cols-5 gap-1">
            {PROPERTY_ICON_OPTIONS.map((option) => {
              const active = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    if (disabled) return;
                    onChange(option.value);
                    changeOpen(false);
                  }}
                  className={cn(
                    'flex h-10 w-10 items-center justify-center rounded-lg border transition-colors',
                    active
                      ? 'border-[var(--primary)] bg-[color-mix(in_oklch,var(--primary)_10%,transparent)]'
                      : 'border-transparent hover:border-[var(--border)] hover:bg-[var(--muted)]/60'
                  )}
                  title={option.label}
                  aria-label={option.label}
                >
                  <img
                    src={option.src}
                    alt=""
                    className="h-6 w-6 object-contain"
                    draggable={false}
                  />
                </button>
              );
            })}
            </div>
          </div>
        ) : (
          <div ref={emojiHostRef} className="w-full" />
        )}
      </PopoverContent>
    </Popover>
  );
}
