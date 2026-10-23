import { useState, type DragEvent } from 'react';

export function useBrowserTabDrag(onReorder: (tabId: string, beforeTabId: string | null) => void) {
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!draggedTabId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };
  const drop = (event: DragEvent<HTMLDivElement>, beforeTabId: string | null) => {
    if (!draggedTabId) return;
    event.preventDefault();
    if (draggedTabId !== beforeTabId) onReorder(draggedTabId, beforeTabId);
    setDraggedTabId(null);
  };
  return {
    draggedTabId,
    tabDragHandlers: (tabId: string, nextTabId: string | null) => ({
      onDragStart: (event: DragEvent<HTMLDivElement>) => {
        if ((event.target as HTMLElement).closest('[data-tab-close]')) {
          event.preventDefault();
          return;
        }
        setDraggedTabId(tabId);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', tabId);
      },
      onDragEnd: () => setDraggedTabId(null),
      onDragOver,
      onDrop: (event: DragEvent<HTMLDivElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        drop(event, event.clientX < rect.left + rect.width / 2 ? tabId : nextTabId);
      },
    }),
    endDropHandlers: { onDragOver, onDrop: (event: DragEvent<HTMLDivElement>) => drop(event, null) },
  };
}
