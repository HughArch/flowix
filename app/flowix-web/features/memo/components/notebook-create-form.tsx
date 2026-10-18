import { ChevronRight, LoaderCircle } from 'lucide-react';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { NotebookIconPopover } from '@features/memo/components/notebook-icon-popover';
import { NotebookTemplateCardPreview, NotebookTemplateEmptyCard } from '@features/onboarding/notebook-template-picker';
import type { NotebookTemplate } from '@features/onboarding/notebook-templates';

export const NOTEBOOK_CREATE_PAGE_GUTTER_CLASS = 'px-[clamp(38px,6vw,96px)] max-[679px]:px-12';

export interface NotebookCreateFormProps {
  title: string;
  formId: string;
  name: string;
  onNameChange: (name: string) => void;
  nameLabel: string;
  namePlaceholder?: string;
  pathLabel: string;
  path: string;
  pathPlaceholder: string;
  directoryButtonLabel: string;
  onSelectDirectory: () => void;
  icon: string | null;
  onIconChange: (icon: string | null) => void;
  templates: NotebookTemplate[];
  selectedTemplateId: string | null;
  onSelectTemplate: () => void;
  disabled: boolean;
  onSubmit: () => void;
}

export interface NotebookCreateFooterProps {
  formId: string;
  disabled: boolean;
  isBusy: boolean;
  submitLabel?: string;
  busyLabel?: string;
  cancelLabel?: string;
  onCancel?: () => void;
}

export function NotebookCreateFooter({
  formId,
  disabled,
  isBusy,
  submitLabel = '创建并开始使用',
  busyLabel = '正在进入',
  cancelLabel,
  onCancel,
}: NotebookCreateFooterProps) {
  return (
    <div className="sticky bottom-0 z-[2] mx-auto flex min-h-[62px] w-[min(100%,680px)] flex-[0_0_auto] items-center justify-end gap-[18px] border-t border-[var(--onboarding-line)] bg-[var(--frame-bg)] pt-[18px] max-[760px]:min-h-[58px] max-[760px]:pt-[14px]">
      {cancelLabel && onCancel && (
        <button
          type="button"
          onClick={onCancel}
          disabled={isBusy}
          className="inline-flex h-8 min-h-8 items-center justify-center gap-2 rounded-lg border border-[var(--border)] bg-transparent px-[15px] text-xs font-medium text-[var(--onboarding-subtle)] hover:text-[var(--onboarding-ink)] disabled:opacity-50"
        >
          {cancelLabel}
        </button>
      )}
      <button
        type="submit"
        form={formId}
        className="inline-flex min-h-[38px] items-center justify-center gap-1 rounded-[9px] border border-[var(--brand)] bg-[var(--brand)] px-[15px] text-xs font-semibold text-[var(--primary-foreground)] shadow-[0_8px_18px_color-mix(in_oklch,var(--brand)_18%,transparent)] transition-transform hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-[0.46] max-[760px]:flex-1"
        disabled={disabled || isBusy}
        aria-busy={isBusy}
      >
        {isBusy
          ? <><LoaderCircle size={17} className="flowix-spin" aria-hidden="true" /> {busyLabel}</>
          : <>{submitLabel} <ChevronRight size={14} className="-ml-1" aria-hidden="true" /></>}
      </button>
    </div>
  );
}

export function NotebookCreateForm({
  title,
  formId,
  name,
  onNameChange,
  nameLabel,
  namePlaceholder,
  pathLabel,
  path,
  pathPlaceholder,
  directoryButtonLabel,
  onSelectDirectory,
  icon,
  onIconChange,
  templates,
  selectedTemplateId,
  onSelectTemplate,
  disabled,
  onSubmit,
}: NotebookCreateFormProps) {
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId);

  return (
    <div className="w-full">
      <h1 id={`${formId}-title`} className="mb-10 text-4xl font-light leading-tight tracking-[-0.04em] text-[var(--onboarding-ink)] max-[760px]:text-3xl">
        {title}
      </h1>
      <form
        id={formId}
        className="mt-[22px] grid w-[min(100%,680px)] grid-cols-[minmax(0,1fr)_320px] items-start gap-x-[22px] gap-y-4 p-0 max-[760px]:grid-cols-1"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="grid min-w-0 content-start gap-4 pr-[38px] max-[760px]:pr-0">
          <div className="grid min-w-0 gap-1">
            <label className="text-sm font-semibold text-[var(--foreground)]" htmlFor={`${formId}-name`}>{nameLabel}</label>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <Input
                id={`${formId}-name`}
                placeholder={namePlaceholder}
                value={name}
                onChange={(event) => onNameChange(event.target.value)}
                autoFocus
                className="h-10 bg-[var(--card)]"
                disabled={disabled}
              />
              <NotebookIconPopover
                value={icon}
                notebookName={name}
                onChange={onIconChange}
                disabled={disabled}
              />
            </div>
          </div>
          <div className="grid min-w-0 gap-1">
            <label className="text-sm font-semibold text-[var(--foreground)]" htmlFor={`${formId}-path`}>{pathLabel}</label>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <Input
                id={`${formId}-path`}
                value={path}
                placeholder={pathPlaceholder}
                disabled
                readOnly
                className="h-10 min-w-0 bg-[var(--card)]"
              />
              <Button
                type="button"
                variant="outline"
                className="h-10 shrink-0 bg-[var(--card)]"
                onClick={onSelectDirectory}
                disabled={disabled}
              >
                {directoryButtonLabel}
              </Button>
            </div>
          </div>
        </div>
        <div className="grid min-w-0 content-start gap-1">
          <button
            type="button"
            className="flex w-full items-center justify-start gap-0.5 p-0 text-left text-sm font-semibold text-[var(--foreground)] hover:text-[var(--brand)] disabled:cursor-not-allowed disabled:opacity-50"
            aria-haspopup="dialog"
            onClick={onSelectTemplate}
            disabled={disabled}
          >
            <span>选择场景模板（可选）</span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
          {selectedTemplate ? (
            <NotebookTemplateCardPreview
              template={selectedTemplate}
              onSwitch={onSelectTemplate}
              disabled={disabled}
            />
          ) : (
            <NotebookTemplateEmptyCard onClick={onSelectTemplate} disabled={disabled} />
          )}
        </div>
      </form>
    </div>
  );
}
