import { forwardRef, type HTMLAttributes, type KeyboardEventHandler, type ReactNode, type Ref } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip } from '@shared/ui/tooltip';
import { BROWSER_TAB_SIZE } from '../hooks/use-browser-tab-layout';

interface BrowserTabItemProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  selected: boolean;
  iconOnly: boolean;
  focused: boolean;
  dragging: boolean;
  title: string;
  icon: ReactNode;
  closeLabel: string;
  buttonRef: Ref<HTMLButtonElement>;
  onSelect: () => void;
  onTabKeyDown: KeyboardEventHandler<HTMLButtonElement>;
  onClose: () => void;
}

const fullSize = { height: BROWSER_TAB_SIZE.height, minWidth: BROWSER_TAB_SIZE.fullMin, maxWidth: BROWSER_TAB_SIZE.fullMax, flexBasis: BROWSER_TAB_SIZE.fullMax };
const iconSize = { height: BROWSER_TAB_SIZE.height, minWidth: BROWSER_TAB_SIZE.height, maxWidth: BROWSER_TAB_SIZE.height, flexBasis: BROWSER_TAB_SIZE.height };

export const BrowserTabItem = forwardRef<HTMLDivElement, BrowserTabItemProps>(function BrowserTabItem({
  selected, iconOnly, focused, dragging, title, icon, closeLabel, buttonRef,
  onSelect, onTabKeyDown, onClose, className, style, ...props
}, ref) {
  return (
    <div {...props} ref={ref} style={{ ...(iconOnly ? iconSize : fullSize), ...style }} className={cn(
      'group relative flex shrink select-none items-center rounded-lg border text-xs text-[var(--foreground)] shadow-[0_1px_4px_-3px_rgb(0_0_0_/_0.08)] transition-[background-color,color,opacity] hover:bg-[var(--muted)] [-webkit-app-region:no-drag]',
      selected ? 'browser-column-tab-active border-[color-mix(in_oklch,var(--foreground)_8%,transparent)]' : 'border-[var(--border)] bg-transparent',
      dragging && 'opacity-45', className,
    )}>
      {selected && focused && <span aria-hidden="true" className="browser-column-active-tab-indicator pointer-events-none absolute left-[5%] right-[5%] top-0 h-px" />}
      <Tooltip content={title} side="bottom" className="max-w-[280px] whitespace-normal text-left [overflow-wrap:anywhere]">
        <button type="button" role="tab" ref={buttonRef} aria-selected={selected} tabIndex={selected ? 0 : -1}
          aria-label={title} draggable={false} onClick={onSelect} onKeyDown={onTabKeyDown}
          className={cn('flex min-w-0 flex-1 cursor-default select-none items-center self-stretch truncate py-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] [-webkit-app-region:no-drag]', iconOnly ? 'justify-center px-0' : 'pl-1 pr-0.5')}>
          <span className="flex min-w-0 items-center">
            <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
            {!iconOnly && <span className="ml-0.5 min-w-0 truncate">{title}</span>}
          </span>
        </button>
      </Tooltip>
      {!iconOnly && <button type="button" draggable={false} data-tab-close tabIndex={selected ? 0 : -1} onClick={onClose}
        aria-label={closeLabel} title={closeLabel} className={cn(
          'flex h-5 shrink-0 cursor-default items-center justify-center hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] [-webkit-app-region:no-drag]',
          selected ? 'mr-1 w-5 opacity-60' : 'pointer-events-none mr-0 w-0 overflow-hidden opacity-0 transition-[width,margin,opacity] duration-150 group-hover:pointer-events-auto group-hover:mr-1 group-hover:w-5 group-hover:opacity-60',
        )}><X className="h-3.5 w-3.5" /></button>}
    </div>
  );
});
