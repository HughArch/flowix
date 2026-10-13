import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ClipboardEvent as ReactClipboardEvent, KeyboardEvent as ReactKeyboardEvent, CSSProperties } from 'react';
import { CaretRight, CodeIcon, EyeIcon, EyeSlashIcon, PlusIcon } from '@phosphor-icons/react';
import { Check, MousePointerClick } from 'lucide-react';

import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { ADDABLE_TABLE_PROPERTY_KINDS, getPropertyTypeDefinition } from '@/lib/property-types';
import { createPropertyId, createPropertyOptionId } from '@/lib/property-identity';
import { Popover, PopoverContent } from '@shared/ui/popover';
import { useComposingValue } from '@shared/hooks/use-composing-value';
import { useMemoTitleSession, type RenameDocumentTitle } from './memo-title-session';
import { TableFieldEditorForm } from '@features/multidimensional-table/table-field-header';
import type { TableFieldOption, TableFieldType } from '@features/multidimensional-table/model';
import { useSettingsStore } from '@/lib/store/settings-store';
import { windows } from '@platform/tauri/client';
import { readClipboardSnapshot, type ClipboardSnapshot } from '@features/editor/extensions/paste-rules/clipboard';
import { splitClipboardForTitlePaste } from '@features/editor/extensions/paste-rules/title-paste';
import { hasLeadingFrontmatter } from '@features/editor/extensions/paste-rules/markdown';
import { BlockActionMenu } from '@features/editor/components/drag-context-menu/block-action-menu';
import type { BlockMenuAction } from '@features/editor/components/drag-context-menu/block-menu-actions';
import type { DocumentEditorMode } from '@features/document/store/document-editor-view-store';
import { documentPropertyTargetId } from '@features/document/store/document-identity';
import { getAllPresets } from '@features/document/properties/presets';
import { PropertyPresetMenu } from './property-preset-menu';
import { canonicalizePropertyKey } from '@features/properties/property-key';
import { getPropertyPresets, usePropertyPresets } from '@features/properties/public-api';
import { savePropertyPreset, usePropertyPresetStore } from '@features/properties/property-preset-store';
import { SYSTEM_FRONTMATTER_KEYS } from '@features/document/properties/frontmatter-model';

type EditorAddablePropertyType = Exclude<TableFieldType, 'primary' | 'Note'>;

interface MemoTitleEditorProps {
  displayId: string;
  filename: string;
  renameTitle: RenameDocumentTitle;
  editable: boolean;
  autoFocus?: boolean;
  /** Use a DOM selection surface when a host needs to avoid native textarea selection rendering. */
  useDocumentSelection?: boolean;
  /** Rich-text mode may navigate across the boundary while read-only. */
  allowReadOnlyBoundaryNavigation?: boolean;
  /** Whether to render the title's properties affordance. */
  showPropertiesToggle?: boolean;
  onMoveToBody: (request: MemoTitleBodyNavigation) => void;
  onPasteToBody?: (snapshot: ClipboardSnapshot) => void;
  editorMode?: DocumentEditorMode;
  onToggleEditorMode?: () => void;
}

export interface MemoTitleBodyNavigation {
  trailingContent?: string;
  insertEmptyLine: boolean;
}

export interface MemoTitleEditorHandle {
  focusEnd: () => void;
  appendBodyLine: (title: string) => Promise<boolean>;
}

export const MemoTitleEditor = forwardRef<MemoTitleEditorHandle, MemoTitleEditorProps>(function MemoTitleEditor({
  displayId,
  filename,
  renameTitle,
  editable,
  autoFocus = false,
  useDocumentSelection = false,
  allowReadOnlyBoundaryNavigation = false,
  showPropertiesToggle = true,
  onMoveToBody,
  onPasteToBody,
  editorMode = 'rich',
  onToggleEditorMode,
}: MemoTitleEditorProps, ref) {
  const { t } = useI18n();
  const { fields: propertyFields } = usePropertyPresets();
  const propertiesVisible = useSettingsStore((state) => state.propertiesVisible);
  const togglePropertiesVisible = useSettingsStore((state) => state.togglePropertiesVisible);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const documentTitleRef = useRef<HTMLDivElement>(null);
  const propertiesMenuButtonRef = useRef<HTMLButtonElement>(null);
  const propertiesMenuRef = useRef<HTMLDivElement>(null);
  const documentTitleComposingRef = useRef(false);
  const bodyMergeRef = useRef<Promise<boolean> | null>(null);
  const [propertiesMenuOpen, setPropertiesMenuOpen] = useState(false);
  const [propertiesMenuPosition, setPropertiesMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const [propertiesMenuIndex, setPropertiesMenuIndex] = useState(0);
  const [propertiesMenuInputMode, setPropertiesMenuInputMode] = useState<'mouse' | 'keyboard'>('mouse');
  const [propertyPickerOpen, setPropertyPickerOpen] = useState(false);
  const [propertyPickerAnchorRect, setPropertyPickerAnchorRect] = useState<DOMRect | null>(null);
  const [addPropertyOpen, setAddPropertyOpen] = useState(false);
  const [addPropertyAnchorRect, setAddPropertyAnchorRect] = useState<DOMRect | null>(null);
  const [addPropertyName, setAddPropertyName] = useState('');
  const [addPropertyType, setAddPropertyType] = useState<EditorAddablePropertyType>('Text');
  const [addPropertyOptions, setAddPropertyOptions] = useState<TableFieldOption[]>([]);
  const [addPropertyTypeMenuOpen, setAddPropertyTypeMenuOpen] = useState(false);
  /**
   * Canonical keys already present in the document frontmatter. Refreshed each
   * time the menu opens so the picker can show their selected state.
   */
  const [occupiedPropertyKeys, setOccupiedPropertyKeys] = useState<ReadonlySet<string>>(new Set());
  const session = useMemoTitleSession(displayId, filename, renameTitle);
  const documentPropertyPresets = useMemo(() => {
    const presets = getAllPresets(propertyFields, (key) => t(key));
    return {
      system: presets.filter((preset) => preset.source === 'builtin' && preset.key !== 'flowix_favorited'),
      custom: presets.filter((preset) => preset.source === 'custom'),
    };
  }, [propertyFields, t]);
  const { snapshot } = session;
  const titleInput = useComposingValue(
    snapshot.draft,
    (value) => session.setDraft(value.replace(/[\r\n]+/g, ' ')),
  );

  const closePropertiesMenu = useCallback(() => {
    setPropertiesMenuOpen(false);
    setPropertyPickerOpen(false);
    setPropertyPickerAnchorRect(null);
    setAddPropertyOpen(false);
    setAddPropertyAnchorRect(null);
    setAddPropertyTypeMenuOpen(false);
    setPropertiesMenuPosition(null);
    setPropertiesMenuIndex(0);
    setPropertiesMenuInputMode('mouse');
  }, []);

  const openPropertiesMenu = useCallback(() => {
    const button = propertiesMenuButtonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    setPropertiesMenuPosition({
      left: Math.max(8, rect.right + 8),
      top: Math.max(8, rect.top),
    });
    // Ask the editor which keys already exist before rendering the presets.
    // The frontmatter node view answers synchronously by filling this array.
    const keys: string[] = [];
    window.dispatchEvent(new CustomEvent('flowix:query-occupied-property-keys', {
      detail: { propertyTargetId: documentPropertyTargetId(displayId), keys },
    }));
    setOccupiedPropertyKeys(new Set(keys));
    setPropertiesMenuIndex(0);
    setPropertiesMenuInputMode('mouse');
    setPropertiesMenuOpen(true);
  }, [displayId]);

  const openPropertyPicker = useCallback((anchorRect?: DOMRect) => {
    const menuItem = propertiesMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[1];
    const anchor = anchorRect ?? menuItem?.getBoundingClientRect();
    if (!anchor) return;
    setPropertiesMenuIndex(1);
    setPropertyPickerAnchorRect(anchor);
    setPropertyPickerOpen(true);
  }, []);

  const openAddPropertyForm = useCallback((anchorRect?: DOMRect) => {
    const menuItem = propertiesMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[2];
    const anchor = anchorRect ?? menuItem?.getBoundingClientRect();
    if (!anchor) return;
    setPropertiesMenuIndex(2);
    setAddPropertyAnchorRect(anchor);
    setAddPropertyName('');
    setAddPropertyType('Text');
    setAddPropertyOptions([]);
    setAddPropertyTypeMenuOpen(false);
    setAddPropertyOpen(true);
  }, []);

  useEffect(() => {
    const handleOpenPropertyPicker = (event: Event) => {
      const detail = (event as CustomEvent<{ propertyTargetId?: string; anchorRect?: DOMRect }>).detail;
      if (detail?.propertyTargetId !== documentPropertyTargetId(displayId) || !editable) return;
      openPropertyPicker(detail.anchorRect);
    };
    const handleOpenAddProperty = (event: Event) => {
      const detail = (event as CustomEvent<{ propertyTargetId?: string; anchorRect?: DOMRect }>).detail;
      if (detail?.propertyTargetId !== documentPropertyTargetId(displayId) || !editable) return;
      openAddPropertyForm(detail.anchorRect);
    };
    window.addEventListener('flowix:open-property-picker', handleOpenPropertyPicker);
    window.addEventListener('flowix:open-add-property', handleOpenAddProperty);
    return () => {
      window.removeEventListener('flowix:open-property-picker', handleOpenPropertyPicker);
      window.removeEventListener('flowix:open-add-property', handleOpenAddProperty);
    };
  }, [displayId, editable, openAddPropertyForm, openPropertyPicker]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('flowix:property-actions-popup-state', {
      detail: {
        propertyTargetId: documentPropertyTargetId(displayId),
        open: propertyPickerOpen || addPropertyOpen,
      },
    }));
  }, [addPropertyOpen, displayId, propertyPickerOpen]);

  const closePropertyPicker = useCallback((open: boolean) => {
    setPropertyPickerOpen(open);
    if (!open) setPropertyPickerAnchorRect(null);
  }, []);

  const closeAddPropertyForm = useCallback((open: boolean) => {
    // The type selector is the innermost layer. Its Escape closes first while
    // leaving the add-property form available.
    if (!open && addPropertyTypeMenuOpen) {
      setAddPropertyTypeMenuOpen(false);
      return;
    }
    setAddPropertyOpen(open);
    if (!open) {
      setAddPropertyAnchorRect(null);
      setAddPropertyTypeMenuOpen(false);
    }
  }, [addPropertyTypeMenuOpen]);

  const saveNewProperty = useCallback(async () => {
    const key = canonicalizePropertyKey(addPropertyName);
    if (!key) return;
    const normalizedKey = key.toLocaleLowerCase();
    try {
      if (!usePropertyPresetStore.getState().loaded) await usePropertyPresetStore.getState().load();
      if (occupiedPropertyKeys.has(key)
        || getPropertyPresets().some((field) => canonicalizePropertyKey(field.key).toLocaleLowerCase() === normalizedKey)
        || SYSTEM_FRONTMATTER_KEYS.has(normalizedKey)
        || ['flowix_key', 'flowix_property_types', 'flowix_plugin'].includes(normalizedKey)) {
        toast.error(t('document.properties.commonKey.alreadyExists'));
        return;
      }
      const options = addPropertyType === 'Select' || addPropertyType === 'MultiSelect'
        ? addPropertyOptions.reduce<TableFieldOption[]>((result, option) => {
          const label = option.label.trim();
          if (label && !result.some((item) => item.label === label)) result.push({ ...option, label });
          return result;
        }, [])
        : [];
      await savePropertyPreset({
        id: createPropertyId(),
        key,
        type: addPropertyType,
        ...(options.length ? { options: options.map((option) => ({ id: option.id, label: option.label })) } : {}),
        ...(addPropertyType === 'Image' ? { multiple: true } : {}),
      }, null);
      window.dispatchEvent(new CustomEvent('flowix:add-property', {
        detail: { propertyTargetId: documentPropertyTargetId(displayId), presetKey: key },
      }));
      setOccupiedPropertyKeys((current) => new Set(current).add(key));
      closeAddPropertyForm(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('document.properties.add'));
    }
  }, [addPropertyName, addPropertyOptions, addPropertyType, closeAddPropertyForm, displayId, occupiedPropertyKeys, t]);

  const propertyMenuActions = useMemo<BlockMenuAction[]>(() => [
    {
      id: 'toggle-properties',
      group: 'block',
      icon: propertiesVisible ? <EyeSlashIcon size={16} weight="bold" /> : <EyeIcon size={16} weight="bold" />,
      label: t(propertiesVisible ? 'document.properties.hide' : 'document.properties.show'),
      trailingIcon: propertiesVisible ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : undefined,
      onSelect: () => {
        togglePropertiesVisible();
        closePropertiesMenu();
      },
    },
    {
      id: 'select-property',
      group: 'block',
      icon: <MousePointerClick className="h-4 w-4" aria-hidden="true" />,
      label: t('document.properties.picker.triggerLabel'),
      trailingIcon: <CaretRight size={12} weight="bold" aria-hidden="true" className="text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]" />,
      disabled: !editable,
      onSelect: () => {
        openPropertyPicker();
      },
    },
    {
      id: 'add-property',
      group: 'block',
      icon: <PlusIcon size={16} weight="bold" />,
      label: t('document.properties.add'),
      disabled: !editable,
      onSelect: () => {
        openAddPropertyForm();
      },
    },
    ...(onToggleEditorMode ? [{
      id: 'toggle-editor-mode',
      group: 'mode' as const,
      icon: <CodeIcon size={16} weight="bold" />,
      label: t(editorMode === 'source' ? 'document.action.richTextMode' : 'document.action.sourceMode'),
      onSelect: () => {
        onToggleEditorMode();
        closePropertiesMenu();
      },
    }] : []),
  ], [closePropertiesMenu, editable, editorMode, onToggleEditorMode, openAddPropertyForm, openPropertyPicker, propertiesVisible, t, togglePropertiesVisible]);

  const handlePropertiesMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      setPropertiesMenuInputMode('keyboard');
      const direction = event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey) ? -1 : 1;
      setPropertiesMenuIndex((index) => (index + direction + propertyMenuActions.length) % propertyMenuActions.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      const action = propertyMenuActions[propertiesMenuIndex];
      // Disabled rows stay focusable but never activate.
      if (!action?.disabled) action?.onSelect();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePropertiesMenu();
    }
  };

  useEffect(() => {
    if (!propertiesMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (propertiesMenuButtonRef.current?.contains(target)
        || propertiesMenuRef.current?.contains(target)
        || (target instanceof Element && target.closest('.property-preset-menu-content, .memo-title-add-property'))
        || (addPropertyTypeMenuOpen && target instanceof Element && target.closest('[data-flowix-surface="popover"]'))) return;
      closePropertiesMenu();
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      // Let the active child popover consume Escape before closing this menu.
      if (event.key === 'Escape' && !propertyPickerOpen && !addPropertyOpen) closePropertiesMenu();
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [addPropertyOpen, addPropertyTypeMenuOpen, closePropertiesMenu, propertiesMenuOpen, propertyPickerOpen]);

  useEffect(() => {
    if (!propertiesMenuOpen) return;
    const frameId = window.requestAnimationFrame(() => {
      propertiesMenuRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [propertiesMenuOpen]);

  const focusAt = useCallback((position: number) => {
    if (useDocumentSelection) {
      const element = documentTitleRef.current;
      if (!element) return;
      element.focus();
      const textNode = element.firstChild ?? element.appendChild(document.createTextNode(''));
      const caret = Math.max(0, Math.min(position, textNode.textContent?.length ?? 0));
      const selection = window.getSelection();
      if (!selection) return;
      const range = document.createRange();
      range.setStart(textNode, caret);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    const element = textareaRef.current;
    if (!element) return;
    element.focus();
    const caret = Math.max(0, Math.min(position, element.value.length));
    element.setSelectionRange(caret, caret);
  }, [useDocumentSelection]);

  const focusEnd = useCallback(() => {
    focusAt(useDocumentSelection
      ? (documentTitleRef.current?.textContent?.length ?? 0)
      : (textareaRef.current?.value.length ?? 0));
  }, [focusAt, useDocumentSelection]);

  const appendBodyLine = useCallback(async (title: string) => {
    if (bodyMergeRef.current) return bodyMergeRef.current;
    const currentTitle = useDocumentSelection
      ? (documentTitleRef.current?.textContent ?? snapshot.draft)
      : (textareaRef.current?.value ?? snapshot.draft);
    const caretPosition = currentTitle.length;
    session.setDraft(`${currentTitle}${title}`);
    const merge = session.commit({ expectBodyMutation: true }).then((saved) => {
      if (saved) requestAnimationFrame(() => focusAt(caretPosition));
      return saved;
    }).finally(() => {
      if (bodyMergeRef.current === merge) bodyMergeRef.current = null;
    });
    bodyMergeRef.current = merge;
    return merge;
  }, [focusAt, session, snapshot.draft, useDocumentSelection]);

  useImperativeHandle(ref, () => ({
    focusEnd,
    appendBodyLine,
  }), [appendBodyLine, focusEnd]);

  const resizeTextarea = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = '0px';
    element.style.height = `${element.scrollHeight}px`;
  }, []);

  useLayoutEffect(() => {
    if (useDocumentSelection) return;
    resizeTextarea();
  }, [resizeTextarea, titleInput.value, useDocumentSelection]);

  useLayoutEffect(() => {
    if (!useDocumentSelection || documentTitleComposingRef.current) return;
    const element = documentTitleRef.current;
    if (element && element.textContent !== snapshot.draft) {
      element.textContent = snapshot.draft;
    }
  }, [snapshot.draft, useDocumentSelection]);

  useLayoutEffect(() => {
    if (useDocumentSelection) return;
    const element = textareaRef.current;
    const widthRoot = element?.parentElement;
    if (!element || !widthRoot) return;

    let frame: number | null = null;
    const scheduleResize = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        resizeTextarea();
      });
    };

    // A narrower document column can wrap the same title onto additional
    // lines without changing the title draft. Observe the title shell so the
    // textarea is remeasured after the new width has been laid out.
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleResize);
    observer?.observe(widthRoot);
    window.addEventListener('resize', scheduleResize);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', scheduleResize);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [resizeTextarea, useDocumentSelection]);

  useLayoutEffect(() => {
    if (!autoFocus || !editable) return;
    const element = useDocumentSelection ? documentTitleRef.current : textareaRef.current;
    if (!element) return;
    element.focus();
    if (useDocumentSelection) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
    } else {
      (element as HTMLTextAreaElement).select();
    }
  }, [autoFocus, displayId, editable, useDocumentSelection]);

  const getDocumentSelection = useCallback(() => {
    const element = documentTitleRef.current;
    const selection = window.getSelection();
    const value = element?.textContent ?? snapshot.draft;
    if (!element || !selection || selection.rangeCount === 0) {
      return { value, start: value.length, end: value.length };
    }
    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) {
      return { value, start: value.length, end: value.length };
    }
    const beforeStart = range.cloneRange();
    beforeStart.selectNodeContents(element);
    beforeStart.setEnd(range.startContainer, range.startOffset);
    const beforeEnd = range.cloneRange();
    beforeEnd.selectNodeContents(element);
    beforeEnd.setEnd(range.endContainer, range.endOffset);
    return {
      value,
      start: beforeStart.toString().length,
      end: beforeEnd.toString().length,
    };
  }, [snapshot.draft]);

  const getTitleSelection = useCallback(() => {
    if (useDocumentSelection) return getDocumentSelection();

    const element = textareaRef.current;
    const value = element?.value ?? snapshot.draft;
    const start = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? start;
    return { value, start, end };
  }, [getDocumentSelection, snapshot.draft, useDocumentSelection]);

  const handleTitlePaste = useCallback((event: ReactClipboardEvent<HTMLDivElement | HTMLTextAreaElement>) => {
    if (!editable || documentTitleComposingRef.current) return;

    const data = event.clipboardData;
    if (!data) return;
    const snapshot = readClipboardSnapshot(data);
    if (hasLeadingFrontmatter(snapshot.markdown || snapshot.text)) {
      event.preventDefault();
      onPasteToBody?.(snapshot);
      return;
    }
    const split = splitClipboardForTitlePaste(snapshot);
    if (!split) return;

    const selection = getTitleSelection();
    const nextTitle = `${selection.value.slice(0, selection.start)}${split.titleLine}${selection.value.slice(selection.end)}`;

    event.preventDefault();
    session.setDraft(nextTitle);
    requestAnimationFrame(() => focusAt(selection.start + split.titleLine.length));
    if (split.body.text || split.body.html || split.body.files.length > 0) {
      onPasteToBody?.(split.body);
    }
  }, [editable, focusAt, getTitleSelection, onPasteToBody, session]);

  const handleDocumentTitleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (documentTitleComposingRef.current || titleInput.isComposingKeyboardEvent(event.nativeEvent)) return;
    const selection = getDocumentSelection();
    if ((event.key === 'ArrowDown' || event.key === 'ArrowRight')
      && selection.start === selection.value.length
      && selection.end === selection.value.length) {
      if (!editable && !allowReadOnlyBoundaryNavigation) return;
      event.preventDefault();
      if (!editable) {
        onMoveToBody({ insertEmptyLine: false });
        return;
      }
      void session.commit();
      onMoveToBody({ insertEmptyLine: false });
    } else if (!editable) {
      return;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const nextTitle = selection.value.slice(0, selection.start);
      const trailingContent = selection.value.slice(selection.end);
      session.setDraft(nextTitle);
      void session.commit({ expectBodyMutation: true });
      onMoveToBody({
        trailingContent,
        insertEmptyLine: true,
      });
    } else if (event.key === 'Escape') {
      session.cancel();
      event.currentTarget.blur();
    }
  }, [allowReadOnlyBoundaryNavigation, editable, getDocumentSelection, onMoveToBody, session, titleInput]);

  return (
    <div className="memo-title-shell">
      {showPropertiesToggle && (
        <button
          ref={propertiesMenuButtonRef}
          type="button"
          className="memo-title-properties-toggle"
          aria-label={t('document.properties.title')}
          title={t('document.properties.title')}
          aria-haspopup="menu"
          aria-expanded={propertiesMenuOpen}
          data-state={propertiesVisible ? 'visible' : 'hidden'}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (propertiesMenuOpen) closePropertiesMenu();
            else openPropertiesMenu();
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M3 6H21V18H3V6ZM2 4C1.44772 4 1 4.44772 1 5V19C1 19.5523 1 20 2 20H22C22.5523 20 23 19.5523 23 19V5C23 4.44772 23 4 22 4H2ZM13 9H19V11H13V9ZM18 13H13V15H18V13ZM6 13H7V16H9V11H6V13ZM9 8H7V10H9V8Z" />
          </svg>
        </button>
      )}
      {propertiesMenuOpen && typeof document !== 'undefined' && createPortal(
        <BlockActionMenu
          actions={propertyMenuActions}
          selectedIndex={propertiesMenuIndex}
          mouseHoverEnabled={propertiesMenuInputMode === 'mouse'}
          menuRef={(node) => {
            propertiesMenuRef.current = node;
          }}
          style={{
            left: propertiesMenuPosition ? `${propertiesMenuPosition.left}px` : '-9999px',
            top: propertiesMenuPosition ? `${propertiesMenuPosition.top}px` : '-9999px',
            minWidth: 180,
          } satisfies CSSProperties}
          onHover={(index) => {
            setPropertiesMenuInputMode('mouse');
            setPropertiesMenuIndex(index);
          }}
          onKeyDown={handlePropertiesMenuKeyDown}
          ariaLabel={t('document.properties.title')}
          itemHeightClassName="h-8 min-h-8"
        />,
        document.body,
      )}
      <PropertyPresetMenu
        showTrigger={false}
        anchorRect={propertyPickerAnchorRect}
        side="right"
        align="start"
        customGroupLabel={t('preferences.documentProperties.group.mine')}
        customPresets={documentPropertyPresets.custom}
        systemPresets={documentPropertyPresets.system}
        disabled={!editable}
        open={propertyPickerOpen}
        onOpenChange={closePropertyPicker}
        t={t}
        onSelect={(preset) => {
          window.dispatchEvent(new CustomEvent('flowix:add-property', {
            detail: { propertyTargetId: documentPropertyTargetId(displayId), presetKey: preset.key },
          }));
          setOccupiedPropertyKeys((current) => new Set(current).add(canonicalizePropertyKey(preset.key)));
          closePropertyPicker(false);
        }}
        onRemove={(preset) => {
          window.dispatchEvent(new CustomEvent('flowix:remove-property', {
            detail: { propertyTargetId: documentPropertyTargetId(displayId), propertyKey: preset.key },
          }));
          setOccupiedPropertyKeys((current) => {
            const next = new Set(current);
            next.delete(canonicalizePropertyKey(preset.key));
            return next;
          });
          closePropertyPicker(false);
        }}
        isAdded={(preset) => occupiedPropertyKeys.has(canonicalizePropertyKey(preset.key))}
        onManage={() => {
          closePropertyPicker(false);
          closePropertiesMenu();
          void windows.openPreferences('noteSettings');
        }}
      />
      <Popover open={addPropertyOpen} onOpenChange={closeAddPropertyForm} anchorRect={addPropertyAnchorRect}>
        <PopoverContent
          side="right"
          align="start"
          sideOffset={0}
          ignorePopoverOutside={addPropertyTypeMenuOpen}
          style={{ zIndex: 170 }}
          className="memo-title-add-property max-h-[min(70vh,420px)] w-[213px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl p-1.5 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
        >
          <TableFieldEditorForm
            name={addPropertyName}
            onNameChange={setAddPropertyName}
            onNameSubmit={() => { void saveNewProperty(); }}
            type={addPropertyType}
            typeChoices={ADDABLE_TABLE_PROPERTY_KINDS.filter((type): type is EditorAddablePropertyType => type !== 'Note')}
            onTypeChange={(type) => {
              if (type === 'primary') return;
              setAddPropertyType(type);
              setAddPropertyOptions((current) => type === 'Select' || type === 'MultiSelect'
                ? current.length > 0 ? current : [{ id: createPropertyOptionId(), label: '' }]
                : []);
            }}
            typeMenuOpen={addPropertyTypeMenuOpen}
            onTypeMenuOpenChange={setAddPropertyTypeMenuOpen}
            options={addPropertyOptions}
            onOptionsChange={setAddPropertyOptions}
            customPresets={documentPropertyPresets.custom}
            systemPresets={documentPropertyPresets.system}
            presetMenuOpen={false}
            onPresetMenuOpenChange={() => {}}
            showPresetMenu={false}
            disabled={!editable}
            t={t}
            typeLabel={(type) => t(getPropertyTypeDefinition(type === 'primary' ? 'Note' : type).labelKey)}
            typeIconKind={(type) => type === 'primary' ? 'note' : getPropertyTypeDefinition(type).iconKind}
            onSelectPreset={() => {}}
            onManagePresets={() => { void windows.openPreferences('noteSettings'); }}
            afterFooter={<button
              type="button"
              disabled={!editable || !addPropertyName.trim()}
              onClick={() => { void saveNewProperty(); }}
              className="mt-1 flex h-8 w-full items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--muted)] px-2 text-sm text-[var(--foreground)] hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-50"
            >{t('document.properties.addFieldPanel.save')}</button>}
          />
        </PopoverContent>
      </Popover>
      {useDocumentSelection ? (
        <div
          ref={documentTitleRef}
          role="textbox"
          aria-label={t('memo.untitled')}
          aria-multiline="false"
          aria-readonly={!editable}
          tabIndex={editable ? undefined : 0}
          contentEditable={editable ? 'plaintext-only' : false}
          suppressContentEditableWarning
          data-placeholder={t('memo.untitled')}
          className="memo-title-editor memo-title-editor--document-selection"
          onInput={(event) => {
            if (documentTitleComposingRef.current) return;
            session.setDraft((event.currentTarget.textContent ?? '').replace(/[\r\n]+/g, ' '));
          }}
          onCompositionStart={() => {
            documentTitleComposingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            documentTitleComposingRef.current = false;
            session.setDraft((event.currentTarget.textContent ?? '').replace(/[\r\n]+/g, ' '));
          }}
          onBlur={() => void session.commit()}
          onPaste={handleTitlePaste}
          onKeyDown={handleDocumentTitleKeyDown}
        />
      ) : (
      <textarea
        ref={textareaRef}
        rows={1}
        value={titleInput.value}
        readOnly={!editable}
        aria-label={t('memo.untitled')}
        placeholder={t('memo.untitled')}
        className="memo-title-editor"
        onChange={titleInput.onChange}
        onCompositionStart={titleInput.onCompositionStart}
        onCompositionEnd={titleInput.onCompositionEnd}
        onBlur={() => void session.commit()}
        onPaste={handleTitlePaste}
        onKeyDown={(event) => {
          if (titleInput.isComposingKeyboardEvent(event.nativeEvent)) return;
          if (
            (event.key === 'ArrowDown' || event.key === 'ArrowRight')
            && event.currentTarget.selectionStart === event.currentTarget.value.length
            && event.currentTarget.selectionEnd === event.currentTarget.value.length
          ) {
            if (!editable && !allowReadOnlyBoundaryNavigation) return;
            event.preventDefault();
            if (!editable) {
              onMoveToBody({ insertEmptyLine: false });
              return;
            }
            void session.commit();
            onMoveToBody({ insertEmptyLine: false });
          } else if (!editable) {
            return;
          } else if (event.key === 'Enter') {
            event.preventDefault();
            const value = event.currentTarget.value;
            const selectionStart = event.currentTarget.selectionStart ?? snapshot.draft.length;
            const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
            const nextTitle = value.slice(0, selectionStart);
            const trailingContent = value.slice(selectionEnd);
            session.setDraft(nextTitle);
            void session.commit({ expectBodyMutation: true });
            onMoveToBody({
              trailingContent,
              insertEmptyLine: true,
            });
          } else if (event.key === 'Escape') {
            session.cancel();
            event.currentTarget.blur();
          }
        }}
      />
      )}
      {editable && snapshot.recoverableDraft != null && (
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            session.recoverDraft();
            requestAnimationFrame(focusEnd);
          }}
        >
          {t('document.save.recoverTitle')}
        </button>
      )}
    </div>
  );
});
