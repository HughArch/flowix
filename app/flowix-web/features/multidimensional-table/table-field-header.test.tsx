import * as React from 'react';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PropertyPreset } from '@features/document/properties/presets';
import type { TableAutoCollectCondition, TableField, TableFieldOption, TableFieldType } from './model';

vi.mock('@shared/ui/popover', async () => {
  const ReactModule = await import('react');
  const Context = ReactModule.createContext<{ open: boolean; onOpenChange: (open: boolean) => void } | null>(null);
  return {
    Popover: ({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: React.ReactNode }) => (
      <Context.Provider value={{ open, onOpenChange }}>{children}</Context.Provider>
    ),
    PopoverTrigger: ({ children }: { children: React.ReactElement<{ onClick?: (event: React.MouseEvent) => void }> }) => {
      const state = ReactModule.useContext(Context);
      return ReactModule.cloneElement(children, {
        onClick: (event) => {
          children.props.onClick?.(event);
          state?.onOpenChange(!state.open);
        },
      });
    },
    PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('@shared/ui/select', async () => {
  const ReactModule = await import('react');
  const Context = ReactModule.createContext<{ value: string; onValueChange: (value: string) => void; disabled?: boolean } | null>(null);
  return {
    Select: ({ value, onValueChange, disabled, children }: { value: string; onValueChange: (value: string) => void; disabled?: boolean; children: React.ReactNode }) => (
      <Context.Provider value={{ value, onValueChange, disabled }}><div>{children}</div></Context.Provider>
    ),
    SelectTrigger: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) => {
      const state = ReactModule.useContext(Context);
      return <button type="button" {...props} disabled={props.disabled || state?.disabled}>{children}</button>;
    },
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectValue: ({ children, placeholder }: { children?: React.ReactNode; placeholder?: string }) => <span>{children ?? placeholder}</span>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
      const state = ReactModule.useContext(Context);
      return <button type="button" disabled={state?.disabled} onClick={() => state?.onValueChange(value)}>{children}</button>;
    },
  };
});

import { TableDatasetMenu } from './table-dataset-menu';
import { TableFieldHeader, TablePresetMenu } from './table-field-header';

const field: TableField = { id: `fld_${'a'.repeat(32)}`, type: 'Text', property_key: 'title' };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function HeaderHarness({
  field: currentField = field,
  label = 'Title',
  typeChoices = [],
  conditionOnly = false,
  showAutoCollect = conditionOnly,
  autoCollectConfig = null,
  onSaveEdits,
  onChangeType,
  onSaveAutoCollect,
  customPresets = [],
  isPresetAdded,
  onRemovePreset,
  initialOpen = false,
  pendingOption,
  unmountOnClose = false,
  systemPreset = false,
  allowDelete = true,
  compact = false,
  trailingLabel,
}: {
  field?: TableField;
  label?: string;
  typeChoices?: TableFieldType[];
  autoCollectConfig?: import('./model').TableAutoCollectConfig | null;
  conditionOnly?: boolean;
  showAutoCollect?: boolean;
  onSaveEdits: (field: TableField, name: string, options: TableFieldOption[]) => Promise<boolean>;
  onChangeType?: (field: TableField, type: TableFieldType, options: TableFieldOption[]) => Promise<boolean>;
  onSaveAutoCollect: (field: TableField, condition: TableAutoCollectCondition) => Promise<boolean>;
  customPresets?: PropertyPreset[];
  isPresetAdded?: (preset: PropertyPreset) => boolean;
  onRemovePreset?: (preset: PropertyPreset) => void;
  initialOpen?: boolean;
  pendingOption?: TableFieldOption;
  unmountOnClose?: boolean;
  systemPreset?: boolean;
  allowDelete?: boolean;
  compact?: boolean;
  trailingLabel?: string;
}) {
  const [open, setOpen] = useState(initialOpen);
  const datasetProps = {
    defaultFieldId: currentField.id,
    fields: [{ id: currentField.id, label }],
    config: autoCollectConfig,
    saving: false,
    t: (key: import('@/lib/i18n').I18nKey) => key,
    onSave: (condition: TableAutoCollectCondition) => onSaveAutoCollect(currentField, condition),
  };
  if (unmountOnClose && !open) return null;
  if (conditionOnly) return <TableDatasetMenu {...datasetProps} open={open} onOpenChange={setOpen} />;
  return <table><thead><tr><th><TableFieldHeader
    field={currentField}
    systemPreset={systemPreset}
    compact={compact}
    trailingLabel={trailingLabel}
    pendingOption={pendingOption}
    label={label}
    saving={false}
    open={open}
    typeChoices={typeChoices}
    customPresets={customPresets}
    systemPresets={[]}
    t={(key) => key}
    typeLabel={(type) => type}
    typeIconKind={() => 'text'}
    onOpenChange={setOpen}
    onSaveEdits={onSaveEdits}
    onChangeType={onChangeType ?? vi.fn(async () => true)}
    onApplyPreset={vi.fn(async () => true)}
    isPresetAdded={isPresetAdded}
    onRemovePreset={onRemovePreset}
    onDelete={allowDelete ? vi.fn(async () => true) : undefined}
    onHide={allowDelete ? undefined : vi.fn()}
    onManagePresets={vi.fn()}
    datasetMenu={showAutoCollect ? (onFilterOpenChange) => <TableDatasetMenu {...datasetProps} filterOnly onFilterOpenChange={onFilterOpenChange} /> : undefined}
  /></th></tr></thead></table>;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container = null;
});

describe('TableFieldHeader', () => {
  it('uses the dataset property picker labels', async () => {
    const preset: PropertyPreset = { source: 'custom', category: 'custom', key: 'status', label: '状态', kind: 'Text' };
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root?.render(<TablePresetMenu
      triggerLabel="选择属性"
      customGroupLabel="我的"
      customPresets={[preset]}
      systemPresets={[]}
      disabled={false}
      open
      onOpenChange={vi.fn()}
      t={(key) => key}
      onSelect={vi.fn()}
      onManage={vi.fn()}
    />));

    expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('选择属性'))).toBe(true);
    expect([...container.querySelectorAll('p')].some((item) => item.textContent === '我的')).toBe(true);
  });

  it('uses a smaller label for read-only fields in the field manager list', async () => {
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root?.render(<HeaderHarness
      compact
      trailingLabel="只读"
      onSaveEdits={vi.fn(async () => true)}
      onSaveAutoCollect={vi.fn(async () => true)}
    />));

    const label = [...container.querySelectorAll('span')].find((span) => span.textContent === '只读');
    expect(label?.className).toContain('text-xs');
    expect(label?.className).toContain('leading-4');
    expect(label?.className).toContain('py-0');
    expect(container.querySelector('[aria-label="编辑属性 Title"]')?.className).toContain('pl-0.5');
  });

  it('keeps the hide action but omits delete when a system preset has no delete handler', async () => {
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root?.render(<HeaderHarness
      systemPreset
      allowDelete={false}
      onSaveEdits={vi.fn(async () => true)}
      onSaveAutoCollect={vi.fn(async () => true)}
    />));

    const trigger = [...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '编辑属性 Title');
    await act(async () => trigger?.click());

    expect(container.querySelector('button[aria-label="删除此列"]')).toBeNull();
    expect(container.querySelector('button[aria-label="隐藏此列"]')).toBeTruthy();
  });

  it('does not show preset properties in the header editor', async () => {
    const preset: PropertyPreset = {
      source: 'custom',
      category: 'custom',
      key: 'status',
      label: '状态',
      kind: 'Text',
    };
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root?.render(<HeaderHarness
      customPresets={[preset]}
      isPresetAdded={(item) => item.key === preset.key}
      onSaveEdits={vi.fn(async () => true)}
      onSaveAutoCollect={vi.fn(async () => true)}
    />));

    const headerTrigger = [...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '编辑属性 Title');
    await act(async () => headerTrigger?.click());
    expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('预设属性'))).toBe(false);
  });

  it('styles the select option list without row hover and uses px-2 for its heading', async () => {
    const option = { id: `opt_${'d'.repeat(32)}`, label: 'Open' };
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root?.render(<HeaderHarness
      field={{ ...field, type: 'Select', options: [option] }}
      initialOpen
      onSaveEdits={vi.fn(async () => true)}
      onSaveAutoCollect={vi.fn(async () => true)}
    />));

    const heading = [...container.querySelectorAll('p')].find((item) => item.textContent === '选项');
    const row = container.querySelector<HTMLElement>(`[data-field-id="${option.id}"]`);
    expect(heading?.className).toContain('px-2');
    expect(heading?.className).not.toContain('mx-2');
    expect(row?.className).not.toContain('hover:bg-');
  });

  it('saves its name draft when the header menu closes', async () => {
    const onSaveEdits = vi.fn(async (_field: TableField, _name: string, _options: TableFieldOption[]) => true);
    const onSaveAutoCollect = vi.fn(async () => true);
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root?.render(<HeaderHarness onSaveEdits={onSaveEdits} onSaveAutoCollect={onSaveAutoCollect} />));

    const trigger = [...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '编辑属性 Title');
    expect(trigger).toBeTruthy();
    await act(async () => trigger?.click());

    const nameInput = container.querySelector<HTMLInputElement>('input[aria-label="名称"]');
    expect(nameInput).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(nameInput, 'Renamed');
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => trigger?.click());

    expect(onSaveEdits).toHaveBeenCalledWith(field, 'Renamed', []);
  });

  it('includes a new kanban option when mounted open and saves only on dismissal', async () => {
    const existing = { id: `opt_${'b'.repeat(32)}`, label: 'Open' };
    const pending = { id: `opt_${'c'.repeat(32)}`, label: '选项 1' };
    const selectField: TableField = { ...field, type: 'Select', options: [existing] };
    const onSaveEdits = vi.fn(async () => true);
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root?.render(<HeaderHarness
      field={selectField}
      initialOpen
      pendingOption={pending}
      onSaveEdits={onSaveEdits}
      onSaveAutoCollect={vi.fn(async () => true)}
    />));

    const optionInput = container.querySelector<HTMLInputElement>('input[aria-label="选项 2"]');
    expect(optionInput?.value).toBe('选项 1');
    expect(onSaveEdits).not.toHaveBeenCalled();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(optionInput, '新泳道');
      optionInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="编辑属性 Title"]');
    await act(async () => trigger?.click());
    expect(onSaveEdits).toHaveBeenCalledWith(selectField, 'Title', [existing, { ...pending, label: '新泳道' }]);
  });

  it.each(['Select', 'MultiSelect'] as const)('saves %s option order on drag release without duplicating on dismissal', async (type) => {
    const first = { id: `opt_${'b'.repeat(32)}`, label: 'First' };
    const second = { id: `opt_${'c'.repeat(32)}`, label: 'Second' };
    const selectField: TableField = { ...field, type, options: [first, second] };
    const onSaveEdits = vi.fn(async () => true);
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const pointer = (target: EventTarget, eventType: string, y: number) => {
      const event = new Event(eventType, { bubbles: true });
      Object.defineProperties(event, {
        pointerId: { value: 1 }, button: { value: 0 },
        clientX: { value: 10 }, clientY: { value: y },
      });
      target.dispatchEvent(event);
    };
    try {
      container = document.createElement('div');
      root = createRoot(container);
      await act(async () => root?.render(<HeaderHarness
        field={selectField} initialOpen unmountOnClose onSaveEdits={onSaveEdits}
        onSaveAutoCollect={vi.fn(async () => true)}
      />));
      const row = container.querySelector<HTMLElement>(`[data-field-id="${second.id}"]`)!;
      const list = row.parentElement!;
      list.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 64 }) as DOMRect;
      for (const item of list.querySelectorAll<HTMLElement>('[data-field-id]')) {
        item.getBoundingClientRect = () => ({ top: [...list.children].indexOf(item) * 32, height: 32 }) as DOMRect;
      }
      const handle = row.querySelector<HTMLButtonElement>('button')!;
      expect(handle.getAttribute('aria-label')).toBe('拖动调整选项顺序 Second');
      await act(async () => pointer(handle, 'pointerdown', 48));
      await act(async () => pointer(window, 'pointermove', 4));
      await act(async () => pointer(window, 'pointerup', 4));
      expect([...list.querySelectorAll('input')].map((input) => input.value)).toEqual(['Second', 'First']);
      expect(onSaveEdits).toHaveBeenCalledWith(selectField, 'Title', [second, first]);
      await act(async () => container?.querySelector<HTMLButtonElement>('button[aria-label="编辑属性 Title"]')?.click());
      expect(container.childElementCount).toBe(0);
      expect(onSaveEdits).toHaveBeenCalledTimes(1);
      expect(onSaveEdits).toHaveBeenCalledWith(selectField, 'Title', [second, first]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(['Select', 'MultiSelect'] as const)('saves a renamed %s option on input blur', async (type) => {
    const option = { id: `opt_${'b'.repeat(32)}`, label: 'Before' };
    const selectField: TableField = { ...field, type, options: [option] };
    const onSaveEdits = vi.fn(async () => true);
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root?.render(<HeaderHarness
      field={selectField} initialOpen onSaveEdits={onSaveEdits}
      onSaveAutoCollect={vi.fn(async () => true)}
    />));
    const input = container.querySelector<HTMLInputElement>('input[aria-label="选项 1"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'After');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onSaveEdits).not.toHaveBeenCalled();
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(onSaveEdits).toHaveBeenCalledWith(selectField, 'Title', [{ ...option, label: 'After' }]);
    await act(async () => container?.querySelector<HTMLButtonElement>('button[aria-label="编辑属性 Title"]')?.click());
    expect(onSaveEdits).toHaveBeenCalledTimes(1);
  });

  it('keeps the current options when a type change is rejected', async () => {
    const option = { id: `opt_${'b'.repeat(32)}`, label: 'Open' };
    const selectField: TableField = { ...field, type: 'Select', options: [option] };
    const onSaveEdits = vi.fn(async () => true);
    const onChangeType = vi.fn(async () => false);
    const onSaveAutoCollect = vi.fn(async () => true);
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root?.render(<HeaderHarness
      field={selectField}
      typeChoices={['Number']}
      onSaveEdits={onSaveEdits}
      onChangeType={onChangeType}
      onSaveAutoCollect={onSaveAutoCollect}
    />));

    const trigger = [...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '编辑属性 Title');
    await act(async () => trigger?.click());
    const typeMenuTrigger = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('类型'));
    await act(async () => typeMenuTrigger?.click());
    const numberChoice = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Number'));
    await act(async () => numberChoice?.click());
    await act(async () => trigger?.click());

    expect(onChangeType).toHaveBeenCalledWith(selectField, 'Number', []);
    expect(onSaveEdits).not.toHaveBeenCalled();
  });

  it('saves the automatic-link condition when the primary header closes', async () => {
    const primaryField: TableField = { ...field, type: 'primary', property_key: 'note' };
    const onSaveEdits = vi.fn(async () => true);
    const onSaveAutoCollect = vi.fn(async () => true);
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root?.render(<HeaderHarness
      field={primaryField}
      label="名称"
      conditionOnly
      onSaveEdits={onSaveEdits}
      onSaveAutoCollect={onSaveAutoCollect}
    />));

    const trigger = [...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '管理笔记条件匹配');
    await act(async () => trigger?.click());
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="属性条件 1 字段"]')).not.toBeNull();
    const conditionValue = container.querySelector<HTMLInputElement>('input[aria-label="属性条件 1 匹配值"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(conditionValue, 'release');
      conditionValue?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const saveButton = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('应用'));
    await act(async () => saveButton?.click());

    expect(onSaveAutoCollect).toHaveBeenCalledWith(primaryField, expect.objectContaining({
      property_conditions: [expect.objectContaining({ value: 'release' })],
    }));
    expect(onSaveEdits).not.toHaveBeenCalled();
  });

  it('saves the automatic-link condition from the first column field menu', async () => {
    const primaryField: TableField = { ...field, type: 'primary', property_key: 'note' };
    const onSaveEdits = vi.fn(async () => true);
    const onSaveAutoCollect = vi.fn(async () => true);
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root?.render(<HeaderHarness
      field={primaryField}
      label="名称"
      showAutoCollect
      onSaveEdits={onSaveEdits}
      onSaveAutoCollect={onSaveAutoCollect}
    />));

    const trigger = [...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '编辑属性 名称');
    await act(async () => trigger?.click());
    const datasetButton = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('数据集'));
    await act(async () => datasetButton?.click());
    const conditionValue = container.querySelector<HTMLInputElement>('input[aria-label="属性条件 1 匹配值"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(conditionValue, 'release');
      conditionValue?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const saveButton = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('应用'));
    await act(async () => saveButton?.click());

    expect(onSaveAutoCollect).toHaveBeenCalledWith(primaryField, expect.objectContaining({
      property_conditions: [expect.objectContaining({ value: 'release' })],
    }));
  });
});

describe('dataset panel close', () => {
  it('does not save unchanged conditions after viewing fields or reverting edits', async () => {
    const onSaveAutoCollect = vi.fn(async () => true);
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root?.render(<HeaderHarness
      field={{ ...field, type: 'primary', property_key: 'note' }}
      conditionOnly
      autoCollectConfig={{ condition: { file_condition: { file_type: 'markdown' } } }}
      onSaveEdits={vi.fn(async () => true)}
      onSaveAutoCollect={onSaveAutoCollect}
    />));
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="管理数据集"]');
    await act(async () => trigger?.click());
    await act(async () => trigger?.click());
    expect(onSaveAutoCollect).not.toHaveBeenCalled();

    await act(async () => trigger?.click());
    const input = container.querySelector<HTMLInputElement>('input[aria-label="属性条件 1 匹配值"]');
    expect(input).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    for (const value of ['release', '']) {
      await act(async () => {
        setter?.call(input, value);
        input?.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    await act(async () => trigger?.click());
    expect(onSaveAutoCollect).not.toHaveBeenCalled();

    await act(async () => trigger?.click());
    const changedInput = container.querySelector<HTMLInputElement>('input[aria-label="属性条件 1 匹配值"]');
    await act(async () => {
      setter?.call(changedInput, 'release');
      changedInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => trigger?.click());
    expect(onSaveAutoCollect).toHaveBeenCalledOnce();
  });
});
