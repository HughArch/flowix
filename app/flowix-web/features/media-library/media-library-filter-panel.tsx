import { ChevronDown } from 'lucide-react';
import type { NotebookFolderOption } from '@platform/tauri/client';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import { useI18n } from '@/lib/i18n';
import { ResourceFolderIcon } from '@features/surface/resource-file-icon';
import type { MediaLibraryKind } from './model';

export function MediaLibraryFilterPanel({
  fileName,
  fileType,
  path,
  folderPickerOpen,
  folderOptions,
  folderOptionsLoading,
  notebookAvailable,
  busy = false,
  applying = false,
  autoFocus = false,
  onFileNameChange,
  onFileTypeChange,
  onPathChange,
  onFolderPickerOpenChange,
  onReset,
  onApply,
}: {
  fileName: string;
  fileType: 'any' | MediaLibraryKind;
  path: string;
  folderPickerOpen: boolean;
  folderOptions: NotebookFolderOption[];
  folderOptionsLoading: boolean;
  notebookAvailable: boolean;
  busy?: boolean;
  applying?: boolean;
  autoFocus?: boolean;
  onFileNameChange: (value: string) => void;
  onFileTypeChange: (value: 'any' | MediaLibraryKind) => void;
  onPathChange: (value: string) => void;
  onFolderPickerOpenChange: (open: boolean) => void;
  onReset: () => void;
  onApply: () => void;
}) {
  const { t } = useI18n();

  return <>
    <div className="space-y-1">
      <p className="agent-thread-card__codex-settings-title px-2">{t('media.properties.location')}</p>
      <div className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-center gap-2 px-2">
        <span className="px-0.5 text-sm text-[var(--foreground)]">{t('mediaLibrary.filterPath')}</span>
        <Popover open={folderPickerOpen} onOpenChange={onFolderPickerOpenChange}>
          <PopoverTrigger asChild>
            <button type="button" disabled={!notebookAvailable} className="flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-transparent px-2 text-left text-sm disabled:opacity-50">
              <span className="min-w-0 truncate">{path || t('mediaLibrary.choosePath')}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent side="bottom" align="start" sideOffset={4} style={{ zIndex: 170 }} className="max-h-[min(60vh,280px)] w-[260px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
            {folderOptionsLoading ? <p className="px-2 py-2 text-xs text-[var(--muted-foreground)]">{t('mediaLibrary.loadingFolders')}</p>
              : <div className="space-y-0.5">
                <button
                  type="button"
                  aria-pressed={!path}
                  onClick={() => { onPathChange(''); onFolderPickerOpenChange(false); }}
                  className={`flex h-8 w-full items-center gap-2 rounded-lg pr-2 text-left text-sm hover:bg-[var(--muted)] ${!path ? 'bg-[var(--muted)]' : ''}`}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2 pl-2">
                    <ResourceFolderIcon expanded={false} className="h-[18px] w-[18px] shrink-0" />
                    <span className="min-w-0 truncate">{t('mediaLibrary.anyFolder')}</span>
                  </span>
                </button>
                {folderOptions.length === 0 ? <p className="px-2 py-2 text-xs text-[var(--muted-foreground)]">{t('mediaLibrary.noFolders')}</p> : folderOptions.map((option) => {
                  const folderName = option.relativePath.split('/').filter(Boolean).pop() ?? option.relativePath;
                  const selected = path === option.relativePath;
                  return <button
                    key={option.relativePath}
                    type="button"
                    title={option.relativePath}
                    aria-pressed={selected}
                    onClick={() => { onPathChange(option.relativePath); onFolderPickerOpenChange(false); }}
                    className={`flex h-8 w-full items-center gap-2 rounded-lg pr-2 text-left text-sm hover:bg-[var(--muted)] ${selected ? 'bg-[var(--muted)]' : ''}`}
                    style={{ paddingLeft: `${8 + option.depth * 16}px` }}
                  >
                    <ResourceFolderIcon expanded={false} className="h-[18px] w-[18px] shrink-0" />
                    <span className="min-w-0 truncate">{folderName}</span>
                  </button>;
                })}
              </div>}
          </PopoverContent>
        </Popover>
      </div>
      <p className="agent-thread-card__codex-settings-title px-2">{t('multidimensionalTable.autoCollect.file')}</p>
      <label className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-center gap-2 px-2">
        <span className="px-0.5 text-sm text-[var(--foreground)]">{t('mediaLibrary.filterFileName')}</span>
        <input
          autoFocus={autoFocus}
          value={fileName}
          disabled={busy}
          onChange={(event) => onFileNameChange(event.currentTarget.value)}
          placeholder={t('mediaLibrary.filterFileNamePlaceholder')}
          aria-label={t('mediaLibrary.filterFileName')}
          className="h-8 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none focus:border-[var(--brand)] disabled:opacity-50"
        />
      </label>
      <div className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-center gap-2 px-2">
        <span className="px-0.5 text-sm text-[var(--foreground)]">{t('mediaLibrary.filterType')}</span>
        <Select value={fileType} disabled={busy} onValueChange={(value) => onFileTypeChange(value as 'any' | MediaLibraryKind)}>
          <SelectTrigger className="h-8 min-w-0 w-full rounded-lg bg-transparent px-2 text-left text-sm">
            <SelectValue>{fileType === 'image' ? t('mediaLibrary.images') : fileType === 'video' ? t('mediaLibrary.videos') : t('mediaLibrary.all')}</SelectValue>
          </SelectTrigger>
          <SelectContent align="start" fitViewport style={{ zIndex: 170 }} className="flowix-preferences-select-content">
            <SelectItem value="any">{t('mediaLibrary.all')}</SelectItem>
            <SelectItem value="image">{t('mediaLibrary.images')}</SelectItem>
            <SelectItem value="video">{t('mediaLibrary.videos')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
    <div className="mx-2 mt-2 flex gap-2">
      <button type="button" disabled={busy} className="flex h-8 flex-1 items-center justify-center rounded-lg border border-[var(--border)] bg-transparent text-sm text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-50" onClick={onReset}>{t('mediaLibrary.reset')}</button>
      <button type="button" disabled={busy} className="flex h-8 flex-1 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--card)] text-sm text-[var(--foreground)] hover:bg-[var(--muted)] disabled:opacity-50" onClick={onApply}>{applying ? t('mediaLibrary.saveProgress') : t('mediaLibrary.apply')}</button>
    </div>
  </>;
}
