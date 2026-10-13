'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Plus, X } from 'lucide-react';
import { FunnelIcon } from '@phosphor-icons/react';
import { files, type NotebookFolderOption } from '@platform/tauri/client';
import { ResourceFolderIcon } from '@features/surface/resource-file-icon';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import type { I18nKey } from '@/lib/i18n';
import type { TableAutoCollectConfig, TableAutoCollectCondition, TableAutoCollectFileType, TableAutoCollectPropertyCondition } from './model';

type AutoCollectFieldOption = { id: string; label: string };

function normalizeAutoCollectFileType(value: string | undefined): TableAutoCollectFileType {
  if (value?.trim().toLowerCase() === 'markdown') return 'markdown';
  return '';
}

function readAutoCollectCondition(defaultFieldId: string, fields: AutoCollectFieldOption[], config: TableAutoCollectConfig | null): TableAutoCollectCondition {
  const condition = config?.condition ?? {};
  return {
    ...condition,
    property_match: condition.property_match ?? 'union',
    property_conditions: (condition.property_conditions ?? [{ field_id: defaultFieldId, operator: 'contains' as const, value: '' }]).map((item) => ({
      ...item,
      field_id: fields.find((fieldOption) => fieldOption.id === item.field_id)?.label ?? item.field_id,
    })),
    file_condition: {
      file_name_contains: '',
      path_contains: '',
      ...condition.file_condition,
      file_type: normalizeAutoCollectFileType(condition.file_condition?.file_type),
    },
  };
}

function resolveAutoCollectCondition(
  condition: TableAutoCollectCondition,
  fields: AutoCollectFieldOption[],
): TableAutoCollectCondition {
  const resolveField = (fieldId: string) => fields.find((item) => item.id === fieldId)
    ?? fields.find((item) => item.label === fieldId);
  const propertyConditions = condition.property_conditions?.map((item) => ({
    ...item,
    field_id: resolveField(item.field_id)?.id ?? item.field_id,
  }));
  return {
    ...condition,
    ...(propertyConditions ? { property_conditions: propertyConditions } : {}),
  };
}

export function TableDatasetMenu({ defaultFieldId, fields: autoCollectFields, config: autoCollectConfig = null, notebookPath, fixedFolderPath, saving, t, onSave, onSavePath, open: controlledOpen, onOpenChange, children, ignoreOutside = false, filterOnly = false, filterOpen, onFilterOpenChange }: {
  defaultFieldId: string;
  fields: AutoCollectFieldOption[];
  config?: TableAutoCollectConfig | null;
  notebookPath?: string | null;
  /** A folder collection is always scoped to its containing folder. */
  fixedFolderPath?: string;
  saving: boolean;
  t: (key: I18nKey) => string;
  onSave: (condition: TableAutoCollectCondition) => Promise<boolean>;
  onSavePath?: (path: string | null) => Promise<boolean>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
  ignoreOutside?: boolean;
  filterOnly?: boolean;
  filterOpen?: boolean;
  onFilterOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const [autoCollectDraft, setAutoCollectDraft] = useState(() => readAutoCollectCondition(defaultFieldId, autoCollectFields, autoCollectConfig));
  const [localAutoCollectMenuOpen, setLocalAutoCollectMenuOpen] = useState(false);
  const autoCollectMenuOpen = filterOpen ?? localAutoCollectMenuOpen;
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [folderOptions, setFolderOptions] = useState<NotebookFolderOption[]>([]);
  const [folderOptionsLoading, setFolderOptionsLoading] = useState(false);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const baseline = useRef(JSON.stringify(autoCollectDraft));
  const draftOpen = filterOnly ? autoCollectMenuOpen : open;
  const folderPathLabel = fixedFolderPath !== undefined
    ? '固定'
    : autoCollectDraft.file_condition?.path_scope === 'all'
      ? t('multidimensionalTable.autoCollect.anyFolder')
      : autoCollectDraft.file_condition?.path_contains;
  const canClearFolderPath = fixedFolderPath === undefined
    && (autoCollectDraft.file_condition?.path_scope === 'all' || Boolean(autoCollectDraft.file_condition?.path_contains));
  useEffect(() => {
    if (fixedFolderPath !== undefined) setFolderPickerOpen(false);
  }, [fixedFolderPath]);
  const wasOpen = useRef(draftOpen);
  const skipSave = useRef(false);
  const changeOpen = (next: boolean) => { setLocalOpen(next); onOpenChange?.(next); };
  const closeMenu = () => {
    skipSave.current = true;
    changeOpen(false);
    if (filterOpen === undefined) setLocalAutoCollectMenuOpen(false);
    onFilterOpenChange?.(false);
  };
  const savePathImmediately = async (path: string | null) => {
    const withPath = (condition: TableAutoCollectCondition): TableAutoCollectCondition => ({
      ...condition,
      file_condition: {
        ...Object.fromEntries(Object.entries(condition.file_condition ?? {})
          .filter(([key]) => key !== 'path_contains' && key !== 'path_scope')),
        ...(path === null ? { path_scope: 'all' as const } : path ? { path_contains: path } : {}),
      },
    });
    const nextDraft = withPath(autoCollectDraft);
    if (onSavePath && !(await onSavePath(path))) return false;
    setAutoCollectDraft(nextDraft);
    // Only the path has been persisted; keep other draft changes pending.
    baseline.current = JSON.stringify(withPath(JSON.parse(baseline.current) as TableAutoCollectCondition));
    return true;
  };
  useEffect(() => {
    if (wasOpen.current === draftOpen) return;
    wasOpen.current = draftOpen;
    if (!filterOnly && filterOpen === undefined) setLocalAutoCollectMenuOpen(false);
    setFolderPickerOpen(false);
    if (draftOpen) {
      const draft = readAutoCollectCondition(defaultFieldId, autoCollectFields, autoCollectConfig);
      baseline.current = JSON.stringify(draft);
      setAutoCollectDraft(draft);
    } else {
      if (!skipSave.current && !filterOnly && JSON.stringify(autoCollectDraft) !== baseline.current) {
        void onSave(resolveAutoCollectCondition(autoCollectDraft, autoCollectFields));
      }
      skipSave.current = false;
    }
  }, [draftOpen, defaultFieldId, autoCollectFields, autoCollectConfig, autoCollectDraft, filterOnly, filterOpen, onSave]);
  useEffect(() => {
    if (!folderPickerOpen || !notebookPath) return;
    let active = true;
    setFolderOptionsLoading(true);
    void files.getNotebookFolderOptions(notebookPath).then((options) => {
      if (active) setFolderOptions(options);
    }).catch(() => {
      if (active) setFolderOptions([]);
    }).finally(() => {
      if (active) setFolderOptionsLoading(false);
    });
    return () => { active = false; };
  }, [folderPickerOpen, notebookPath]);
  useEffect(() => {
    if (!folderPickerOpen) return;
    setCollapsedFolders(new Set(folderOptions
      .filter((option) => folderOptions.some((candidate) => candidate.relativePath.startsWith(`${option.relativePath}/`)))
      .map((option) => option.relativePath)));
  }, [folderPickerOpen, folderOptions]);

  const folderPathRow = <Popover open={folderPickerOpen} onOpenChange={setFolderPickerOpen}>
    <div data-table-dataset-location-menu className={`flex min-w-0 items-center gap-0.5 rounded-lg transition-colors ${saving || !notebookPath || fixedFolderPath !== undefined ? '' : 'hover:bg-[var(--hover-bg)]'}`}>
      <PopoverTrigger asChild>
        <button type="button" disabled={saving || !notebookPath || fixedFolderPath !== undefined} className="flex h-8 min-w-0 flex-1 items-center justify-between gap-2 rounded-lg pl-1.5 text-left text-sm disabled:opacity-50">
          <span className="min-w-0 truncate">浏览和保存</span>
          <span className="flex min-w-0 flex-1 items-center justify-end gap-1 text-[var(--muted-foreground)]">
            {folderPathLabel && <span title={folderPathLabel} className="max-w-[150px] truncate text-right text-xs">{folderPathLabel}</span>}
          </span>
        </button>
      </PopoverTrigger>
      {canClearFolderPath && <button
        type="button"
        disabled={saving}
        aria-label="清空路径"
        title="清空路径"
        onClick={(event) => {
          event.stopPropagation();
          void savePathImmediately('');
        }}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] disabled:opacity-50"
      ><X className="h-3 w-3" aria-hidden="true" /></button>}
      <PopoverTrigger asChild>
        <button type="button" aria-label="浏览和保存" disabled={saving || !notebookPath || fixedFolderPath !== undefined} className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] disabled:opacity-50">
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
    </div>
      <PopoverContent anchorSelector="[data-table-dataset-location-menu]" side="left" align="start" sideOffset={0} style={{ zIndex: 170 }} className="max-h-[min(60vh,280px)] w-[260px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        {folderOptionsLoading ? <p className="px-2 py-2 text-xs text-[var(--muted-foreground)]">{t('multidimensionalTable.autoCollect.loadingFolders')}</p>
          : <div className="space-y-0.5">
            <button
              type="button"
              aria-pressed={autoCollectDraft.file_condition?.path_scope === 'all'}
              onClick={async () => {
                if (await savePathImmediately(null)) setFolderPickerOpen(false);
              }}
              className={`flex h-8 w-full items-center gap-2 rounded-lg pr-2 text-left text-sm hover:bg-[var(--muted)] ${autoCollectDraft.file_condition?.path_scope === 'all' ? 'bg-[var(--muted)]' : ''}`}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2 pl-2">
                <ResourceFolderIcon expanded={false} className="h-[18px] w-[18px] shrink-0" />
                <span className="min-w-0 truncate">{t('multidimensionalTable.autoCollect.anyFolder')}</span>
              </span>
            </button>
            {folderOptions.length === 0 ? <p className="px-2 py-2 text-xs text-[var(--muted-foreground)]">{t('multidimensionalTable.autoCollect.noFolders')}</p> : folderOptions.filter((option) => {
              const segments = option.relativePath.split('/');
              return !segments.slice(0, -1).some((_, index) => collapsedFolders.has(segments.slice(0, index + 1).join('/')));
            }).map((option) => {
              const segments = option.relativePath.split('/');
              const folderName = segments[segments.length - 1] ?? option.relativePath;
              const selected = autoCollectDraft.file_condition?.path_contains === option.relativePath;
              const hasChildren = folderOptions.some((candidate) => candidate.relativePath.startsWith(`${option.relativePath}/`));
              const collapsed = collapsedFolders.has(option.relativePath);
              return <div key={option.relativePath} className="flex h-8 min-w-0 items-center rounded-lg pr-2 text-sm hover:bg-[var(--muted)]" style={{ paddingLeft: `${8 + option.depth * 12}px` }}>
                {hasChildren ? <button
                  type="button"
                  aria-label={`${collapsed ? '展开' : '折叠'}文件夹 ${folderName}`}
                  aria-expanded={!collapsed}
                  onClick={() => setCollapsedFolders((current) => {
                    const next = new Set(current);
                    if (next.has(option.relativePath)) next.delete(option.relativePath);
                    else next.add(option.relativePath);
                    return next;
                  })}
                  className="inline-flex h-6 w-5 shrink-0 items-center justify-center rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                ><ChevronRight className={`h-3.5 w-3.5 transition-transform ${collapsed ? '' : 'rotate-90'}`} aria-hidden="true" /></button>
                  : <span className="w-5 shrink-0" aria-hidden="true" />}
                <button
                  type="button"
                  title={option.relativePath}
                  aria-pressed={selected}
                  onClick={async () => {
                    if (await savePathImmediately(option.relativePath)) setFolderPickerOpen(false);
                  }}
                  className={`flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg text-left ${selected ? 'bg-[var(--muted)]' : ''}`}
                >
                  <ResourceFolderIcon expanded={!collapsed && hasChildren} className="h-[18px] w-[18px] shrink-0" />
                  <span className="min-w-0 truncate">{folderName}</span>
                </button>
              </div>;
            })}
          </div>}
      </PopoverContent>
    </Popover>;

  const changeFilterOpen = (next: boolean) => {
    if (filterOpen === undefined) setLocalAutoCollectMenuOpen(next);
    onFilterOpenChange?.(next);
  };
  const dataSelectionConfigured = Boolean(
    autoCollectDraft.property_conditions?.some((condition) => condition.field_id.trim() && condition.value.trim())
    || autoCollectDraft.file_condition?.file_name_contains?.trim()
    || autoCollectDraft.file_condition?.file_type,
  );
  const resetDataSelection = () => setAutoCollectDraft((current) => {
    const reset = readAutoCollectCondition(defaultFieldId, autoCollectFields, null);
    return {
      ...reset,
      file_condition: {
        ...reset.file_condition,
        ...(current.file_condition?.path_scope === 'all' ? { path_scope: 'all' as const } : {}),
        path_contains: current.file_condition?.path_contains ?? '',
      },
    };
  });
  const filterMenu = <>
        <Popover open={autoCollectMenuOpen} onOpenChange={changeFilterOpen}>
          <PopoverTrigger asChild>
            <button type="button" disabled={saving} className="flex h-8 w-full items-center justify-between rounded-lg px-1.5 text-left text-sm hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)] data-[state=open]:bg-[var(--hover-bg)] data-[state=open]:text-[var(--foreground)] disabled:opacity-50">
              <span>数据条件</span>
              <span className="flex items-center gap-1 text-xs text-[var(--muted-foreground)]">
                {dataSelectionConfigured ? '已设置' : '未设置'}
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent side="right" align="start" sideOffset={0} ignorePopoverOutside={folderPickerOpen} fitViewport style={{ zIndex: 160 }} className="w-[320px] max-w-[calc(100vw-16px)] rounded-xl px-1 py-2 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
            <div className="space-y-2">
            <div className="space-y-1">
                <div className="min-w-0 space-y-1">
                  <div role="group" aria-label="属性匹配方式" className="multidimensional-table__condition-tabs mx-2">
                    <button
                      type="button"
                      aria-pressed={(autoCollectDraft.property_match ?? 'union') === 'union'}
                      onClick={() => setAutoCollectDraft((current) => ({ ...current, property_match: 'union' }))}
                      className="multidimensional-table__condition-tab"
                    >并集</button>
                    <button
                      type="button"
                      aria-pressed={autoCollectDraft.property_match === 'intersection'}
                      onClick={() => setAutoCollectDraft((current) => ({ ...current, property_match: 'intersection' }))}
                      className="multidimensional-table__condition-tab"
                    >交集</button>
                  </div>
                  <p className="agent-thread-card__codex-settings-title px-2">{t('multidimensionalTable.autoCollect.properties')}</p>
                </div>
                {(autoCollectDraft.property_conditions ?? []).map((condition, index) => <div key={index} className="flex min-w-0 items-center gap-1 px-2">
                  <input
                    value={condition.field_id === '名称' ? '' : condition.field_id}
                    disabled={saving}
                    onChange={(event) => setAutoCollectDraft((current) => ({
                      ...current,
                      property_conditions: (current.property_conditions ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, field_id: event.target.value } : item),
                    }))}
                    placeholder="属性名称"
                    aria-label={`属性条件 ${index + 1} 字段`}
                    className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-transparent px-2 text-sm outline-none disabled:opacity-50"
                  />
                  <Select value={condition.operator} disabled={saving} onValueChange={(operator) => setAutoCollectDraft((current) => ({
                    ...current,
                    property_conditions: (current.property_conditions ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, operator: operator as TableAutoCollectPropertyCondition['operator'] } : item),
                  }))}>
                    <SelectTrigger className="h-8 w-[82px] shrink-0 rounded-lg bg-transparent px-2 text-left text-sm">
                      <SelectValue>{t(`editor.threadCard.featuredNotes.operator.${condition.operator}` as I18nKey)}</SelectValue>
                    </SelectTrigger>
                  <SelectContent align="start" fitViewport style={{ zIndex: 170 }} className="flowix-preferences-select-content">
                    <SelectItem value="contains">{t('editor.threadCard.featuredNotes.operator.contains')}</SelectItem>
                    <SelectItem value="equals">{t('editor.threadCard.featuredNotes.operator.equals')}</SelectItem>
                  </SelectContent>
                  </Select>
                  <input
                    value={condition.value}
                    disabled={saving}
                    onChange={(event) => setAutoCollectDraft((current) => ({
                      ...current,
                      property_conditions: (current.property_conditions ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item),
                    }))}
                    placeholder="内容"
                    aria-label={`属性条件 ${index + 1} 匹配值`}
                    className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-transparent px-2 text-sm outline-none disabled:opacity-50"
                  />
                  {index > 0 && <button
                    type="button"
                    disabled={saving}
                    aria-label={`删除属性条件 ${index + 1}`}
                    onClick={() => setAutoCollectDraft((current) => ({
                      ...current,
                      property_conditions: (current.property_conditions ?? []).filter((_, itemIndex) => itemIndex !== index),
                    }))}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--destructive)] disabled:opacity-50"
                  ><X className="h-3.5 w-3.5" aria-hidden="true" /></button>}
                </div>)}
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setAutoCollectDraft((current) => ({
                    ...current,
                    property_conditions: [...(current.property_conditions ?? []), { field_id: '', operator: 'contains', value: '' }],
                  }))}
                  className="flex h-7 items-center gap-1 rounded-lg px-1.5 text-left text-xs text-[var(--muted-foreground)] hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)] disabled:opacity-50"
                ><Plus className="h-3.5 w-3.5" aria-hidden="true" />添加条件</button>
                <p className="agent-thread-card__codex-settings-title px-2">{t('multidimensionalTable.autoCollect.file')}</p>
                <div className="space-y-1">
                  <label className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-center gap-2 px-2">
                    <span className="px-0.5 text-sm text-[var(--foreground)]">{t('multidimensionalTable.autoCollect.fileName')}</span>
                    <input
                      value={autoCollectDraft.file_condition?.file_name_contains ?? ''}
                      disabled={saving}
                      onChange={(event) => setAutoCollectDraft((current) => ({ ...current, file_condition: { ...current.file_condition, file_name_contains: event.target.value } }))}
                      placeholder={t('multidimensionalTable.autoCollect.fileNameContains')}
                      aria-label={t('multidimensionalTable.autoCollect.fileName')}
                      className="h-8 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none disabled:opacity-50"
                    />
                  </label>
                  <div className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-center gap-2 px-2">
                    <span className="px-0.5 text-sm text-[var(--foreground)]">{t('multidimensionalTable.autoCollect.fileType')}</span>
                    <Select
                      value={autoCollectDraft.file_condition?.file_type || 'any'}
                      disabled={saving}
                      onValueChange={(type) => setAutoCollectDraft((current) => ({
                        ...current,
                        file_condition: { ...current.file_condition, file_type: type === 'any' ? '' : type as TableAutoCollectFileType },
                      }))}
                    >
                      <SelectTrigger className="h-8 min-w-0 w-full rounded-lg bg-transparent px-2 text-left">
                        <SelectValue>{autoCollectDraft.file_condition?.file_type
                          ? t(`multidimensionalTable.autoCollect.type.${autoCollectDraft.file_condition.file_type}` as I18nKey)
                          : t('multidimensionalTable.autoCollect.anyFileType')}</SelectValue>
                      </SelectTrigger>
                      <SelectContent align="start" fitViewport style={{ zIndex: 170 }} className="flowix-preferences-select-content">
                        <SelectItem value="any">{t('multidimensionalTable.autoCollect.anyFileType')}</SelectItem>
                        <SelectItem value="markdown">{t('multidimensionalTable.autoCollect.type.markdown')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
            </div>
            <div className="mx-2 flex gap-2">
              <button type="button" disabled={saving} className="flex h-8 flex-1 items-center justify-center rounded-lg border border-[var(--border)] bg-transparent text-sm text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-50" onClick={resetDataSelection}>{t('multidimensionalTable.autoCollect.reset')}</button>
              <button type="button" disabled={saving} className="flex h-8 flex-1 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--card)] text-sm text-[var(--foreground)] hover:bg-[var(--muted)] disabled:opacity-50" onClick={async () => {
                if (await onSave(resolveAutoCollectCondition(autoCollectDraft, autoCollectFields))) closeMenu();
              }}>应用</button>
            </div>
            </div>
          </PopoverContent>
        </Popover>
  </>;
  if (filterOnly) return filterMenu;
  return <Popover open={open} onOpenChange={changeOpen}>
    <PopoverTrigger asChild><button type="button" disabled={saving} title="数据集合" aria-label="管理数据集" className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg p-0 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"><FunnelIcon size={14} weight="bold" aria-hidden="true" /></button></PopoverTrigger>
    <PopoverContent align="end" side="bottom" sideOffset={0} style={{ zIndex: 150 }} ignorePopoverOutside={autoCollectMenuOpen || folderPickerOpen || ignoreOutside} ignoreSelectOutside className="max-h-[80vh] w-[220px] max-w-[calc(100vw-16px)] overflow-hidden rounded-xl p-1.5 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
      <OverlayScrollbar className="max-h-[calc(80vh-14px)]" scrollerClassName="max-h-[calc(80vh-14px)] overflow-y-auto overflow-x-hidden">
        <div className="space-y-0.5">{folderPathRow}{filterMenu}<div role="separator" aria-hidden="true" className="mx-2 h-px bg-[var(--border)]" />{children}</div>
      </OverlayScrollbar>
    </PopoverContent>
  </Popover>;
}
