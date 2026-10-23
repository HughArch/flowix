import { useCallback, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { ChevronLeft, GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { FlowixCheckbox } from '@shared/ui/flowix-checkbox';
import { Popover, PopoverContent } from '@shared/ui/popover';
import { DialogHeader, DialogTitle } from '@shared/ui/dialog';
import type { NotebookTreeSection } from './use-notebook-tree-sections';

export interface NotebookTreeCustomizePanelHandle { open: (rect: DOMRect) => void }

export function NotebookTreeCustomizePanel({ ref, sectionOrder, hiddenSections, onChange }: {
  ref: Ref<NotebookTreeCustomizePanelHandle>;
  sectionOrder: NotebookTreeSection[];
  hiddenSections: NotebookTreeSection[];
  onChange: (order: NotebookTreeSection[], hidden: NotebookTreeSection[]) => void;
}) {
  const { t } = useI18n();
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [customizeAnchorRect, setCustomizeAnchorRect] = useState<DOMRect | null>(null);
  useImperativeHandle(ref, () => ({ open(anchorRect: DOMRect) {
    setCustomizeAnchorRect(anchorRect);
    setCustomizeOpen(true);
  } }), []);
  const updateCustomizeSectionVisibility = useCallback((section: NotebookTreeSection, visible: boolean) => {
    onChange(sectionOrder, visible ? hiddenSections.filter((item) => item !== section) : [...hiddenSections, section]);
  }, [hiddenSections, sectionOrder, onChange]);
  const updateCustomizeSectionOrder = useCallback((order: NotebookTreeSection[]) => {
    onChange(order, hiddenSections);
  }, [hiddenSections, onChange]);
  const draggedSection = useRef<NotebookTreeSection | null>(null);
  const sectionDragPointerId = useRef<number | null>(null);
  const sectionDropTargetRef = useRef<{ section: NotebookTreeSection; after: boolean } | null>(null);
  const [sectionDropTarget, setSectionDropTarget] = useState<{ section: NotebookTreeSection; after: boolean } | null>(null);
  return (
      <Popover open={customizeOpen} onOpenChange={setCustomizeOpen} anchorRect={customizeAnchorRect}>
        <PopoverContent side="bottom" align="start" sideOffset={0} alignToAnchorOrigin keepParentMenuOpen className="w-[190px] max-w-[calc(100vw-16px)] rounded-2xl p-[5px] shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
          <DialogHeader className="mb-0 flex min-h-8 flex-row items-center justify-between px-1">
            <button type="button" aria-label="返回上一级菜单" title="返回上一级菜单" onClick={() => setCustomizeOpen(false)} className="inline-flex min-w-0 shrink-0 items-center gap-0.5 rounded px-0 text-xs leading-[1.2] text-[var(--muted-foreground)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="min-w-0 truncate text-xs leading-[1.2]">{t('memo.fileTree.customizeDisplay')}</span>
            </button>
            <DialogTitle className="sr-only">{t('memo.fileTree.customizeDisplay')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-0.5" aria-label="文件树分区展示与顺序">
            {sectionOrder.map((section) => {
              const labels: Record<NotebookTreeSection, string> = {
                agents: t('memo.fileTree.agentsSectionTitle'),
                pinned: t('memo.fileTree.pinnedSectionTitle'),
                views: t('memo.fileTree.viewsSectionTitle'),
                files: t('memo.fileTree.sectionTitle'),
                repositories: t('memo.fileTree.repositoriesTitle'),
              };
              const selected = !hiddenSections.includes(section);
              return <div key={section} data-customize-section={section} className={cn('group relative flex h-8 items-center gap-2 rounded-lg px-2 transition-colors hover:bg-[var(--muted)]', draggedSection.current === section && 'opacity-50')}>
                {sectionDropTarget?.section === section && draggedSection.current !== section && <span aria-hidden="true" className={cn('pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-[var(--primary)]', sectionDropTarget.after ? '-bottom-0.5' : '-top-0.5')} />}
                <button type="button" onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  draggedSection.current = section;
                  sectionDragPointerId.current = event.pointerId;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  event.preventDefault();
                }} onPointerMove={(event) => {
                  if (sectionDragPointerId.current !== event.pointerId) return;
                  const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-customize-section]');
                  const target = row?.dataset.customizeSection as NotebookTreeSection | undefined;
                  if (!row || !target || target === draggedSection.current) {
                    sectionDropTargetRef.current = null;
                    setSectionDropTarget(null);
                    return;
                  }
                  const bounds = row.getBoundingClientRect();
                  const next = { section: target, after: event.clientY >= bounds.top + bounds.height / 2 };
                  sectionDropTargetRef.current = next;
                  setSectionDropTarget(next);
                }} onPointerUp={(event) => {
                  if (sectionDragPointerId.current !== event.pointerId) return;
                  const source = draggedSection.current;
                  const target = sectionDropTargetRef.current;
                  if (source && target) {
                    const next = sectionOrder.filter((item) => item !== source);
                    next.splice(next.indexOf(target.section) + (target.after ? 1 : 0), 0, source);
                    updateCustomizeSectionOrder(next);
                  }
                  draggedSection.current = null;
                  sectionDragPointerId.current = null;
                  sectionDropTargetRef.current = null;
                  setSectionDropTarget(null);
                }} onPointerCancel={() => {
                  draggedSection.current = null;
                  sectionDragPointerId.current = null;
                  sectionDropTargetRef.current = null;
                  setSectionDropTarget(null);
                }} onKeyDown={(event) => {
                  const direction = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
                  if (!direction) return;
                  event.preventDefault();
                  const index = sectionOrder.indexOf(section);
                  const target = index + direction;
                  if (target < 0 || target >= sectionOrder.length) return;
                  const next = [...sectionOrder];
                  [next[index], next[target]] = [next[target], next[index]];
                  updateCustomizeSectionOrder(next);
                }} aria-label={`排序${labels[section]}，使用上下方向键调整`} className="flex h-7 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] active:cursor-grabbing">
                  <GripVertical className="h-4 w-4" aria-hidden="true" />
                </button>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--foreground)]">{labels[section]}</span>
                <FlowixCheckbox
                  checked={selected}
                  aria-label={`展示${labels[section]}`}
                  onCheckedChange={(checked) => updateCustomizeSectionVisibility(section, checked)}
                />
              </div>;
            })}
          </div>
        </PopoverContent>
      </Popover>
  );
}
