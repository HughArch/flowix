'use client';

import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface SettingsTabItem {
  id: string;
  label: string;
  icon?: ReactNode;
}

interface SettingsTabGroupProps {
  tabs: readonly SettingsTabItem[];
  activeTab: string;
  onActiveTabChange: (tab: string) => void;
  ariaLabel: string;
  orientation?: 'horizontal' | 'vertical';
  listClassName?: string;
  tabClassName?: string;
  activeTabClassName?: string;
  inactiveTabClassName?: string;
  children: ReactNode;
}

/** Accessible single-select tabs with automatic activation and arrow-key navigation. */
export function SettingsTabGroup({
  tabs,
  activeTab,
  onActiveTabChange,
  ariaLabel,
  orientation = 'horizontal',
  listClassName,
  tabClassName,
  activeTabClassName,
  inactiveTabClassName,
  children,
}: SettingsTabGroupProps) {
  const generatedId = useId().replace(/:/g, '');
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const selectedIndex = Math.max(0, tabs.findIndex((tab) => tab.id === activeTab));
  const selected = tabs[selectedIndex];
  if (!selected) return null;

  const tabElementId = (id: string) => `${generatedId}-tab-${id}`;
  const panelId = `${generatedId}-panel`;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (orientation === 'horizontal' && event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    if (orientation === 'horizontal' && event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (orientation === 'vertical' && event.key === 'ArrowDown') nextIndex = (index + 1) % tabs.length;
    if (orientation === 'vertical' && event.key === 'ArrowUp') nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = tabs[nextIndex];
    onActiveTabChange(next.id);
    tabRefs.current[next.id]?.focus();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="tablist"
        aria-label={ariaLabel}
        aria-orientation={orientation}
        className={listClassName}
      >
        {tabs.map((tab, index) => {
          const isSelected = tab.id === selected.id;
          return (
            <button
              key={tab.id}
              ref={(element) => { tabRefs.current[tab.id] = element; }}
              id={tabElementId(tab.id)}
              type="button"
              role="tab"
              aria-selected={isSelected}
              aria-controls={panelId}
              tabIndex={isSelected ? 0 : -1}
              className={cn(tabClassName, isSelected ? activeTabClassName : inactiveTabClassName)}
              onClick={() => onActiveTabChange(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {tab.icon}
              {tab.label}
            </button>
          );
        })}
      </div>
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={tabElementId(selected.id)}
        tabIndex={0}
        className="flex min-h-0 flex-1 flex-col"
      >
        {children}
      </div>
    </div>
  );
}
