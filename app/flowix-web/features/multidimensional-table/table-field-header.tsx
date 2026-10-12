'use client';

import { useRef, useState, useEffect } from 'react';
import { ChevronRight, Plus, X } from 'lucide-react';
import type { PropertyPreset } from '@features/document/properties/presets';
import { createPropertySvgIcon } from '@features/document/properties/property-type-icon';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import type { I18nKey } from '@/lib/i18n';
import type { PropertyIconKind, PropertyKind } from '@/lib/property-types';
import { getPropertyTypeDefinition } from '@/lib/property-types';
import { createUuidV7, type TableField, type TableFieldOption, type TableFieldType } from './model';
import { TableFieldList } from './table-field-list';
import type { ReactNode } from 'react';

export function FieldTypeIcon({ kind, title, compact = false }: { kind: PropertyIconKind; title: string; compact?: boolean }) {
  const hostRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const icon = createPropertySvgIcon(kind);
    hostRef.current?.replaceChildren(icon);
    return () => icon.remove();
  }, [kind]);

  return <span ref={hostRef} title={title} aria-hidden="true" className={`inline-flex ${compact ? 'h-4 w-4' : 'h-5 w-5'} shrink-0 items-center justify-center text-[var(--muted-foreground)]`} />;
}

export function TablePresetMenu({
  triggerLabel = '预设属性',
  triggerIcon,
  triggerPadding = 'px-1.5',
  customPresets,
  systemPresets,
  disabled,
  open,
  onOpenChange,
  t,
  onSelect,
  onRemove,
  onManage,
  isAdded,
}: {
  triggerLabel?: string;
  triggerIcon?: ReactNode;
  triggerPadding?: 'px-1.5' | 'px-2';
  customPresets: PropertyPreset[];
  systemPresets: PropertyPreset[];
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  t: (key: I18nKey) => string;
  onSelect: (preset: PropertyPreset) => void;
  onRemove?: (preset: PropertyPreset) => void;
  onManage: () => void;
  isAdded?: (preset: PropertyPreset) => boolean;
}) {
  const renderGroup = (title: string, presets: PropertyPreset[], showType = false) => presets.length > 0 && <section className="space-y-0.5">
    <p className="agent-thread-card__codex-settings-title">{title}</p>
    {presets.map((preset) => {
      const added = isAdded?.(preset) ?? false;
      return <button
        key={`${preset.source}:${preset.key}`}
        type="button"
        disabled={disabled}
        aria-pressed={added}
        onClick={() => added ? onRemove?.(preset) : onSelect(preset)}
        className="flex h-8 w-full min-w-0 items-center justify-between gap-3 rounded-lg px-1.5 text-left text-sm hover:bg-[var(--hover-bg)] disabled:cursor-default disabled:opacity-50"
        title={preset.key}
      >
        <span className="min-w-0 truncate">{preset.label}</span>
        <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5 text-right">
          <span className="truncate text-right text-xs text-[var(--muted-foreground)]">{showType ? t(getPropertyTypeDefinition(preset.kind).labelKey) : preset.key}</span>
        </span>
        <input type="checkbox" checked={added} readOnly aria-hidden="true" tabIndex={-1} className="pointer-events-none h-4 w-4 shrink-0 accent-[var(--brand)]" />
      </button>;
    })}</section>;

  return <Popover open={open} onOpenChange={onOpenChange}>
    <PopoverTrigger asChild>
      <button type="button" disabled={disabled} className={`flex h-8 w-full items-center justify-between rounded-lg ${triggerPadding} text-left text-sm hover:bg-[var(--hover-bg)] data-[state=open]:bg-[var(--hover-bg)] data-[state=open]:text-[var(--foreground)] disabled:opacity-50`}>
        <span className="flex min-w-0 items-center gap-1.5">{triggerIcon}{triggerLabel}</span>
        <ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" aria-hidden="true" />
      </button>
    </PopoverTrigger>
    <PopoverContent side="left" align="start" sideOffset={0} ignoreSelectOutside={false} style={{ zIndex: 170 }} className="max-h-[min(70vh,420px)] w-[213px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl p-1.5 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
      <div className="space-y-2">
        {renderGroup(t('document.properties.category.system'), systemPresets)}
        {renderGroup(t('document.properties.category.custom'), customPresets, true)}
        <button type="button" disabled={disabled} onClick={onManage} className="flex h-8 w-full items-center rounded-lg px-2 text-left text-sm text-[var(--foreground)] hover:bg-[var(--hover-bg)] disabled:opacity-50">
          预设属性管理
        </button>
      </div>
    </PopoverContent>
  </Popover>;
}

export interface TableFieldEditorFormProps {
  name: string;
  onNameChange: (name: string) => void;
  nameDisabled?: boolean;
  onNameSubmit?: () => void;
  type: TableFieldType;
  typeChoices: TableFieldType[];
  onTypeChange: (type: TableFieldType) => void;
  typeDisabled?: boolean;
  typeMenuOpen: boolean;
  onTypeMenuOpenChange: (open: boolean) => void;
  options: TableFieldOption[];
  onOptionsChange: (options: TableFieldOption[]) => void;
  onDraftCommit?: (name: string, options: TableFieldOption[]) => void;
  focusOptionId?: string | null;
  onOptionFocusHandled?: (optionId: string) => void;
  customPresets: PropertyPreset[];
  systemPresets: PropertyPreset[];
  presetMenuOpen: boolean;
  onPresetMenuOpenChange: (open: boolean) => void;
  afterType?: ReactNode;
  showPresetMenu?: boolean;
  showOptions?: boolean;
  isPresetAdded?: (preset: PropertyPreset) => boolean;
  onSelectPreset: (preset: PropertyPreset) => void;
  onRemovePreset?: (preset: PropertyPreset) => void;
  onManagePresets: () => void;
  onHide?: () => void;
  onDelete?: () => void;
  disabled?: boolean;
  t: (key: I18nKey) => string;
  typeLabel: (type: PropertyKind | 'primary') => string;
  typeIconKind: (type: TableFieldType) => PropertyIconKind;
}

export function TableFieldEditorForm({
  name,
  onNameChange,
  nameDisabled = false,
  onNameSubmit,
  type,
  typeChoices,
  onTypeChange,
  typeDisabled = false,
  typeMenuOpen,
  onTypeMenuOpenChange,
  options,
  onOptionsChange,
  onDraftCommit,
  focusOptionId,
  onOptionFocusHandled,
  customPresets,
  systemPresets,
  presetMenuOpen,
  onPresetMenuOpenChange,
  afterType,
  showPresetMenu = true,
  showOptions = true,
  isPresetAdded,
  onSelectPreset,
  onRemovePreset,
  onManagePresets,
  onHide,
  onDelete,
  disabled = false,
  t,
  typeLabel,
  typeIconKind,
}: TableFieldEditorFormProps) {
  const supportsOptions = type === 'Select' || type === 'MultiSelect';
  return <div className="space-y-1">
    <input
      autoFocus
      value={name}
      disabled={nameDisabled || disabled}
      onChange={(event) => onNameChange(event.target.value)}
      onBlur={() => onDraftCommit?.(name, options)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || !onNameSubmit) return;
        event.preventDefault();
        onNameSubmit();
      }}
      aria-label="名称"
      placeholder="名称"
      className="h-8 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none disabled:opacity-50"
    />
    <Popover open={typeMenuOpen} onOpenChange={onTypeMenuOpenChange}>
      <PopoverTrigger asChild>
        <button type="button" disabled={typeDisabled || disabled} className="flex h-8 w-full items-center justify-between rounded-lg px-1.5 text-left text-sm hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)] data-[state=open]:bg-[var(--hover-bg)] data-[state=open]:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-50">
          <span>类型</span>
          <span className="flex min-w-0 items-center gap-0 text-[var(--muted-foreground)]">
            <span className="truncate">{typeLabel(type)}</span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="left" align="start" sideOffset={0} ignoreSelectOutside={false} fitViewport style={{ zIndex: 170 }} className="max-h-[min(70vh,420px)] w-[180px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <div className="space-y-1">
          {typeChoices.map((choice) => <button
            key={choice}
            type="button"
            disabled={disabled}
            aria-pressed={type === choice}
            onClick={() => {
              onTypeChange(choice);
              onTypeMenuOpenChange(false);
            }}
            className={`flex h-8 w-full items-center gap-1.5 rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50 ${type === choice ? 'bg-[var(--muted)] text-[var(--foreground)]' : ''}`}
          >
            <FieldTypeIcon kind={typeIconKind(choice)} title={typeLabel(choice)} />
            <span className="truncate">{typeLabel(choice)}</span>
          </button>)}
        </div>
      </PopoverContent>
    </Popover>
    {afterType}
    {showPresetMenu && <TablePresetMenu
      triggerLabel="预设属性"
      customPresets={customPresets}
      systemPresets={systemPresets}
      disabled={disabled}
      open={presetMenuOpen}
      onOpenChange={onPresetMenuOpenChange}
      t={t}
      onSelect={onSelectPreset}
      onRemove={onRemovePreset}
      isAdded={isPresetAdded}
      onManage={onManagePresets}
    />}
    {showOptions && supportsOptions && <div>
      <p className="agent-thread-card__codex-settings-title px-0.5">选项</p>
      <TableFieldList
        ids={options.map((option) => option.id)}
        disabled={disabled}
        itemTypeLabel="选项"
        label={(id) => options.find((option) => option.id === id)?.label || '未命名选项'}
        onReorder={(ids) => {
          const nextOptions = ids.map((id) => options.find((option) => option.id === id)!);
          onOptionsChange(nextOptions);
          onDraftCommit?.(name, nextOptions);
        }}
        renderField={(id) => {
          const index = options.findIndex((option) => option.id === id);
          const option = options[index];
          return <div className="flex min-w-0 items-center gap-1">
          <input
            value={option.label}
            autoFocus={option.id === focusOptionId}
            onFocus={(event) => {
              if (option.id !== focusOptionId) return;
              event.currentTarget.select();
              onOptionFocusHandled?.(option.id);
            }}
            disabled={disabled}
            onChange={(event) => onOptionsChange(options.map((item) => item.id === option.id ? { ...item, label: event.target.value } : item))}
            onBlur={() => onDraftCommit?.(name, options)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              onOptionsChange([...options, { id: `opt_${createUuidV7()}`, label: '' }]);
            }}
            placeholder={`选项 ${index + 1}`}
            aria-label={`选项 ${index + 1}`}
            className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm outline-none disabled:opacity-50"
          />
          <button
            type="button"
            aria-label={`删除选项 ${index + 1}`}
            title="删除选项"
            disabled={disabled}
            onClick={() => onOptionsChange(options.filter((item) => item.id !== option.id))}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--destructive)] disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          </div>;
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => onOptionsChange([...options, { id: `opt_${createUuidV7()}`, label: '' }])}
        className="mt-1.5 flex h-7 w-full items-center gap-1.5 rounded-lg px-2 text-left text-xs text-[var(--muted-foreground)] hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)] disabled:opacity-50"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />添加选项
      </button>
    </div>}
    {onHide && <button type="button" aria-label="隐藏此列" title="隐藏此列" disabled={disabled} onClick={onHide} className="flex h-8 w-full min-w-0 items-center justify-between gap-3 rounded-lg px-1.5 text-left text-sm hover:bg-[var(--hover-bg)] disabled:cursor-default disabled:opacity-50">
      隐藏
    </button>}
    {onDelete && <button type="button" aria-label="删除此列" title="删除此列" disabled={disabled} onClick={onDelete} className="flex h-8 w-full min-w-0 items-center justify-between gap-3 rounded-lg px-1.5 text-left text-sm hover:bg-[var(--hover-bg)] hover:text-[var(--destructive)] disabled:cursor-default disabled:opacity-50">
      删除
    </button>}
  </div>;
}

interface TableFieldHeaderProps {
  field: TableField;
  label: string;
  trailingLabel?: string;
  isPresetAdded?: (preset: PropertyPreset) => boolean;
  onRemovePreset?: (preset: PropertyPreset) => void;
  compact?: boolean;
  hideTypeIcon?: boolean;
  readOnly?: boolean;
  datasetMenu?: (onOpenChange: (open: boolean) => void) => ReactNode;
  saving: boolean;
  open: boolean;
  focusOptionId?: string | null;
  onOptionFocusHandled?: (optionId: string) => void;
  pendingOption?: TableFieldOption | null;
  typeChoices: TableFieldType[];
  customPresets: PropertyPreset[];
  systemPresets: PropertyPreset[];
  t: (key: I18nKey) => string;
  typeLabel: (type: PropertyKind | 'primary') => string;
  typeIconKind: (type: TableFieldType) => PropertyIconKind;
  onOpenChange: (open: boolean) => void;
  onSaveEdits: (field: TableField, name: string, options: TableFieldOption[]) => Promise<boolean>;
  onChangeType: (field: TableField, type: TableFieldType, options: TableFieldOption[]) => Promise<boolean>;
  onApplyPreset: (field: TableField, preset: PropertyPreset) => Promise<boolean>;
  onDelete: (field: TableField) => Promise<boolean>;
  onManagePresets: () => void;
  onHide?: (field: TableField) => void | Promise<void>;
}

export function TableFieldHeader({
  field,
  label,
  trailingLabel,
  isPresetAdded,
  onRemovePreset,
  compact = false,
  hideTypeIcon = false,
  readOnly = false,
  datasetMenu,
  saving,
  open,
  focusOptionId,
  onOptionFocusHandled,
  pendingOption,
  typeChoices,
  customPresets,
  systemPresets,
  t,
  typeLabel,
  typeIconKind,
  onOpenChange,
  onSaveEdits,
  onChangeType,
  onApplyPreset,
  onDelete,
  onManagePresets,
  onHide,
}: TableFieldHeaderProps) {
  const [propertyKeyDraft, setPropertyKeyDraft] = useState(label);
  const [optionsDraft, setOptionsDraft] = useState<TableFieldOption[]>(() => [
    ...(field.options ?? []),
    ...(open && pendingOption ? [pendingOption] : []),
  ]);
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);
  const [datasetMenuOpen, setDatasetMenuOpen] = useState(false);
  const wasOpenRef = useRef(open);
  const skipSaveOnCloseRef = useRef(false);
  const submittedDraftRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  const saveDraft = (name = propertyKeyDraft, options = optionsDraft) => {
    if (field.type === 'primary' || readOnly) return;
    // Focusing an unchanged input must not start a write before a drag.
    if (name === label && JSON.stringify(options) === JSON.stringify(field.options ?? [])) return;
    const signature = JSON.stringify([name, options]);
    if (submittedDraftRef.current === signature) return;
    submittedDraftRef.current = signature;
    void onSaveEdits(field, name, options).then((saved) => {
      if (!saved && submittedDraftRef.current === signature) submittedDraftRef.current = null;
    });
  };
  const disappearRef = useRef({ open, saveDraft });
  disappearRef.current = { open, saveDraft };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Parent popovers may disappear without delivering a child close event.
      // Defer to distinguish actual unmounts from Strict Mode's effect replay.
      queueMicrotask(() => {
        if (!mountedRef.current && disappearRef.current.open && !skipSaveOnCloseRef.current) {
          disappearRef.current.saveDraft();
        }
      });
    };
  }, []);

  useEffect(() => {
    if (wasOpenRef.current === open) return;
    wasOpenRef.current = open;
    setTypeMenuOpen(false);
    setPresetMenuOpen(false);
    setDatasetMenuOpen(false);
    if (open) {
      submittedDraftRef.current = null;
      setPropertyKeyDraft(label);
      setOptionsDraft([...(field.options ?? []), ...(pendingOption ? [pendingOption] : [])]);
      return;
    }
    const skipSave = skipSaveOnCloseRef.current;
    skipSaveOnCloseRef.current = false;
    if (!skipSave) {
      if (field.type === 'primary' || readOnly) return;
      saveDraft();
    }
  }, [field, label, onSaveEdits, open, optionsDraft, pendingOption, propertyKeyDraft, readOnly]);

  const handleOpenChange = (nextOpen: boolean) => {
    // The dataset menu can unmount this editor in the same outside-click event.
    // Submit before notifying the parent instead of waiting for the close effect.
    if (!nextOpen && wasOpenRef.current) {
      wasOpenRef.current = false;
      if (!skipSaveOnCloseRef.current && field.type !== 'primary' && !readOnly) {
        saveDraft();
      }
      skipSaveOnCloseRef.current = false;
    }
    setTypeMenuOpen(false);
    setPresetMenuOpen(false);
    setDatasetMenuOpen(false);
    if (nextOpen) {
      setPropertyKeyDraft(label);
      setOptionsDraft(field.options ?? []);
    }
    onOpenChange(nextOpen);
  };

  const closeMenu = () => {
    skipSaveOnCloseRef.current = true;
    setTypeMenuOpen(false);
    setPresetMenuOpen(false);
    setDatasetMenuOpen(false);
    onOpenChange(false);
  };

  const submitName = async () => {
    if (await onSaveEdits(field, propertyKeyDraft, optionsDraft)) closeMenu();
  };

  const selectPreset = async (preset: PropertyPreset) => {
    setPresetMenuOpen(false);
    setDatasetMenuOpen(false);
    if (await onApplyPreset(field, preset)) closeMenu();
  };

  const deleteField = async () => {
    if (await onDelete(field)) closeMenu();
  };

  const hideField = async () => {
    if (!onHide || !await onSaveEdits(field, propertyKeyDraft, optionsDraft)) return;
    await onHide(field);
    closeMenu();
  };

  const managePresets = async () => {
    if (!await onSaveEdits(field, propertyKeyDraft, optionsDraft)) return;
    onManagePresets();
    closeMenu();
  };

  const changeType = async (type: TableFieldType) => {
    setTypeMenuOpen(false);
    const nextOptions = type === 'Select' || type === 'MultiSelect'
      ? type === field.type || field.options?.length
        ? field.options ?? []
        : ['选项 1', '选项 2', '选项 3'].map((label) => ({ id: `opt_${createUuidV7()}`, label }))
      : [];
    if (await onChangeType(field, type, nextOptions)) setOptionsDraft(nextOptions);
  };

  return <Popover open={open} onOpenChange={handleOpenChange}>
    <PopoverTrigger asChild>
      <button type="button" disabled={saving} title={field.property_key ?? '笔记文档'} aria-label={`编辑属性 ${label}`} className={compact
        ? `flex h-8 w-full min-w-0 max-w-full flex-1 items-center ${trailingLabel ? 'gap-0.5' : 'gap-1.5'} overflow-hidden rounded-lg px-1 text-left text-sm text-[var(--foreground)] hover:bg-[var(--hover-bg)] disabled:opacity-50`
        : 'multidimensional-table__cell-content multidimensional-table__header-trigger group flex min-h-9 min-w-0 items-center gap-x-1.5 text-left text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] data-[state=open]:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-60'}>
        {!hideTypeIcon && <FieldTypeIcon kind={typeIconKind(field.type)} title={typeLabel(field.type)} compact={compact} />}
        {compact && trailingLabel && <span className="inline-flex shrink-0 items-center rounded-md border border-[var(--border)] bg-[var(--muted)] px-1 py-px text-xs font-normal text-[var(--muted-foreground)]">{trailingLabel}</span>}
        <span className={compact ? `block min-w-0 ${trailingLabel ? '' : 'flex-1'} overflow-hidden text-ellipsis whitespace-nowrap` : 'min-w-0 break-words'}>{label}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent anchorSelector={compact ? '[data-table-field-item]' : undefined} align="start" side={compact ? 'right' : 'bottom'} sideOffset={0} fitViewport style={{ zIndex: 160 }} ignorePopoverOutside={typeMenuOpen || presetMenuOpen || datasetMenuOpen} ignoreSelectOutside={field.type === 'primary'} className="max-h-[min(70vh,420px)] w-[213px] p-1.5 max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
      <TableFieldEditorForm
        name={propertyKeyDraft}
        onNameChange={setPropertyKeyDraft}
        nameDisabled={field.type === 'primary' || readOnly}
        onNameSubmit={submitName}
        type={field.type}
        typeChoices={typeChoices}
        onTypeChange={changeType}
        typeDisabled={field.type === 'primary' || readOnly}
        typeMenuOpen={typeMenuOpen}
        onTypeMenuOpenChange={(nextOpen) => {
          setTypeMenuOpen(nextOpen);
          if (nextOpen) setPresetMenuOpen(false);
        }}
        options={optionsDraft}
        onOptionsChange={setOptionsDraft}
        onDraftCommit={saveDraft}
        focusOptionId={focusOptionId}
        onOptionFocusHandled={onOptionFocusHandled}
        customPresets={customPresets}
        systemPresets={systemPresets}
        presetMenuOpen={presetMenuOpen}
        onPresetMenuOpenChange={(nextOpen) => {
          setPresetMenuOpen(nextOpen);
          if (nextOpen) setTypeMenuOpen(false);
        }}
        afterType={open && datasetMenu?.(setDatasetMenuOpen)}
        showPresetMenu={false}
        showOptions={!readOnly}
        isPresetAdded={isPresetAdded}
        onSelectPreset={(preset) => void selectPreset(preset)}
        onRemovePreset={onRemovePreset}
        onManagePresets={managePresets}
        onHide={onHide ? () => { void hideField(); } : undefined}
        onDelete={field.type !== 'primary' && (!readOnly || trailingLabel === '预设') ? () => void deleteField() : undefined}
        disabled={saving}
        t={t}
        typeLabel={typeLabel}
        typeIconKind={typeIconKind}
      />
    </PopoverContent>
  </Popover>;
}
