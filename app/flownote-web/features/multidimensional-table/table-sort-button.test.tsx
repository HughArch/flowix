import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { cycleTableSort, tableSortDirection, TableSortButton } from './table-sort-button';
import { NOTE_UPDATED_AT_FIELD_ID } from './builtin-fields';

describe('column sorting', () => {
  it('cycles ascending, descending, and cleared, replacing other column sorts', () => {
    const asc = cycleTableSort([], 'field');
    expect(asc).toEqual([{ field: 'field', direction: 'asc' }]);
    const desc = cycleTableSort(asc, 'field');
    expect(desc).toEqual([{ field: 'field', direction: 'desc' }]);
    expect(cycleTableSort(desc, 'field')).toEqual([]);
    expect(cycleTableSort(desc, 'another')).toEqual([{ field: 'another', direction: 'asc' }]);
  });

  it('recognizes the default legacy timestamp sort', () => {
    const sort = [{ field: 'modified_at', direction: 'desc' as const }];
    expect(tableSortDirection(sort, NOTE_UPDATED_AT_FIELD_ID)).toBe('desc');
    expect(cycleTableSort(sort, NOTE_UPDATED_AT_FIELD_ID)).toEqual([]);
  });

  it('renders three icon states and disables interaction while saving', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onClick = vi.fn();
    try {
      const icons: string[] = [];
      for (const direction of [null, 'asc', 'desc'] as const) {
        act(() => root.render(<TableSortButton label="名称" direction={direction} disabled={false} onClick={onClick} />));
        const button = container.querySelector('button')!;
        expect(button.getAttribute('aria-pressed')).toBe(String(direction !== null));
        expect(button.classList.contains('opacity-0')).toBe(direction === null);
        icons.push(button.querySelector('svg')!.innerHTML);
        act(() => button.click());
      }
      expect(new Set(icons).size).toBe(3);
      expect(onClick).toHaveBeenCalledTimes(3);
      act(() => root.render(<TableSortButton label="名称" direction="asc" disabled onClick={onClick} />));
      act(() => container.querySelector('button')!.click());
      expect(onClick).toHaveBeenCalledTimes(3);
      act(() => root.render(<TableSortButton label="名称" direction={null} disabled onClick={onClick} />));
      const hiddenButton = container.querySelector('button')!;
      expect(hiddenButton.classList.contains('opacity-0')).toBe(true);
      expect(hiddenButton.classList.contains('disabled:opacity-40')).toBe(false);
    } finally { act(() => root.unmount()); }
  });
});
