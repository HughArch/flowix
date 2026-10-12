import { NoteCreatePicker } from './note-create-picker';
import { collectionSessionKey } from '@/lib/collection-session-key';
'use client';

import { mutateCollectionFile } from '@features/collection/mutations';
import { FolderCollectionSwitchConfirmDialog } from '@features/collection/public/folder-api';
import { reviseCollection, type CollectionSource } from '@features/collection/model';
import { collectionFilterUsesField, type CollectionRuleFilter } from '@features/collection/rule-filter';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, LoaderCircle, Plus, Info, Table2 } from 'lucide-react';
import { DotsThreeIcon, EyeIcon, EyeSlashIcon, PencilSimpleIcon, TrashIcon } from '@phosphor-icons/react';
import { notebookAssets, dialogs, files, collections, notes as notesClient, windows, type NoteEntry } from '@platform/tauri/client';
import { canonicalDirectoryPath, canonicalPath, joinNotebookMemoPath, notebookRelativeDirectoryPath, parentDirectoryPath } from '@/lib/path';
import { toast } from '@/lib/toast';
import { canonicalizePropertyKey } from '@features/document/properties/property-key';
import { removeDocumentProperty, setDocumentProperties } from '@features/document/public/path-properties';
import { PROPERTY_URL_RE } from '@features/document/properties/property-type';
import { assetUrl, decodeStorageKey } from '@features/editor/extensions/attachment-link/utils';
import { getAllPresets, resolvePropertyDisplayName, type PropertyPreset } from '@features/document/properties/presets';
import { usePropertyFieldPreferences } from '@features/preferences/public/runtime-api';
import { createFileBrowserTarget, openBrowserColumnTarget } from '@features/workspace/use-cases/browser-column-navigation';
import { replaceExternalDocumentPath } from '@features/workspace/use-cases/workspace-navigation';
import { NotebookTreeResourceIcon } from '@features/memo/components/file-type-icon';
import { renameMarkdownTitle } from '@features/document/use-cases/local-document-operations';
import { ensureFileDisplayIdentity, findFileDisplayIdentity, type FileDisplayIdentity } from '@/lib/file-display-registry';
import { displayTitleFromFilename, tableDocumentExtension } from '@/lib/utils';
import { Button } from '@shared/ui/button';
import { CenteredLoadingSpinner } from '@shared/ui/centered-loading-spinner';
import { useTitleEditCaret } from '@shared/hooks/use-title-edit-caret';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@shared/ui/context-menu';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { ADDABLE_TABLE_PROPERTY_KINDS, getPropertyTypeDefinition, type PropertyKind, type PropertyIconKind } from '@/lib/property-types';
import {
  createUuidV7,
  addKanbanView,
  addTableView,
  findKanbanStatusField,
  type MultidimensionalTableDocument,
  type TableField,
  type TableView,
  type TableRecord,
  type TableFieldType,
  type TableFieldOption,
  type TableAutoCollectCondition,
  type TableAutoCollectConfig,
  tableAutoCollectConfig,
  withTableAutoCollect,
  canEditTableAutoCollectFilter,
} from './model';
import { BUILTIN_TABLE_FIELDS, builtinPresetTableField, builtinTableFieldLabel } from './builtin-fields';
import { groupRecordsByValue, KANBAN_UNASSIGNED_GROUP_ID } from './view-index';
import { noteMatchesCollectionFilter } from './record-filter';
import { applyTableView } from './view-records';
import { asyncMapLimit } from './async-map-limit';
import { TableCalendarView, TableGalleryView, TableKanbanView } from './table-secondary-views';
import { TableSortButton, cycleTableSort, tableSortDirection } from './table-sort-button';
import { TableDatasetMenu } from './table-dataset-menu';
import { sortFields } from './field-order';
import { TableFieldList } from './table-field-list';
import { TableRecordRow } from './table-record-row';
import { NOTE_CALENDAR_DATE_FIELDS, useCalendarController } from './use-calendar-controller';
import type { NoteListItem } from '@/types/note-item';
import { TableFieldEditorForm, TableFieldHeader, TablePresetMenu } from './table-field-header';
import { useTableSession } from './use-table-session';
import { useTableCellWriter, type TableCellSaveStatus } from './use-table-cell-writer';
import { useTableViewSelection } from './use-table-view-selection';
import { removeTableView, resolveTableView } from './view-selection';
import { addPresetField, addTableField, toggleDatasetTableFieldVisibility, changeFieldType as changeFieldTypeInDocument, removeBuiltinField as removeBuiltinTableField, removeField, removePresetField, viewsIncompatibleWithFieldType, viewsRequiringField } from './table-commands';

export interface TableDocumentViewProps {
  filePath: string;
  /** Stable runtime identity for the table file; survives a rename. */
  fileIdentity?: FileDisplayIdentity;
  notebookPath: string | null;
  notebookId: string | null;
  expectedCollectionId?: string | null;
  initialViewId?: string | null;
  onActiveViewChange?: (viewId: string) => void;
  editable?: boolean;
  canCreateFields?: boolean;
  canCreateRecords?: boolean;
  /** Show the explicit “关联笔记” entry independently from generic record creation controls. */
  showAssociateNoteAction?: boolean;
  canDeleteViews?: boolean;
  /** The table is rendered as a node inside the Markdown editor. */
  embeddedInEditor?: boolean;
  /** Removes the reference node when an embedded table cannot be loaded. */
  onRemoveReference?: () => void;
  /** Renders title bar actions and receives the table dataset action. */
  trailingActions?: (datasetAction: ReactNode) => ReactNode;
  /** Called after the table file has been renamed. */
  onFilePathChange?: (filePath: string) => void;
}

const FIELD_TYPE_CHOICES: TableFieldType[] = ADDABLE_TABLE_PROPERTY_KINDS.filter((kind) => kind !== 'Note');
const TABLE_PAGE_SIZE = 10;
const GALLERY_PAGE_SIZE = 14;

function noteInCollectionSource(
  notePath: string,
  source: CollectionSource | undefined,
  collectionFilePath: string,
  notebookPath: string | null,
): boolean {
  if (!notePath) return true;
  if (!source || source.scope === 'notebook') return true;
  let base = source.path ?? '';
  if (source.scope === 'containing_folder') {
    if (!notebookPath) return false;
    const root = canonicalDirectoryPath(notebookPath).replace(/\/$/, '');
    const parent = canonicalDirectoryPath(collectionFilePath.replace(/[\\/][^\\/]*$/, '')).replace(/\/$/, '');
    if (parent === root) base = '';
    else if (parent.startsWith(`${root}/`)) base = parent.slice(root.length + 1);
    else return false;
  }
  const normalized = notePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const prefix = base.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!prefix) return source.depth === 'descendants' || !normalized.includes('/');
  if (!normalized.startsWith(`${prefix}/`)) return false;
  const remainder = normalized.slice(prefix.length + 1);
  return source.depth === 'descendants' || !remainder.includes('/');
}
const TABLE_ACTION_COLUMN_MIN_WIDTH = 120;

/** Resolve the table YAML's folder as the second choice for notes created from its rows. */
function resolveTableNoteParentRelativePath(filePath: string, notebookPath: string | null): string | undefined {
  if (!filePath || !notebookPath) return undefined;
  const notebookRoot = canonicalDirectoryPath(notebookPath);
  const tableDirectory = parentDirectoryPath(filePath, notebookRoot);
  const relativePath = notebookRelativeDirectoryPath(notebookRoot, tableDirectory);
  return relativePath ?? undefined;
}

// Column widths are fixed by type and applied only through the colgroup.
const TABLE_FIELD_WIDTHS: Partial<Record<TableFieldType, number>> = {
  primary: 240,
  Text: 240,
  Number: 120,
  Boolean: 80,
};
const DEFAULT_TABLE_FIELD_WIDTH = 160;
function TableLoadingSkeleton() {
  return <div className="relative h-full min-h-0 overflow-hidden">
    <div className="h-full overflow-hidden p-5" aria-hidden="true">
      <table className="multidimensional-table w-full min-w-[640px] table-fixed border-collapse text-sm">
        <thead><tr>{['w-2/3', 'w-1/2', 'w-3/5', 'w-2/5'].map((width, index) => <th key={index} className="h-10 border-r border-[var(--border)] px-2 text-left">
          <div className={`h-3 animate-pulse rounded bg-[var(--muted)] ${width}`} />
        </th>)}</tr></thead>
        <tbody>{Array.from({ length: 7 }, (_, row) => <tr key={row}>{['w-3/4', 'w-1/2', 'w-2/3', 'w-1/3'].map((width, column) => <td key={column} className="h-10 border-b border-r border-[var(--border)] px-2">
          <div className={`h-3 animate-pulse rounded bg-[var(--muted)] ${width}`} />
        </td>)}</tr>)}</tbody>
      </table>
    </div>
    <CenteredLoadingSpinner className="pointer-events-none absolute inset-0" ariaLabel="正在打开多维表格" />
  </div>;
}

function valueMatchesFieldType(value: unknown, type: TableFieldType, options: TableField['options'] = [], multiple = false): boolean {
  if (value == null || value === '') return true;
  switch (type) {
    case 'primary': case 'Text': case 'Icon': return typeof value === 'string';
    case 'URL': return typeof value === 'string' && PROPERTY_URL_RE.test(value);
    case 'Boolean': return typeof value === 'boolean';
    case 'Number': return typeof value === 'number' && Number.isFinite(value);
    case 'Date': return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
    case 'Select': return typeof value === 'string' && options.some((option) => option.id === value || option.label === value);
    case 'MultiSelect': return Array.isArray(value) && value.every((item) => typeof item === 'string' && options.some((option) => option.id === item || option.label === item));
    case 'Tag': case 'Tags': case 'Color': return Array.isArray(value) && value.every((item) => typeof item === 'string');
    case 'Image': return multiple
      ? Array.isArray(value) && value.every((item) => typeof item === 'string')
      : typeof value === 'string';
  }
  return false;
}

function fieldTypeLabel(type: PropertyKind | 'primary', t: (key: I18nKey) => string): string {
  return t(getPropertyTypeDefinition(type === 'primary' ? 'Note' : type).labelKey);
}

function fieldTypeIconKind(type: TableFieldType): PropertyIconKind {
  return type === 'primary' ? 'note' : getPropertyTypeDefinition(type).iconKind;
}

function fieldLabel(
  field: TableField,
  propertyFields: ReturnType<typeof usePropertyFieldPreferences>['fields'],
  t: (key: I18nKey) => string,
): string {
  if (field.type === 'primary') return '笔记名称';
  return field.name ?? resolvePropertyDisplayName(field.property_key ?? '', propertyFields, t);
}

function imagePaths(value: unknown): string[] {
  if (typeof value === 'string' && value) return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && Boolean(item));
  return [];
}

function noteThumbnailUrl(thumbnail: string | null | undefined): string | null {
  if (!thumbnail) return null;
  const storageKey = decodeStorageKey(thumbnail);
  return storageKey ? assetUrl(storageKey) : thumbnail;
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function calendarDateKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/.exec(value)?.[1] ?? null;
}

function calendarDateTimeForTimestamp(timestamp: number | undefined): string | null {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return `${isoDate(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function noteKeyForRecord(record: TableRecord): string {
  return record.note_path;
}

function upsertTableRecord(records: TableRecord[], nextRecord: TableRecord): TableRecord[] {
  if (!records.some((record) => record.id === nextRecord.id)) return [...records, nextRecord];
  return records.map((record) => record.id === nextRecord.id ? nextRecord : record);
}

function notePropertyEditorValue(note: NoteEntry | undefined, field: TableField): unknown {
  if (field.type === 'primary') return note?.relativePath ?? null;
  const propertyKey = field.property_key ?? '';
  const value = note && Object.prototype.hasOwnProperty.call(note.properties, propertyKey)
    ? note.properties[propertyKey]
    : null;
  if (field.type === 'Select') {
    return field.options?.find((option) => option.label === value)?.id
      ?? field.options?.find((option) => option.id === value)?.id
      ?? '';
  }
  if (field.type === 'MultiSelect' && Array.isArray(value)) {
    return value.map((entry) => field.options?.find((option) => option.label === entry)?.id
      ?? field.options?.find((option) => option.id === entry)?.id
      ?? String(entry));
  }
  return value;
}

const EMPTY_CELL_STATUSES: ReadonlyMap<string, TableCellSaveStatus> = new Map();

export function TableDocumentView(props: TableDocumentViewProps) {
  const sessionKey = collectionSessionKey(props);
  return <TableDocumentViewSession key={sessionKey} {...props} />;
}

function TableDocumentViewSession({ filePath, fileIdentity, notebookPath, notebookId, expectedCollectionId, initialViewId, onActiveViewChange, editable = true, canCreateFields = true, canCreateRecords = true, showAssociateNoteAction = canCreateRecords, canDeleteViews = true, embeddedInEditor = false, onRemoveReference, trailingActions, onFilePathChange }: TableDocumentViewProps) {
  const { t } = useI18n();
  const { fields: propertyFields } = usePropertyFieldPreferences();
  const tablePresets = useMemo(() => {
    const presets = getAllPresets(propertyFields, (key) => t(key));
    return {
      custom: presets.filter((preset) => preset.source === 'custom'),
      system: presets.filter((preset) => preset.source === 'builtin'),
    };
  }, [propertyFields, t]);
  const {
    document, loadError, saving, saveFailed, setSaving, reportSaveFailure, notes, setNotes, resolvedNotebookId,
    notesLoadError, load, acceptContent, save: saveSession, loadSequenceRef, loadGeneration, isCurrentSession, pendingNotePropertiesRef,
  } = useTableSession({ filePath, fileIdentity, notebookPath, notebookId, expectedCollectionId });
  const latestDocumentRef = useRef(document);
  latestDocumentRef.current = document;
  useEffect(() => {
    if (!embeddedInEditor || !expectedCollectionId || !notebookId || !notebookPath || !onFilePathChange) return;
    const pathIsUnusable = Boolean(loadError)
      || Boolean(document && document.collection.id !== expectedCollectionId);
    if (!pathIsUnusable) return;

    let active = true;
    void collections.resolve(notebookId, expectedCollectionId).then((indexedTable) => {
      if (!active) return;
      if (indexedTable.identityConflict || indexedTable.parseState !== 'valid') return;
      const indexedPath = joinNotebookMemoPath(notebookPath, indexedTable.relativePath);
      if (!indexedPath || canonicalPath(indexedPath) === canonicalPath(filePath)) return;
      onFilePathChange(indexedPath);
    }).catch(() => undefined);

    return () => { active = false; };
  }, [document, embeddedInEditor, expectedCollectionId, filePath, loadError, notebookId, notebookPath, onFilePathChange]);
  const save = useCallback(async (...args: Parameters<typeof saveSession>) => {
    if (!editable) return false;
    return saveSession(...args);
  }, [editable, saveSession]);
  const { activeViewId, activeView, activateView, selectView } = useTableViewSelection({
    document, initialViewId, editable, saving, save, onActiveViewChange,
  });
  const [editingViewId, setEditingViewId] = useState<string | null>(null);
  const [editingViewName, setEditingViewName] = useState('');
  const [editingViewWidth, setEditingViewWidth] = useState(48);
  const [managingViewId, setManagingViewId] = useState<string | null>(null);
  const [managingViewName, setManagingViewName] = useState('');
  const manageRenameCancelledRef = useRef(false);
  const [editingTableName, setEditingTableName] = useState(false);
  const [tableNameDraft, setTableNameDraft] = useState('');
  const [renamingTableFile, setRenamingTableFile] = useState(false);
  const { inputRef: tableNameInputRef, captureCaret: captureTableTitleCaret } = useTitleEditCaret(editingTableName);
  const renameTableFile = useCallback(async (rawTitle: string) => {
    setEditingTableName(false);
    const title = rawTitle.trim();
    const currentTitle = document?.collection.name ?? displayTitleFromFilename(filePath);
    if (!editable || saving || renamingTableFile || !notebookPath || !title || title === currentTitle) return;
    if (/[\\/]/.test(title)) {
      toast.error('文件名不能包含路径分隔符');
      return;
    }
    const extension = tableDocumentExtension(filePath);
    if (!extension) {
      toast.error('无法识别多维表格文件后缀');
      return;
    }

    const sequence = loadSequenceRef.current;
    setSaving(true);
    setRenamingTableFile(true);
    const previousPath = canonicalPath(filePath);
    const identity = fileIdentity ?? findFileDisplayIdentity(previousPath) ?? ensureFileDisplayIdentity(previousPath);
    try {
      if (!document || !resolvedNotebookId) throw new Error('集合尚未加载完成');
      const result = await mutateCollectionFile({ notebookId: resolvedNotebookId, notebookPath, collectionId: document.collection.id, expectedRevision: document.collection.revision, newName: title });
      replaceExternalDocumentPath(identity.displayId, previousPath, result.filePath);
      acceptContent(result.content);
      onFilePathChange?.(result.filePath);
      if (result.errorCode) toast.error(`集合已更新，后续操作待恢复：${result.errorCode}`);
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(error instanceof Error ? error.message : '重命名多维表格失败');
    } finally {
      setRenamingTableFile(false);
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [acceptContent, document, editable, fileIdentity, filePath, notebookPath, onFilePathChange, renamingTableFile, resolvedNotebookId, saving, reportSaveFailure, setSaving, isCurrentSession, loadSequenceRef]);
  const editingViewInputRef = useRef<HTMLInputElement | null>(null);
  const editingViewMeasureRef = useRef<HTMLSpanElement | null>(null);
  const [viewAddOpen, setViewAddOpen] = useState(false);
  const [folderMediaSwitchConfirmOpen, setFolderMediaSwitchConfirmOpen] = useState(false);
  const [fieldPanelHeaderId, setFieldPanelHeaderId] = useState<string | null>(null);
  const [pendingKanbanOption, setPendingKanbanOption] = useState<TableFieldOption | null>(null);
  const [matchingOpen, setMatchingOpen] = useState(false);
  const [datasetFilterOpen, setDatasetFilterOpen] = useState(false);
  const [viewAddStep, setViewAddStep] = useState<'kind' | 'field' | 'manage'>('kind');
  const [pendingViewType, setPendingViewType] = useState<'calendar' | 'kanban' | null>(null);
  const [calendarCursor, setCalendarCursor] = useState(() => new Date());
  const [tablePage, setTablePage] = useState(0);
  const [galleryPage, setGalleryPage] = useState(0);
  const [pendingTablePageRecordId, setPendingTablePageRecordId] = useState<string | null>(null);
  const { cellStatusesByRecord, updateCell } = useTableCellWriter({
    enabled: Boolean(document) && !saving && editable,
    loadGeneration,
    notebookPath,
    loadSequenceRef,
    setNotes,
    pendingNotePropertiesRef,
  });
  const [newFieldOpen, setNewFieldOpen] = useState(false);
  const [newFieldAnchorRect, setNewFieldAnchorRect] = useState<DOMRect | null>(null);
  const [newFieldPropertyKey, setNewFieldPropertyKey] = useState('');
  const [newFieldType, setNewFieldType] = useState<TableFieldType>('Text');
  const [newFieldTypeMenuOpen, setNewFieldTypeMenuOpen] = useState(false);
  const [newFieldPresetMenuOpen, setNewFieldPresetMenuOpen] = useState(false);
  const skipNewFieldSaveOnCloseRef = useRef(false);
  const [datasetPresetMenuOpen, setDatasetPresetMenuOpen] = useState(false);
  const [newFieldOptions, setNewFieldOptions] = useState<TableFieldOption[]>([]);
  const [headerMenuFieldId, setHeaderMenuFieldId] = useState<string | null>(null);
  const [rowActionRecordId, setRowActionRecordId] = useState<string | null>(null);
  const [imageUrls, setImageUrls] = useState<Record<string, string | null>>({});
  const [notePickerOpen, setNotePickerOpen] = useState(false);
  const [notePickerAnchorRect, setNotePickerAnchorRect] = useState<DOMRect | null>(null);
  const [notePickerRecordId, setNotePickerRecordId] = useState<string | null>(null);
  const [notePickerCalendarDate, setNotePickerCalendarDate] = useState<{ fieldId: string; date: string } | null>(null);
  const [newNoteTitle, setNewNoteTitle] = useState('');
  const [autoOpenPrimaryRecordId, setAutoOpenPrimaryRecordId] = useState<string | null>(null);
  const conditionRecordIdsRef = useRef(new Map<string, string>());

  useEffect(() => {
    setImageUrls({});
    setTablePage(0);
    setGalleryPage(0);
  }, [loadGeneration]);

  useLayoutEffect(() => {
    if (!editingViewId) return;
    const input = editingViewInputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [editingViewId]);

  useLayoutEffect(() => {
    if (!editingViewId) return;
    const measuredWidth = editingViewMeasureRef.current?.getBoundingClientRect().width;
    if (measuredWidth) setEditingViewWidth(Math.max(40, Math.ceil(measuredWidth + 2)));
  }, [editingViewId, editingViewName, activeViewId]);

  const noteField = document?.dataset.schema.fields[0];
  const noteByKey = useMemo(() => new Map(notes.map((note) => [note.relativePath.replace(/\\/g, '/'), note])), [notes]);
  const calendarController = useCalendarController({ document, activeView, editable, saving, save });
  const {
    dateFieldId: calendarDateFieldId,
    dateMetadata: calendarDateMetadata,
    weekStart: calendarWeekStart,
    isReadOnly: calendarReadOnly,
    updateWeekStart: updateCalendarWeekStart,
    updateDateField: updateCalendarDateField,
    addDialog: calendarAddDialog,
    openAddDialog: openCalendarNotePopover,
    closeAddDialog: closeCalendarAddPopover,
    setAddDialogOpen: setCalendarAddOpen,
    setTitle: setCalendarAddTitle,
  } = calendarController;
  const { open: calendarAddOpen, anchorRect: calendarAddAnchorRect, date: calendarAddDate, title: calendarAddTitle } = calendarAddDialog;
  const calendarDays = useMemo(() => {
    const year = calendarCursor.getFullYear();
    const month = calendarCursor.getMonth();
    const first = new Date(year, month, 1);
    const last = new Date(year, month + 1, 0);
    const startOffset = (first.getDay() - calendarWeekStart + 7) % 7;
    const endOffset = (calendarWeekStart + 6 - last.getDay() + 7) % 7;
    const start = new Date(year, month, 1 - startOffset);
    return Array.from({ length: startOffset + last.getDate() + endOffset }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return { date, iso: isoDate(date), inMonth: date.getMonth() === month };
    });
  }, [calendarCursor, calendarWeekStart]);
  const noteForRecord = useCallback((record: TableRecord) => {
    const key = noteKeyForRecord(record);
    return key ? noteByKey.get(key.replace(/\\/g, '/')) : undefined;
  }, [noteByKey]);
  const noteStatusForRecord = useCallback((record: TableRecord) => {
    const noteKey = noteKeyForRecord(record);
    const note = noteKey ? noteByKey.get(noteKey.replace(/\\/g, '/')) : undefined;
    return !noteKey ? 'draft' as const : note ? 'linked' as const : notesLoadError ? 'unknown' as const : 'missing' as const;
  }, [noteByKey, notesLoadError]);
  const conditionRecords = useMemo(() => {
    if (!document || !noteField) return [];
    const datasetFilter = document.dataset.filter;
    if (datasetFilter == null) return [];

    const linkedPaths = new Set(document.dataset.records.include.map((record) => record.note_path.replace(/\\/g, '/')).filter(Boolean));
    const excludedPaths = new Set([
      ...document.dataset.records.exclude.map((record) => record.note_path),
    ].map((path) => path.replace(/\\/g, '/')));
    return notes.flatMap((note) => {
      const notePath = note.relativePath.replace(/\\/g, '/');
      if (linkedPaths.has(notePath) || excludedPaths.has(notePath)
        || !noteInCollectionSource(notePath, document.dataset.source, filePath, notebookPath)
        || !noteMatchesCollectionFilter(note, document.dataset.schema.fields, noteField.id, datasetFilter)) return [];
      let id = conditionRecordIdsRef.current.get(notePath);
      if (!id) {
        id = `rec_${createUuidV7()}`;
        conditionRecordIdsRef.current.set(notePath, id);
      }
      return [{
        id,
        updated_at: new Date(note.updatedAt).toISOString(),
        note_path: notePath,
      }];
    });
  }, [document, filePath, noteField, notebookPath, notes]);
  const conditionRecordIds = useMemo(() => new Set(conditionRecords.map((record) => record.id)), [conditionRecords]);
  const scopedExplicitRecords = useMemo(() => document
    ? document.dataset.records.include.filter((record) => noteInCollectionSource(record.note_path, document.dataset.source, filePath, notebookPath))
    : [], [document, filePath, notebookPath]);
  const datasetRecords = useMemo(() => [...scopedExplicitRecords, ...conditionRecords], [conditionRecords, scopedExplicitRecords]);
  const visibleRecords = useMemo(() => document
    ? applyTableView(datasetRecords, activeView, document.dataset.schema.fields, document.dataset.schema.primary_field_id, noteForRecord)
    : datasetRecords, [activeView, datasetRecords, document, noteForRecord]);
  useEffect(() => {
    if (activeView?.layout !== 'table') return;
    if (!pendingTablePageRecordId) return;
    const recordIndex = visibleRecords.findIndex((record) => record.id === pendingTablePageRecordId);
    if (recordIndex < 0) return;
    setTablePage(Math.floor(recordIndex / TABLE_PAGE_SIZE));
    setPendingTablePageRecordId(null);
  }, [activeView?.layout, pendingTablePageRecordId, visibleRecords]);
  const secondaryViewRecords = useMemo(() => activeView?.layout === 'table'
    ? visibleRecords
    : visibleRecords.filter((record) => record.note_path.trim().length > 0), [activeView?.layout, visibleRecords]);
  const linkedNoteKeys = useMemo(() => new Set(visibleRecords
    .map((record) => noteKeyForRecord(record))
    .filter((key): key is string => key !== null)), [visibleRecords]);
  const availableNotes = useMemo(() => notes.filter((note) => !linkedNoteKeys.has(note.relativePath.replace(/\\/g, '/'))), [linkedNoteKeys, notes]);
  const availableNotesRef = useRef(availableNotes);
  availableNotesRef.current = availableNotes;
  const getAvailableNotes = useCallback(() => availableNotesRef.current, []);
  const availableNotesListenersRef = useRef(new Set<() => void>());
  const subscribeAvailableNotes = useCallback((listener: () => void) => {
    availableNotesListenersRef.current.add(listener);
    return () => availableNotesListenersRef.current.delete(listener);
  }, []);
  useEffect(() => {
    for (const listener of availableNotesListenersRef.current) listener();
  }, [availableNotes]);
  useEffect(() => {
    setGalleryPage(0);
  }, [activeViewId]);

  const candidateImageReferences = useMemo(() => {
    if (!document) return [];
    const active = resolveTableView(document, activeViewId ?? initialViewId);
    if (active?.layout !== 'table' && active?.layout !== 'gallery') return [];
    const visibleFields = active.config.visible_fields as string[];
    const imageFields = document.dataset.schema.fields.filter((field) => field.type === 'Image'
      && (active.layout === 'table' || visibleFields.includes(field.id)));
    const pageSize = active.layout === 'gallery' ? GALLERY_PAGE_SIZE : TABLE_PAGE_SIZE;
    const selectedPage = active.layout === 'gallery' ? galleryPage : tablePage;
    const currentPage = Math.min(selectedPage, Math.max(0, Math.ceil(secondaryViewRecords.length / pageSize) - 1));
    const viewRecords = secondaryViewRecords.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
    return viewRecords.flatMap((record) => {
      const noteKey = noteKeyForRecord(record);
      const note = noteKey ? noteByKey.get(noteKey) : undefined;
      return imageFields.flatMap((field) =>
        imagePaths(notePropertyEditorValue(note, field)).map((path) => ({ key: `${record.id}:${field.id}:${path}`, path })));
    });
  }, [activeViewId, initialViewId, document, galleryPage, noteByKey, tablePage, secondaryViewRecords]);
  const imageReferencesSignature = candidateImageReferences.map(({ key, path }) => `${key}\u0000${path}`).join('\u0001');
  const stableImageReferencesRef = useRef<{ signature: string; references: typeof candidateImageReferences }>({ signature: '', references: [] });
  if (stableImageReferencesRef.current.signature !== imageReferencesSignature) {
    stableImageReferencesRef.current = { signature: imageReferencesSignature, references: candidateImageReferences };
  }
  const imageReferences = stableImageReferencesRef.current.references;

  useEffect(() => {
    let cancelled = false;
    const next: Record<string, string | null> = {};
    const imagesByPath = new Map<string, Promise<string | null>>();
    void asyncMapLimit(imageReferences, 4, async ({ key, path }) => {
      const absolutePath = notebookPath ? joinNotebookMemoPath(notebookPath, path) : path;
      if (!absolutePath) {
        next[key] = null;
        return;
      }
      let image = imagesByPath.get(absolutePath);
      if (!image) {
        image = files.readImage(absolutePath, notebookPath ?? undefined).catch(() => null);
        imagesByPath.set(absolutePath, image);
      }
      next[key] = await image;
    }).then(() => { if (!cancelled) setImageUrls(next); });
    return () => { cancelled = true; };
  }, [imageReferences, notebookPath]);

  const saveAutoCollectCondition = useCallback(async (field: TableField, condition: TableAutoCollectCondition): Promise<boolean> => {
    if (!document || saving || field.type !== 'primary') return false;
    if (!canEditTableAutoCollectFilter(document)) {
      toast.error('当前数据集包含编辑器不支持的规则，未保存以保留原筛选');
      return false;
    }
    const previous = tableAutoCollectConfig(document);
    const resolveFieldId = (fieldName: string) => {
      const normalizedName = fieldName.trim();
      return document.dataset.schema.fields.find((item) => item.id === normalizedName
        || item.property_key === normalizedName
        || (item.type === 'primary' && ['笔记名称', '名称'].includes(normalizedName))
        || (item.type !== 'primary' && fieldLabel(item, propertyFields, t) === normalizedName))?.id ?? normalizedName;
    };
    const propertyConditions = (condition.property_conditions ?? []).map((item) => ({
      ...item,
      field_id: resolveFieldId(item.field_id),
      value: item.value.trim(),
    })).filter((item) => item.field_id && item.value);
    const fileCondition = Object.fromEntries(Object.entries({
      file_name_contains: condition.file_condition?.file_name_contains?.trim() ?? '',
      file_type: condition.file_condition?.file_type?.trim().replace(/^\./, '') ?? '',
      path_contains: condition.file_condition?.path_contains?.trim() ?? '',
      path_scope: condition.file_condition?.path_scope === 'all' ? 'all' : '',
    }).filter(([, value]) => value)) as TableAutoCollectCondition['file_condition'];
    const hasPropertyCriteria = propertyConditions.length > 0;
    const hasFileCriteria = Object.keys(fileCondition ?? {}).length > 0;
    const nextCondition: TableAutoCollectCondition = {
      ...(hasPropertyCriteria ? {
        property_conditions: propertyConditions,
        property_match: condition.property_match ?? 'union',
      } : {}),
      ...(hasFileCriteria ? { file_condition: fileCondition } : {}),
    };
    const hasActiveCriteria = hasFileCriteria || hasPropertyCriteria;
    if (previous && hasActiveCriteria && JSON.stringify(previous.condition) === JSON.stringify(nextCondition)) return true;
    if (!previous && !hasActiveCriteria && document.dataset.filter == null) return true;
    const nextAutoCollect: TableAutoCollectConfig | null = hasActiveCriteria
      ? {
        condition: nextCondition,
      }
      : null;
    const next = { ...withTableAutoCollect(document, nextAutoCollect), collection: reviseCollection(document.collection) };
    return save(next);
  }, [document, propertyFields, save, saving, t]);

  const saveAutoCollectPath = useCallback(async (path: string | null): Promise<boolean> => {
    if (!document || saving) return false;
    const removePathRules = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.flatMap((item) => {
        const next = removePathRules(item);
        return next === null ? [] : [next];
      });
      if (!value || typeof value !== 'object') return value;
      const rule = value as Record<string, unknown>;
      if (typeof rule.field === 'string') return rule.field === 'path' ? null : rule;
      return Object.fromEntries(Object.entries(rule).map(([key, item]) => [key, removePathRules(item)]));
    };
    const stripped = document.dataset.filter
      ? removePathRules(document.dataset.filter) as Record<string, unknown>
      : { all: [], any: [] };
    const all = Array.isArray(stripped.all) ? [...stripped.all] : [];
    const any = Array.isArray(stripped.any) ? [...stripped.any] : [];
    const normalizedPath = path?.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') ?? '';
    if (path === null) all.push({ field: 'path', op: 'contains', value: '' });
    else if (normalizedPath) all.push({ field: 'path', op: 'contains', value: normalizedPath });
    const filter = all.length || any.length ? { ...stripped, all, any } : null;
    return save({
      ...document,
      collection: reviseCollection(document.collection),
      dataset: { ...document.dataset, filter },
    });
  }, [document, save, saving]);

  const retryNoteLookup = useCallback(() => { void load(); }, [load]);
  const displayFieldValue = (record: TableRecord, field: TableField): string => {
    if (field.type === 'primary') {
      const note = noteForRecord(record);
      if (note) return note.title || displayTitleFromFilename(note.relativePath);
      if (!record.note_path) return '笔记不存在';
      return notesLoadError ? `无法确认关联：${record.note_path}` : `未找到笔记 ${displayTitleFromFilename(record.note_path)}`;
    }
    const value = notePropertyEditorValue(noteForRecord(record), field);
    if (field.type === 'Select') return field.options?.find((option) => option.id === value)?.label
      ?? (value == null || value === '' ? '—' : String(value));
    if (field.type === 'MultiSelect') return Array.isArray(value)
      ? value.map((id) => field.options?.find((option) => option.id === id)?.label ?? id).join(', ')
      : '—';
    if (Array.isArray(value)) return value.map(String).join(', ');
    return value == null || value === '' ? '—' : String(value);
  };

  const openNotePicker = useCallback((anchorRect: DOMRect, recordId: string | null, calendarDate: { fieldId: string; date: string } | null = null) => {
    setNotePickerAnchorRect(anchorRect);
    setNotePickerRecordId(recordId);
    setNotePickerCalendarDate(calendarDate);
    setNewNoteTitle('');
    setNotePickerOpen(true);
  }, []);

  const addDraftRecordAndOpenNoteSelector = useCallback(async () => {
    if (!editable || !document || !noteField || saving) return;
    const sequence = loadSequenceRef.current;
    const record: TableRecord = {
      id: `rec_${createUuidV7()}`,
      updated_at: new Date().toISOString(),
      note_path: '',
    };
    const records = [...document.dataset.records.include, record];
    setSaving(true);
    try {
      const saved = await save({
        ...document,
        collection: reviseCollection(document.collection),
        dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } },
      }, true, sequence);
      if (!saved || !isCurrentSession(sequence)) return;
      setPendingTablePageRecordId(record.id);
      setAutoOpenPrimaryRecordId(record.id);
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(error instanceof Error ? error.message : '新增空行失败');
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [document, editable, isCurrentSession, loadSequenceRef, noteField, save, saving, setSaving, reportSaveFailure]);

  const applyCalendarDateToNote = useCallback(async (note: NoteEntry, calendarDate: { fieldId: string; date: string } | null): Promise<NoteEntry> => {
    if (!calendarDate) return note;
    if (!editable) throw new Error('当前引用为只读，无法修改笔记属性');
    const field = document?.dataset.schema.fields.find((item) => item.id === calendarDate.fieldId);
    if (field?.type !== 'Date' || !field.property_key) return note;
    const path = notebookPath ? joinNotebookMemoPath(notebookPath, note.relativePath) : null;
    if (!path) throw new Error('无法确定笔记路径，未能设置日期');
    if (!await setDocumentProperties(path, { [field.property_key]: calendarDate.date })) {
      throw new Error('笔记日期未能保存');
    }
    return { ...note, updatedAt: Date.now(), properties: { ...note.properties, [field.property_key]: calendarDate.date } };
  }, [document, editable, notebookPath]);

  const createNoteInNotebook = useCallback(async (title?: string) => {
    if (!editable) throw new Error('当前引用为只读，无法新建笔记');
    if (!resolvedNotebookId) throw new Error('无法确定当前笔记本');
    const datasetPath = (document ? tableAutoCollectConfig(document) : null)?.condition.file_condition?.path_contains
      ?.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const parentRelativePath = datasetPath || resolveTableNoteParentRelativePath(filePath, notebookPath);
    return notesClient.create(resolvedNotebookId, undefined, parentRelativePath, title);
  }, [document, editable, filePath, notebookPath, resolvedNotebookId]);

  const createViewForField = useCallback(async (field: TableField | string) => {
    if (!document || !pendingViewType || saving) return;
    const sequence = loadSequenceRef.current;
    const fieldId = typeof field === 'string' ? field : field.id;
    if ((pendingViewType === 'calendar' && typeof field !== 'string' && field.type !== 'Date')
      || (pendingViewType === 'kanban' && (typeof field === 'string' || field.type !== 'Select'))) return;
    const added = addTableView(document, pendingViewType, fieldId);
    if (await save(added.document, false, sequence) && isCurrentSession(sequence)) {
      activateView(added.view.id);
      setViewAddOpen(false);
      setViewAddStep('kind');
      setPendingViewType(null);
    }
  }, [document, isCurrentSession, loadSequenceRef, activateView, pendingViewType, save, saving]);

  const createKanbanViewForStatus = useCallback(async () => {
    if (!document || pendingViewType !== 'kanban' || saving) return;
    const sequence = loadSequenceRef.current;
    try {
      const added = addKanbanView(document);
      if (await save(added.document, false, sequence) && isCurrentSession(sequence)) {
        activateView(added.view.id);
        setViewAddOpen(false);
        setViewAddStep('kind');
        setPendingViewType(null);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建看板失败');
    }
  }, [document, isCurrentSession, loadSequenceRef, activateView, pendingViewType, save, saving]);

  const createGalleryView = useCallback(async () => {
    if (!document || saving) return;
    const sequence = loadSequenceRef.current;
    const added = addTableView(document, 'gallery');
    if (await save(added.document, false, sequence) && isCurrentSession(sequence)) {
      activateView(added.view.id);
      setViewAddOpen(false);
      setViewAddStep('kind');
      setPendingViewType(null);
    }
  }, [document, isCurrentSession, loadSequenceRef, activateView, save, saving]);

  const createDataTableView = useCallback(async () => {
    if (!document || saving) return;
    const sequence = loadSequenceRef.current;
    const added = addTableView(document, 'table');
    if (await save(added.document, false, sequence) && isCurrentSession(sequence)) {
      activateView(added.view.id);
      setViewAddOpen(false);
    }
  }, [document, isCurrentSession, loadSequenceRef, activateView, save, saving]);

  const toggleTableFieldVisibility = useCallback(async (fieldId: string) => {
    if (!editable || !document || saving) return;
    const next = toggleDatasetTableFieldVisibility(document, fieldId);
    if (next !== document) await save(next);
  }, [document, editable, save, saving]);
  const hideTableField = useCallback(async (fieldId: string) => {
    const currentDocument = latestDocumentRef.current;
    if (!editable || !currentDocument || saving) return;
    const next = toggleDatasetTableFieldVisibility(currentDocument, fieldId);
    if (next !== currentDocument) await save(next);
  }, [editable, save, saving]);

  const toggleColumnSort = useCallback(async (fieldId: string) => {
    if (!editable || !document || saving) return;
    const view = document.views.items.find((item) => item.id === activeViewId && item.layout === 'table');
    if (!view) return;
    const next: MultidimensionalTableDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      views: { ...document.views, items: document.views.items.map((item) => item.id === view.id
        ? { ...item, sort: cycleTableSort(item.sort, fieldId) } : item) },
    };
    if (await save(next)) setTablePage(0);
  }, [activeViewId, document, editable, save, saving]);

  const beginRenameView = useCallback((view: TableView) => {
    setEditingViewName(view.name);
    setEditingViewId(view.id);
  }, []);

  const renameView = useCallback(async (view: TableView, rawName: string) => {
    setEditingViewId(null);
    if (!document || saving) return;
    const trimmedName = rawName.trim();
    if (!trimmedName) {
      toast.error(t('multidimensionalTable.view.nameRequired'));
      return;
    }
    if (trimmedName === view.name) return;
    if (document.views.items.some((item) => item.id !== view.id && item.name === trimmedName)) {
      toast.error(t('multidimensionalTable.view.nameExists'));
      return;
    }
    const next: MultidimensionalTableDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      views: { ...document.views, items: document.views.items.map((item) => item.id === view.id ? { ...item, name: trimmedName } : item) },
    };
    await save(next, false, loadSequenceRef.current);
  }, [document, loadSequenceRef, save, saving, t]);

  const manageViewRenameInputRef = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => {
    if (!managingViewId) return;
    manageViewRenameInputRef.current?.focus();
    manageViewRenameInputRef.current?.select();
  }, [managingViewId]);

  const beginManageViewRename = useCallback((view: TableView) => {
    manageRenameCancelledRef.current = false;
    setManagingViewName(view.name);
    setManagingViewId(view.id);
  }, []);

  const finishManageViewRename = useCallback((view: TableView, rawName: string) => {
    setManagingViewId(null);
    void renameView(view, rawName);
  }, [renameView]);

  const deleteView = useCallback(async (view: TableView) => {
    if (!editable || !canDeleteViews || !document || saving || document.views.items.length <= 1) return;
    if (!window.confirm(t('multidimensionalTable.view.deleteConfirm', { name: view.name }))) return;
    const sequence = loadSequenceRef.current;
    const next = removeTableView(document, view.id);
    if (next === document) return;
    if (await save(next, false, sequence) && isCurrentSession(sequence) && activeViewId === view.id) {
      const fallback = resolveTableView(next);
      if (fallback) activateView(fallback.id);
    }
  }, [activeViewId, activateView, canDeleteViews, document, editable, isCurrentSession, loadSequenceRef, save, saving, t]);

  const linkSelectedNote = useCallback(async (selectedNoteKey: string) => {
    if (!editable || !document || document.collection.placement === 'folder' || !noteField || !selectedNoteKey || saving) return;
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      const selectedNote = availableNotesRef.current.find((note) => note.relativePath.replace(/\\/g, '/') === selectedNoteKey);
      const updatedNote = selectedNote ? await applyCalendarDateToNote(selectedNote, notePickerCalendarDate) : null;
      if (!isCurrentSession(sequence)) return;
      if (updatedNote && notePickerCalendarDate) {
        const field = document.dataset.schema.fields.find((item) => item.id === notePickerCalendarDate.fieldId);
        if (field?.type === 'Date' && field.property_key) {
          setNotes((current) => current.map((note) => note.relativePath.replace(/\\/g, '/') === selectedNoteKey ? updatedNote : note));
        }
      }
      const now = new Date().toISOString();
      const targetRecord = notePickerRecordId ? visibleRecords.find((record) => record.id === notePickerRecordId) : undefined;
      const linkedRecord = targetRecord
        ? { ...targetRecord, updated_at: now, note_path: selectedNoteKey }
        : { id: `rec_${createUuidV7()}`, updated_at: now, note_path: selectedNoteKey };
      const records = upsertTableRecord(document.dataset.records.include, linkedRecord);
      const next: MultidimensionalTableDocument = { ...document, collection: reviseCollection(document.collection), dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } } };
      setNotePickerOpen(false);
      setNotePickerRecordId(null);
      setNotePickerCalendarDate(null);
      const saved = await save(next, true, sequence);
      if (saved && isCurrentSession(sequence) && activeView?.layout === 'table' && (!targetRecord || !targetRecord.note_path)) setPendingTablePageRecordId(linkedRecord.id);
      if (!saved && updatedNote && notePickerCalendarDate) toast.error('笔记日期已修改，但表格关联未保存，请重试关联');
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(error instanceof Error ? error.message : '关联笔记失败');
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [activeView?.layout, applyCalendarDateToNote, document, editable, isCurrentSession, loadSequenceRef, noteField, notePickerCalendarDate, notePickerRecordId, save, saving, setNotes, setSaving, visibleRecords, reportSaveFailure]);

  const replaceLinkedNote = useCallback((recordId: string, noteKey: string) => {
    if (!document || document.collection.placement === 'folder' || !noteField || saving) return;
    const now = new Date().toISOString();
    const targetRecord = visibleRecords.find((record) => record.id === recordId);
    if (!targetRecord) return;
    const records = upsertTableRecord(document.dataset.records.include, { ...targetRecord, updated_at: now, note_path: noteKey });
    void save({ ...document, collection: reviseCollection(document.collection), dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } } })
      .then((saved) => {
        if (saved && !targetRecord.note_path) setPendingTablePageRecordId(recordId);
      });
  }, [document, noteField, save, saving, visibleRecords]);

  const createAndLinkRecordNote = useCallback(async (recordId: string, title: string): Promise<boolean> => {
    const noteTitle = title.trim();
    if (!editable || !document || !noteField || !resolvedNotebookId || !noteTitle || saving) return false;
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      const created = await createNoteInNotebook(noteTitle);
      if (!isCurrentSession(sequence)) return false;
      const note = created.entry;
      const noteKey = note.relativePath.replace(/\\/g, '/');
      const now = new Date().toISOString();
      const targetRecord = visibleRecords.find((record) => record.id === recordId);
      if (!targetRecord) return false;
      const records = upsertTableRecord(document.dataset.records.include, { ...targetRecord, updated_at: now, note_path: noteKey });
      setNotes((current) => [...current.filter((item) => item.relativePath.replace(/\\/g, '/') !== noteKey), note]);
      const saved = await save({ ...document, collection: reviseCollection(document.collection), dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } } }, true, sequence);
      if (saved && isCurrentSession(sequence) && !targetRecord.note_path) setPendingTablePageRecordId(recordId);
      return saved && isCurrentSession(sequence);
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(error instanceof Error ? error.message : '新建并关联笔记失败');
      return false;
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [createNoteInNotebook, document, editable, isCurrentSession, loadSequenceRef, noteField, resolvedNotebookId, save, saving, visibleRecords, reportSaveFailure, setSaving]);

  const handleAutoOpenHandled = useCallback(() => setAutoOpenPrimaryRecordId(null), []);

  const createAndLinkNote = useCallback(async () => {
    const title = newNoteTitle.trim();
    if (!editable || !document || !noteField || !resolvedNotebookId || !title || saving) return;
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      const created = await createNoteInNotebook(title);
      if (!isCurrentSession(sequence)) return;
      const note = await applyCalendarDateToNote(created.entry, notePickerCalendarDate);
      const noteKey = note.relativePath.replace(/\\/g, '/');
      const now = new Date().toISOString();
      const targetRecord = notePickerRecordId ? visibleRecords.find((record) => record.id === notePickerRecordId) : undefined;
      const linkedRecord = targetRecord
        ? { ...targetRecord, updated_at: now, note_path: noteKey }
        : { id: `rec_${createUuidV7()}`, updated_at: now, note_path: noteKey };
      const records = upsertTableRecord(document.dataset.records.include, linkedRecord);
      setNotes((current) => [...current.filter((item) => item.relativePath.replace(/\\/g, '/') !== noteKey), note]);
      setNotePickerOpen(false);
      setNotePickerRecordId(null);
      setNotePickerCalendarDate(null);
      setNewNoteTitle('');
      const saved = await save({ ...document, collection: reviseCollection(document.collection), dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } } }, false, sequence);
      if (saved && isCurrentSession(sequence) && activeView?.layout === 'table' && (!targetRecord || !targetRecord.note_path)) setPendingTablePageRecordId(linkedRecord.id);
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(error instanceof Error ? error.message : '新建并关联笔记失败');
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [activeView?.layout, applyCalendarDateToNote, createNoteInNotebook, document, editable, isCurrentSession, loadSequenceRef, newNoteTitle, noteField, notePickerCalendarDate, notePickerRecordId, resolvedNotebookId, save, saving, visibleRecords, reportSaveFailure, setSaving]);

  const persistCalendarNote = useCallback(async (note: NoteEntry, calendarDate: { fieldId: string; date: string }, sequence: number) => {
    if (!editable || !document || !noteField || !isCurrentSession(sequence)) return false;
    const datedNote = await applyCalendarDateToNote(note, calendarDate);
    if (!isCurrentSession(sequence)) return false;
    const noteKey = datedNote.relativePath.replace(/\\/g, '/');
    const now = new Date().toISOString();
    const record: TableRecord = { id: `rec_${createUuidV7()}`, updated_at: now, note_path: noteKey };
    const records = upsertTableRecord(document.dataset.records.include, record);
    setNotes((current) => [...current.filter((item) => item.relativePath.replace(/\\/g, '/') !== noteKey), datedNote]);
    const saved = await save({ ...document, collection: reviseCollection(document.collection), dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } } }, true, sequence);
    if (saved && isCurrentSession(sequence)) {
      closeCalendarAddPopover();
    }
    return saved;
  }, [applyCalendarDateToNote, closeCalendarAddPopover, document, editable, isCurrentSession, noteField, save, setNotes]);

  const createCalendarNote = useCallback(async () => {
    const title = calendarAddTitle.trim();
    if (!editable || !document || !noteField || !resolvedNotebookId || !calendarAddDate || !title || saving) return;
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      const created = await createNoteInNotebook(title);
      if (!isCurrentSession(sequence)) return;
      await persistCalendarNote(created.entry, calendarAddDate, sequence);
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(error instanceof Error ? error.message : '新建并关联笔记失败');
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [calendarAddDate, calendarAddTitle, createNoteInNotebook, document, editable, isCurrentSession, loadSequenceRef, noteField, persistCalendarNote, resolvedNotebookId, saving, setSaving, reportSaveFailure]);

  const linkCalendarNote = useCallback(async (note: NoteEntry) => {
    if (!editable || !document || !noteField || !calendarAddDate || saving) return;
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      await persistCalendarNote(note, calendarAddDate, sequence);
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(error instanceof Error ? error.message : '关联笔记失败');
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [calendarAddDate, document, editable, isCurrentSession, loadSequenceRef, noteField, persistCalendarNote, saving, setSaving, reportSaveFailure]);

  const addField = useCallback((preset?: PropertyPreset) => {
    if (!document || saving) return;
    try {
      if (preset) {
        void save(addPresetField(document, preset));
        return;
      }
      const propertyKey = newFieldPropertyKey.trim();
      if (!propertyKey) return;
      const options = (newFieldType === 'Select' || newFieldType === 'MultiSelect')
        ? newFieldOptions.reduce<TableFieldOption[]>((result, option) => {
          const label = option.label.trim();
          if (label && !result.some((item) => item.label === label)) result.push({ ...option, label });
          return result;
        }, [])
        : [];
      const field: TableField = {
        id: `fld_${createUuidV7()}`,
        type: newFieldType,
        property_key: propertyKey,
        ...(options.length ? { options } : {}),
      };
      void save(addTableField(document, field));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '添加属性失败');
      return;
    }
    setNewFieldOpen(false);
    setNewFieldPropertyKey('');
    setNewFieldOptions([]);
  }, [document, newFieldOptions, newFieldPropertyKey, newFieldType, save, saving]);

  const removePreset = useCallback((preset: PropertyPreset) => {
    if (!document || saving) return;
    try {
      void save(removePresetField(document, preset));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '移除预设属性失败');
    }
  }, [document, save, saving]);

  const deleteBuiltinField = useCallback(async (field: TableField): Promise<boolean> => {
    if (!document || saving) return false;
    try {
      return await save(removeBuiltinTableField(document, field.id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '移除只读属性失败');
      return false;
    }
  }, [document, save, saving]);

  const saveHeaderFieldEdits = useCallback(async (field: TableField, nameDraft: string, optionsDraft: TableFieldOption[]): Promise<boolean> => {
    if (!document || saving || field.type === 'primary') return false;
    field = document.dataset.schema.fields.find((item) => item.id === field.id) ?? field;
    const name = nameDraft.trim();
    const nextOptions = field.type === 'Select' || field.type === 'MultiSelect'
      ? optionsDraft.reduce<TableFieldOption[]>((result, option) => {
        const label = option.label.trim();
        if (label && !result.some((item) => item.label === label)) result.push({ ...option, label });
        return result;
      }, [])
      : undefined;
    const optionsChanged = nextOptions !== undefined
      && JSON.stringify(field.options ?? []) !== JSON.stringify(nextOptions);
    const nameChanged = Boolean(name) && name !== fieldLabel(field, propertyFields, t);
    if (!optionsChanged && !nameChanged) return true;

    let nextField = nameChanged ? { ...field, name } : field;
    if (nextOptions !== undefined) {
      nextField = { ...nextField, options: nextOptions };
      if (nextOptions.length === 0) delete nextField.options;
    }
    const nextDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      dataset: { ...document.dataset, schema: { ...document.dataset.schema, fields: document.dataset.schema.fields.map((item) => item.id === field.id ? nextField : item) } },
    };
    if (!await save(nextDocument)) return false;

    if (nextOptions === undefined || !optionsChanged || !field.property_key) return true;
    const migrated = new Map<string, { value: unknown; remove: boolean }>();
    const oldOptions = field.options ?? [];
    const nextOptionsById = new Map(nextOptions.map((option) => [option.id, option]));
    for (const record of visibleRecords) {
      const note = noteForRecord(record);
      if (!note) continue;
      const noteKey = note.relativePath.replace(/\\/g, '/');
      if (migrated.has(noteKey) || !Object.prototype.hasOwnProperty.call(note.properties, field.property_key)) continue;
      const value = note.properties[field.property_key];
      if (field.type === 'Select' && typeof value === 'string') {
        const oldOption = oldOptions.find((option) => option.label === value || option.id === value);
        if (!oldOption) continue;
        const nextOption = nextOptionsById.get(oldOption.id);
        migrated.set(noteKey, nextOption ? { value: nextOption.label, remove: false } : { value: null, remove: true });
      } else if (field.type === 'MultiSelect' && Array.isArray(value)) {
        const nextValue = value.flatMap((item) => {
          if (typeof item !== 'string') return [];
          const oldOption = oldOptions.find((option) => option.label === item || option.id === item);
          return oldOption ? nextOptionsById.has(oldOption.id) ? [nextOptionsById.get(oldOption.id)!.label] : [] : [];
        });
        if (JSON.stringify(value) !== JSON.stringify(nextValue)) migrated.set(noteKey, { value: nextValue, remove: false });
      }
    }
    if (migrated.size === 0) return true;
    const migrationResults = await Promise.all([...migrated].map(async ([noteKey, update]) => {
      const note = notes.find((item) => item.relativePath.replace(/\\/g, '/') === noteKey);
      const path = note && notebookPath ? joinNotebookMemoPath(notebookPath, note.relativePath) : null;
      if (!path) return { noteKey, update, success: false };
      let success = false;
      try {
        success = update.remove
          ? await removeDocumentProperty(path, field.property_key!)
          : await setDocumentProperties(path, { [field.property_key!]: update.value });
      } catch {
        success = false;
      }
      return { noteKey, update, success };
    }));
    const applied = new Map(migrationResults.filter((result) => result.success).map(({ noteKey, update }) => [noteKey, update]));
    if (applied.size > 0) setNotes((current) => current.map((note) => {
      const update = applied.get(note.relativePath.replace(/\\/g, '/'));
      if (!update) return note;
      const properties = { ...note.properties };
      if (update.remove) delete properties[field.property_key!];
      else properties[field.property_key!] = update.value;
      return { ...note, properties };
    }));
    if (migrationResults.some((result) => !result.success)) toast.error('选项已更新，但部分笔记的选项值未能同步');
    return true;
  }, [document, noteForRecord, notes, notebookPath, propertyFields, save, saving, setNotes, t, visibleRecords]);

  const headerEditsQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const latestHeaderSaverRef = useRef(saveHeaderFieldEdits);
  latestHeaderSaverRef.current = saveHeaderFieldEdits;
  const queueHeaderFieldEdits = useCallback((field: TableField, name: string, options: TableFieldOption[]) => {
    const write = headerEditsQueueRef.current.catch(() => false).then(async () => {
      // Let the previous write publish its document and release the saving state.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return latestHeaderSaverRef.current(field, name, options);
    });
    headerEditsQueueRef.current = write;
    return write;
  }, []);

  const changeFieldType = useCallback(async (field: TableField, type: TableFieldType, optionsOverride?: TableField['options']): Promise<boolean> => {
    if (!document || saving || field.type === 'primary' || type === 'primary' || field.type === type) return false;
    const dependentViews = viewsIncompatibleWithFieldType(document, field.id, type);
    if (dependentViews.length) {
      toast.error(`请先调整依赖此属性的视图：${dependentViews.map((view) => view.name).join('、')}`);
      return false;
    }
    const options = type === 'Select' || type === 'MultiSelect'
      ? optionsOverride?.length
        ? optionsOverride
        : field.options?.length
          ? field.options
        : ['选项 1', '选项 2', '选项 3'].map((label) => ({ id: `opt_${createUuidV7()}`, label }))
      : undefined;
    const multiple = type === 'Image' ? field.type === 'Image' ? Boolean(field.multiple) : true : undefined;
    const incompatibleRecords = visibleRecords.filter((record) => {
      const note = noteForRecord(record);
      const value = note && field.property_key && Object.prototype.hasOwnProperty.call(note.properties, field.property_key)
        ? note.properties[field.property_key] : null;
      return !valueMatchesFieldType(value, type, options, Boolean(multiple));
    });
    if (incompatibleRecords.length) {
      toast.error(`${incompatibleRecords.length} 条记录的现有值与目标类型不兼容，请先修改值`);
      return false;
    }
    return save(changeFieldTypeInDocument(document, field.id, type, options, multiple));
  }, [document, noteForRecord, save, saving, visibleRecords]);

  const applyFieldPreset = useCallback(async (field: TableField, preset: PropertyPreset): Promise<boolean> => {
    if (!document || saving || field.type === 'primary') return false;
    const dependentViews = viewsIncompatibleWithFieldType(document, field.id, preset.kind);
    if (dependentViews.length) {
      toast.error(`请先调整依赖此属性的视图：${dependentViews.map((view) => view.name).join('、')}`);
      return false;
    }
    const propertyKey = preset.key.trim();
    const normalizedKey = canonicalizePropertyKey(propertyKey).toLocaleLowerCase();
    if (!propertyKey || normalizedKey === 'flowix_key' || normalizedKey === 'key'
      || document.dataset.schema.fields.some((item) => item.id !== field.id && item.property_key
        && canonicalizePropertyKey(item.property_key).toLocaleLowerCase() === normalizedKey)) {
      toast.error('属性键已存在或属于保留名称');
      return false;
    }
    const optionLabels = [...new Set((preset.options ?? []).map((label) => label.trim()).filter(Boolean))];
    const options = (preset.kind === 'Select' || preset.kind === 'MultiSelect') && optionLabels.length > 0
      ? optionLabels.map((label) => ({ id: `opt_${createUuidV7()}`, label }))
      : undefined;
    const nextField: TableField = { ...field, property_key: propertyKey, type: preset.kind };
    delete nextField.name;
    if (options) nextField.options = options;
    else delete nextField.options;
    delete nextField.multiple;
    const incompatibleRecords = visibleRecords.filter((record) => {
      const note = noteForRecord(record);
      const value = note && Object.prototype.hasOwnProperty.call(note.properties, propertyKey)
        ? notePropertyEditorValue(note, nextField)
        : null;
      return !valueMatchesFieldType(value, preset.kind, options, false);
    });
    if (incompatibleRecords.length) {
      toast.error(`${incompatibleRecords.length} 条记录的现有值与该属性预设不兼容，请先修改值`);
      return false;
    }
    const next: MultidimensionalTableDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      dataset: { ...document.dataset, schema: { ...document.dataset.schema, fields: document.dataset.schema.fields.map((item) => item.id === field.id ? nextField : item) } },
    };
    return save(next);
  }, [document, noteForRecord, save, saving, visibleRecords]);

  const deleteField = useCallback(async (field: TableField): Promise<boolean> => {
    if (!document || saving || field.type === 'primary' || field.id === document.dataset.schema.primary_field_id) return false;
    const dependentViews = viewsRequiringField(document, field.id);
    if (dependentViews.length) {
      toast.error(`请先调整依赖此属性的视图：${dependentViews.map((view) => view.name).join('、')}`);
      return false;
    }
    if (collectionFilterUsesField(document.dataset.filter as unknown as CollectionRuleFilter | null, field.id)) {
      toast.error('请先调整引用此属性的笔记数据集');
      return false;
    }
    return save(removeField(document, field.id));
  }, [document, save, saving]);

  const deleteRecord = useCallback((recordId: string) => {
    if (!document || saving) return;
    const record = visibleRecords.find((item) => item.id === recordId);
    if (!record) return;
    const primaryField = document.dataset.schema.fields[0];
    const datasetFilter = document.dataset.filter;
    let nextDocument = document;
    const note = record ? noteForRecord(record) : undefined;
    const ruleMatch = primaryField && record && note
      ? datasetFilter !== null && noteMatchesCollectionFilter(note, document.dataset.schema.fields, primaryField.id, datasetFilter)
      : false;
    if (primaryField && record && note && ruleMatch) {
      const notePath = note.relativePath.replace(/\\/g, '/');
      nextDocument = {
        ...document,
        dataset: { ...document.dataset, records: { ...document.dataset.records,
          exclude: document.dataset.records.exclude.some((item) => item.note_path === notePath)
            ? document.dataset.records.exclude
            : [...document.dataset.records.exclude, { note_path: notePath }] } },
      };
    }
    const next = {
      ...nextDocument,
      collection: reviseCollection(nextDocument.collection),
      dataset: { ...nextDocument.dataset, records: { ...nextDocument.dataset.records, include: document.dataset.records.include.filter((item) => item.id !== recordId) } },
    };
    void save(next);
  }, [document, noteForRecord, save, saving, visibleRecords]);

  const updateRecordField = useCallback((recordId: string, fieldId: string, value: unknown) => {
    if (!document) return;
    const record = visibleRecords.find((item) => item.id === recordId);
    const field = document.dataset.schema.fields.find((item) => item.id === fieldId);
    if (record && field) updateCell(record, noteForRecord(record), field, value);
  }, [document, noteForRecord, updateCell, visibleRecords]);

  const selectImageForCell = useCallback(async (record: TableRecord, note: NoteEntry, field: TableField) => {
    if (field.type !== 'Image' || !editable || saving) return;
    if (!notebookPath || !notebookId) {
      toast.error(t('document.properties.imageUploadFailed'));
      return;
    }
    try {
      const selectedPaths = await dialogs.selectFiles({ accept: 'image/*', multiple: false });
      const sourcePath = selectedPaths?.[0];
      if (!sourcePath) return;
      if (!/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|tif|tiff|heic|heif)$/i.test(sourcePath)) {
        toast.error(t('document.properties.imageOnly'));
        return;
      }

      const savedAttachment = await notebookAssets.saveFromPath(sourcePath, { notebookId });
      if (!savedAttachment?.path) throw new Error('Attachment save returned no path');
      const savedPath = savedAttachment.path;
      const root = canonicalDirectoryPath(notebookPath);
      const saved = canonicalPath(savedPath);
      const rootPrefix = `${root}/`;
      if (!saved.startsWith(rootPrefix)) throw new Error('Saved image is outside the notebook');
      const relativePath = saved.slice(rootPrefix.length);
      if (!relativePath.startsWith('attachments/')) throw new Error('Saved image is outside attachments');
      updateCell(record, note, field, relativePath);
    } catch (error) {
      console.error('[MultidimensionalTable] Failed to save image:', error);
      toast.error(t('document.properties.imageUploadFailed'));
    }
  }, [editable, notebookId, notebookPath, saving, t, updateCell]);

  const handleRowActionOpenChange = useCallback((open: boolean, recordId: string) => {
    setRowActionRecordId(open ? recordId : null);
  }, []);
  const handleDeleteRecord = useCallback((recordId: string) => {
    setRowActionRecordId(null);
    deleteRecord(recordId);
  }, [deleteRecord]);

  const renameLinkedNote = useCallback(async (_recordId: string, note: NoteEntry, title: string): Promise<NoteEntry | null> => {
    if (!editable || !notebookPath || saving) return null;
    const sequence = loadSequenceRef.current;
    const oldPath = joinNotebookMemoPath(notebookPath, note.relativePath);
    if (!oldPath) return null;
    const identity = ensureFileDisplayIdentity(oldPath);
    setSaving(true);
    try {
      const renamed = await renameMarkdownTitle({
        path: oldPath,
        title,
        scopePath: notebookPath,
        displayId: identity.displayId,
        onPathChanged: (previousPath, nextPath) => replaceExternalDocumentPath(identity.displayId, previousPath, nextPath),
      });
      if (!renamed) {
        reportSaveFailure(sequence);
        return null;
      }
      if (!renamed.changed) return note;
      const parentPath = note.relativePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      const nextRelativePath = `${parentPath ? `${parentPath}/` : ''}${renamed.filename}`;
      const updatedNote = { ...note, relativePath: nextRelativePath, title: displayTitleFromFilename(nextRelativePath) };
      if (isCurrentSession(sequence)) {
        setNotes((current) => current.map((item) => item.relativePath.replace(/\\/g, '/') === note.relativePath.replace(/\\/g, '/') ? updatedNote : item));
      }
      return updatedNote;
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(error instanceof Error ? error.message : '重命名笔记失败');
      return null;
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [editable, isCurrentSession, loadSequenceRef, notebookPath, saving, setNotes, reportSaveFailure, setSaving]);

  const renameKanbanRecord = useCallback(async (recordId: string, title: string) => {
    const record = visibleRecords.find((item) => item.id === recordId);
    const note = record ? noteForRecord(record) : undefined;
    if (!record || !note) return;
    // The shared rename operation updates table references and emits the collection change event.
    await renameLinkedNote(recordId, note, title);
  }, [noteForRecord, renameLinkedNote, visibleRecords]);

  const openLinkedNote = useCallback((note: NoteEntry) => {
    if (!notebookPath) return;
    const path = joinNotebookMemoPath(notebookPath, note.relativePath);
    if (path) void openBrowserColumnTarget({
      ...createFileBrowserTarget(path, notebookPath),
      notebookId: resolvedNotebookId,
    }, 'open-in-column');
  }, [notebookPath, notebookId, resolvedNotebookId]);
  const openLinkedRecord = useCallback((recordId: string) => {
    const record = visibleRecords.find((item) => item.id === recordId);
    const note = record ? noteForRecord(record) : undefined;
    if (note) openLinkedNote(note);
  }, [noteForRecord, openLinkedNote, visibleRecords]);

  const createBlankGalleryNote = useCallback(async () => {
    if (!editable || !document || !noteField || !resolvedNotebookId || saving) return;
    const nextNoteNumber = datasetRecords.reduce((max, record) => {
      const title = noteForRecord(record)?.title ?? '';
      const match = /^未命名笔记\s+(\d+)$/.exec(title.trim());
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0) + 1;
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      const created = await createNoteInNotebook(`未命名笔记 ${nextNoteNumber}`);
      if (!isCurrentSession(sequence)) return;
      const note = created.entry;
      const noteKey = note.relativePath.replace(/\\/g, '/');
      const record: TableRecord = {
        id: `rec_${createUuidV7()}`,
        updated_at: new Date().toISOString(),
        note_path: noteKey,
      };
      const records = upsertTableRecord(document.dataset.records.include, record);
      setNotes((current) => [...current.filter((item) => item.relativePath.replace(/\\/g, '/') !== noteKey), note]);
      const saved = await save({
        ...document,
        collection: reviseCollection(document.collection),
        dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } },
      }, true, sequence);
      if (saved && isCurrentSession(sequence)) {
        setTablePage(0);
      }
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(error instanceof Error ? error.message : '新建并关联笔记失败');
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [createNoteInNotebook, datasetRecords, document, editable, isCurrentSession, loadSequenceRef, noteField, noteForRecord, reportSaveFailure, resolvedNotebookId, save, saving, setNotes, setSaving]);

  const chooseGalleryData = useCallback(() => {
    setDatasetFilterOpen(false);
    setMatchingOpen(true);
  }, []);

  const requestDeleteLinkedNote = useCallback((note: NoteEntry) => {
    const targetNotebookId = resolvedNotebookId ?? notebookId;
    if (!targetNotebookId) return;
    const filename = note.relativePath.split(/[\\/]/).filter(Boolean).pop() ?? note.relativePath;
    const target: NoteListItem = {
      kind: 'path-note',
      notebookId: targetNotebookId,
      relativePath: note.relativePath,
      filename,
      title: note.title,
      preview: note.preview,
      thumbnail: note.thumbnail,
      tags: note.tags,
      todos: note.todos,
      agents: note.agents,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      favorited: note.favorited,
      icon: note.icon,
      colors: note.colors,
      properties: note.properties,
    };
    window.dispatchEvent(new CustomEvent<NoteListItem>('flowix:request-delete-memo', { detail: target }));
  }, [notebookId, resolvedNotebookId]);

  const groupFieldId = activeView?.layout === 'kanban' && typeof activeView.config.group_by === 'string' ? activeView.config.group_by : null;
  const groupField = groupFieldId ? document?.dataset.schema.fields.find((field) => field.id === groupFieldId) : undefined;
  const calendarField = calendarDateFieldId && !calendarDateMetadata ? document?.dataset.schema.fields.find((field) => field.id === calendarDateFieldId) : undefined;
  const calendarDateFieldOptions = [
    ...NOTE_CALENDAR_DATE_FIELDS.map(({ id, label }) => ({ id, label, readOnly: true })),
    ...(document?.dataset.schema.fields.filter((field) => field.type === 'Date').map((field) => ({ id: field.id, label: fieldLabel(field, propertyFields, t) })) ?? []),
  ];
  const kanbanGroups = useMemo(() => document && groupField?.type === 'Select'
    ? groupRecordsByValue(secondaryViewRecords, (record) => notePropertyEditorValue(noteForRecord(record), groupField))
    : new Map<string, TableRecord[]>(), [document, groupField, noteForRecord, secondaryViewRecords]);
  const kanbanUnassignedRecords = useMemo(() => {
    if (!document || groupField?.type !== 'Select') return [];
    const assignedIds = new Set((groupField.options ?? []).flatMap((option) => kanbanGroups.get(option.id) ?? []).map((record) => record.id));
    return secondaryViewRecords.filter((record) => !assignedIds.has(record.id));
  }, [document, groupField, kanbanGroups, secondaryViewRecords]);
  const addKanbanLane = useCallback(() => {
    if (!editable || saving || groupField?.type !== 'Select') return;
    const existingLabels = new Set((groupField.options ?? []).map((option) => option.label.trim()));
    let number = 1;
    while (existingLabels.has(`选项 ${number}`)) number += 1;
    const option = { id: `opt_${createUuidV7()}`, label: `选项 ${number}` };
    setPendingKanbanOption(option);
    setMatchingOpen(true);
    setFieldPanelHeaderId(groupField.id);
  }, [editable, groupField, saving]);
  const reorderKanbanLane = useCallback(async (sourceOptionId: string, targetOptionId: string, insertAfter: boolean) => {
    if (!document || groupField?.type !== 'Select' || saving || sourceOptionId === targetOptionId) return;
    const options = [...(groupField.options ?? [])];
    const sourceIndex = options.findIndex((option) => option.id === sourceOptionId);
    if (sourceIndex < 0 || !options.some((option) => option.id === targetOptionId)) return;
    const [source] = options.splice(sourceIndex, 1);
    const targetIndex = options.findIndex((option) => option.id === targetOptionId);
    options.splice(targetIndex + (insertAfter ? 1 : 0), 0, source);
    if (options.every((option, index) => option.id === groupField.options?.[index]?.id)) return;
    const updatedField = { ...groupField, options };
    const next: MultidimensionalTableDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      dataset: { ...document.dataset, schema: { ...document.dataset.schema, fields: document.dataset.schema.fields.map((field) => field.id === groupField.id ? updatedField : field) } },
    };
    await save(next);
  }, [document, groupField, save, saving]);
  const addKanbanTask = useCallback(async (targetGroupId: string) => {
    if (!editable || !document || !noteField || !resolvedNotebookId || groupField?.type !== 'Select' || saving) return;
    const targetIsUnassigned = targetGroupId === KANBAN_UNASSIGNED_GROUP_ID;
    const targetOption = groupField.options?.find((option) => option.id === targetGroupId);
    if (!targetIsUnassigned && !targetOption) return;
    if (!targetIsUnassigned && !groupField.property_key) {
      toast.error('状态字段未配置属性键，无法创建任务');
      return;
    }

    const nextTaskNumber = datasetRecords.reduce((max, record) => {
      const title = noteForRecord(record)?.title ?? '';
      const match = /^未命名任务\s+(\d+)$/.exec(title.trim());
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0) + 1;
    const title = `未命名任务 ${nextTaskNumber}`;
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      const created = await createNoteInNotebook(title);
      if (!isCurrentSession(sequence)) return;
      let note = created.entry;
      const noteKey = note.relativePath.replace(/\\/g, '/');
      if (targetOption) {
        const path = notebookPath ? joinNotebookMemoPath(notebookPath, note.relativePath) : null;
        if (!path || !await setDocumentProperties(path, { [groupField.property_key!]: targetOption.label })) {
          throw new Error('任务已创建，但无法设置状态');
        }
        note = { ...note, properties: { ...note.properties, [groupField.property_key!]: targetOption.label } };
      }
      const record: TableRecord = {
        id: `rec_${createUuidV7()}`,
        updated_at: new Date().toISOString(),
        note_path: noteKey,
      };
      const records = upsertTableRecord(document.dataset.records.include, record);
      setNotes((current) => [...current.filter((item) => item.relativePath.replace(/\\/g, '/') !== noteKey), note]);
      await save({
        ...document,
        collection: reviseCollection(document.collection),
        dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } },
      }, true, sequence);
    } catch (error) {
      reportSaveFailure(sequence);
      toast.error(error instanceof Error ? error.message : '新建任务失败');
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [createNoteInNotebook, datasetRecords, document, editable, groupField, isCurrentSession, loadSequenceRef, noteField, noteForRecord, notebookPath, reportSaveFailure, resolvedNotebookId, save, saving, setNotes, setSaving]);
  const dropKanbanRecord = useCallback(async (recordId: string, targetGroupId: string, beforeRecordId: string | null) => {
    if (!editable || !document || groupField?.type !== 'Select' || saving) return;
    const record = visibleRecords.find((item) => item.id === recordId);
    const targetIsUnassigned = targetGroupId === KANBAN_UNASSIGNED_GROUP_ID;
    const targetOption = groupField.options?.find((option) => option.id === targetGroupId);
    if (!record || (!targetIsUnassigned && !targetOption)) return;
    const isPersistedRecord = document.dataset.records.include.some((item) => item.id === recordId);
    const note = noteForRecord(record);
    const sourceGroupId = notePropertyEditorValue(note, groupField);
    const sourceGroupKey = groupField.options?.some((option) => option.id === sourceGroupId)
      ? String(sourceGroupId)
      : KANBAN_UNASSIGNED_GROUP_ID;
    const propertyKey = groupField.property_key;
    const recordNoteKey = record.note_path.replace(/\\/g, '/');
    const path = notebookPath && recordNoteKey ? joinNotebookMemoPath(notebookPath, record.note_path) : null;
    const updateNoteGroupValue = async () => {
      if (!propertyKey || !path) return false;
      return targetIsUnassigned
        ? removeDocumentProperty(path, propertyKey)
        : setDocumentProperties(path, { [propertyKey]: targetOption!.label });
    };
    const updateLocalNoteGroupValue = (noteKey: string) => {
      setNotes((current) => current.map((item) => {
        if (item.relativePath.replace(/\\/g, '/') !== noteKey) return item;
        const properties = { ...item.properties };
        if (targetIsUnassigned) delete properties[propertyKey!];
        else properties[propertyKey!] = targetOption!.label;
        return { ...item, properties };
      }));
    };
    if (!isPersistedRecord) {
      if (sourceGroupKey === targetGroupId) return;
      if (!propertyKey || !path) return;
      const sequence = loadSequenceRef.current;
      setSaving(true);
      try {
        if (!await updateNoteGroupValue()) throw new Error('笔记的单选属性未能保存');
        if (!isCurrentSession(sequence)) return;
        updateLocalNoteGroupValue(recordNoteKey);
      } catch (error) {
        reportSaveFailure(sequence);
        if (isCurrentSession(sequence)) toast.error(error instanceof Error ? error.message : '移动笔记失败');
      } finally {
        if (isCurrentSession(sequence)) setSaving(false);
      }
      return;
    }

    const targetGroup = (targetIsUnassigned ? kanbanUnassignedRecords : kanbanGroups.get(targetGroupId) ?? []).filter((item) => item.id !== recordId);
    const recordsWithoutDragged = document.dataset.records.include.filter((item) => item.id !== recordId);
    let insertAt = beforeRecordId
      ? recordsWithoutDragged.findIndex((item) => item.id === beforeRecordId)
      : -1;
    if (insertAt < 0) {
      const lastTargetRecord = targetGroup[targetGroup.length - 1];
      const lastTargetIndex = lastTargetRecord
        ? recordsWithoutDragged.findIndex((item) => item.id === lastTargetRecord.id)
        : -1;
      insertAt = lastTargetIndex >= 0 ? lastTargetIndex + 1 : recordsWithoutDragged.length;
    }
    const records = [...recordsWithoutDragged.slice(0, insertAt), record, ...recordsWithoutDragged.slice(insertAt)];
    const orderChanged = records.some((item, index) => item.id !== document.dataset.records.include[index]?.id);
    if (!orderChanged && sourceGroupKey === targetGroupId) return;

    if (sourceGroupKey === targetGroupId) {
      await save({ ...document, collection: reviseCollection(document.collection), dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } } });
      return;
    }

    if (!propertyKey || !path) {
      toast.error('无法定位笔记文件，无法更新分组属性');
      return;
    }
    const sequence = loadSequenceRef.current;
    setSaving(true);
    try {
      if (!await updateNoteGroupValue()) {
        throw new Error('笔记的单选属性未能保存');
      }
      if (!isCurrentSession(sequence)) return;
      updateLocalNoteGroupValue(recordNoteKey);
      if (orderChanged) await save({ ...document, collection: reviseCollection(document.collection), dataset: { ...document.dataset, records: { ...document.dataset.records, include: records } } }, true, sequence);
    } catch (error) {
      reportSaveFailure(sequence);
      if (isCurrentSession(sequence)) toast.error(error instanceof Error ? error.message : '移动笔记失败');
    } finally {
      if (isCurrentSession(sequence)) setSaving(false);
    }
  }, [document, editable, groupField, isCurrentSession, kanbanGroups, kanbanUnassignedRecords, loadSequenceRef, noteForRecord, notebookPath, save, saving, setNotes, setSaving, visibleRecords, reportSaveFailure]);
  const calendarGroups = useMemo(() => document && calendarDateFieldId
    ? groupRecordsByValue(secondaryViewRecords, (record) => {
      if (calendarDateMetadata) {
        const note = noteForRecord(record);
        return calendarDateKey(calendarDateTimeForTimestamp(note?.[calendarDateMetadata.timestamp]));
      }
      return calendarField ? calendarDateKey(notePropertyEditorValue(noteForRecord(record), calendarField)) : null;
    })
    : new Map<string, TableRecord[]>(), [calendarDateFieldId, calendarDateMetadata, calendarField, document, noteForRecord, secondaryViewRecords]);
  if (loadError) {
    return <div className={`flex h-full min-h-0 flex-col items-center justify-center gap-3 p-8 text-center ${embeddedInEditor ? 'rounded-lg border border-[var(--border)] bg-[var(--editor-block-bg)]' : ''}`}>
      <Table2 className="h-8 w-8 text-[var(--muted-foreground)] opacity-70" aria-hidden="true" />
      <div className="text-sm">无法显示多维表格</div>
      {loadError !== '不支持的多维表格文件格式' && <div className="max-w-lg text-xs text-[var(--muted-foreground)]">{loadError}</div>}
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" className="rounded-lg" onClick={() => void load()}>重新加载</Button>
        {embeddedInEditor
          ? onRemoveReference && <Button type="button" variant="outline" size="sm" className="rounded-lg" disabled={!editable} onClick={onRemoveReference}>移除</Button>
          : document?.collection.placement !== 'folder' && <Button type="button" variant="outline" size="sm" className="rounded-lg text-[var(--destructive)]" disabled={!editable} onClick={() => window.dispatchEvent(new CustomEvent('flowix:request-delete-external-file', { detail: { filePath, notebookPath } }))}>删除多维表格</Button>}
      </div>
    </div>;
  }
  if (!document) return <TableLoadingSkeleton />;
  if (expectedCollectionId && document.collection.id !== expectedCollectionId) {
    return <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 p-6 text-center">
      <Table2 className="h-7 w-7 text-[var(--muted-foreground)]" aria-hidden="true" />
      <div className="text-sm font-medium">引用的表格身份已变化</div>
      <div className="max-w-lg text-xs text-[var(--muted-foreground)]">当前路径对应的多维表格与引用节点保存的 table.id 不一致，请重新选择表格。</div>
    </div>;
  }

  const titleField = document.dataset.schema.fields.find((field) => field.id === document.dataset.schema.primary_field_id);
  const tableViewFields = activeView?.layout === 'table'
    ? document.dataset.schema.fields.filter((field) => field.id === document.dataset.schema.primary_field_id
      || (activeView.config.visible_fields as string[]).includes(field.id))
    : document.dataset.schema.fields;
  const visibleBuiltinFields = activeView?.layout === 'table'
    ? BUILTIN_TABLE_FIELDS.filter((field) => (activeView.config.visible_fields as string[]).includes(field.id))
    : [];
  const calendarTitleFieldId = activeView?.layout === 'calendar' ? activeView.config.title_field as string : document.dataset.schema.primary_field_id;
  const galleryFields = activeView?.layout === 'gallery'
    ? document.dataset.schema.fields.filter((field) => field.type !== 'primary'
      && (activeView.config.visible_fields as string[]).includes(field.id))
    : [];
  const statusField = findKanbanStatusField(document);
  const viewFieldChoices = pendingViewType === 'calendar'
    ? document.dataset.schema.fields.filter((field) => field.type === 'Date')
    : pendingViewType === 'kanban'
      ? [
        ...(statusField?.type === 'Select' ? [statusField] : []),
        ...document.dataset.schema.fields.filter((field) => field.type === 'Select' && field.id !== statusField?.id),
      ]
      : [];
  const pageCount = Math.max(1, Math.ceil(visibleRecords.length / TABLE_PAGE_SIZE));
  const currentPage = Math.min(tablePage, pageCount - 1);
  const visibleTableRecords = visibleRecords.slice(currentPage * TABLE_PAGE_SIZE, (currentPage + 1) * TABLE_PAGE_SIZE);
  const galleryPageCount = Math.max(1, Math.ceil(secondaryViewRecords.length / GALLERY_PAGE_SIZE));
  const galleryCurrentPage = Math.min(galleryPage, galleryPageCount - 1);
  const visibleGalleryRecords = secondaryViewRecords.slice(galleryCurrentPage * GALLERY_PAGE_SIZE, (galleryCurrentPage + 1) * GALLERY_PAGE_SIZE);
  const showAssociateNoteButton = canCreateRecords || showAssociateNoteAction;
  const tableDisplayName = document.collection.placement === 'folder'
    ? filePath.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '').split(/[\\/]/).pop() || document.collection.name
    : document.collection.name;
  const cellSaveStatuses = [...cellStatusesByRecord.values()].flatMap((statuses) => [...statuses.values()]);
  const isSaving = saving || renamingTableFile || cellSaveStatuses.some((status) => status.saving);
  const saveStatusText = saveFailed || cellSaveStatuses.some((status) => status.error) ? '未保存' : '已保存';
  const datasetTableViews = document.views.items.filter((view) => view.layout === 'table');
  const datasetFieldChecked = (fieldId: string) => datasetTableViews.length > 0
    && datasetTableViews.every((view) => (view.config.visible_fields as string[]).includes(fieldId));
  const datasetFieldMixed = (fieldId: string) => !datasetFieldChecked(fieldId)
    && datasetTableViews.some((view) => (view.config.visible_fields as string[]).includes(fieldId));
  const datasetFieldVisibilityButton = (fieldId: string, label: string, className = '') => {
    const checked = datasetFieldChecked(fieldId);
    const mixed = datasetFieldMixed(fieldId);
    const action = checked ? '隐藏' : '展示';
    const ariaLabel = mixed ? `部分表格视图中展示，点击后全部展示${label}` : `${action}${label}`;
    return <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      aria-pressed={checked ? true : mixed ? 'mixed' : false}
      disabled={!editable || saving || datasetTableViews.length === 0}
      onClick={() => void toggleTableFieldVisibility(fieldId)}
      className={`${className} inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40`}
    >{checked || mixed
      ? <EyeIcon size={16} weight="bold" aria-hidden="true" />
      : <EyeSlashIcon size={16} weight="bold" aria-hidden="true" />}</button>;
  };
  const presetAlreadyAdded = (preset: PropertyPreset) => {
    const propertyKey = canonicalizePropertyKey(preset.key).toLocaleLowerCase();
    if (document.dataset.schema.fields.some((field) => field.property_key
      && canonicalizePropertyKey(field.property_key).toLocaleLowerCase() === propertyKey)) return true;
    const builtin = BUILTIN_TABLE_FIELDS.find((field) => builtinPresetTableField(field.id)?.property_key === propertyKey);
    return Boolean(builtin && document.dataset.schema.preset_fields.includes(builtin.id));
  };
  const datasetMenuProps = {
    defaultFieldId: document.dataset.schema.primary_field_id,
    fields: document.dataset.schema.fields.map((item) => ({ id: item.id, label: fieldLabel(item, propertyFields, t) })),
    config: tableAutoCollectConfig(document),
    notebookPath,
    fixedFolderPath: document.collection.placement === 'folder'
      ? resolveTableNoteParentRelativePath(filePath, notebookPath) ?? ''
      : undefined,
    saving: saving || !editable,
    t,
    onSave: (condition: TableAutoCollectCondition) => saveAutoCollectCondition(document.dataset.schema.fields[0], condition),
    onSavePath: saveAutoCollectPath,
  };
  const openDatasetFieldManager = () => {
    setHeaderMenuFieldId(null);
    setFieldPanelHeaderId(null);
    setDatasetFilterOpen(false);
    setMatchingOpen(true);
  };
  const datasetFieldManagerMenu = () => <button
    type="button"
    onClick={openDatasetFieldManager}
    className="flex h-8 w-full items-center justify-between rounded-lg px-1.5 text-left text-sm hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]"
  >
    <span>字段管理</span>
    <ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" aria-hidden="true" />
  </button>;
  const fieldOrder = document.dataset.schema.field_order;
  const saveFieldOrder = async (ids: string[]) => {
    if (!editable || saving) return;
    await save({ ...document, collection: reviseCollection(document.collection),
      dataset: { ...document.dataset, schema: { ...document.dataset.schema, field_order: ids } } });
  };
  const datasetAction = <div className="flex shrink-0 items-center gap-2">
    <span role="status" aria-label={isSaving ? '保存中' : saveStatusText} className="inline-flex items-center whitespace-nowrap text-xs text-[var(--muted-foreground)]">
      {isSaving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : saveStatusText}
    </span>
    <TableDatasetMenu
      {...datasetMenuProps}
      open={matchingOpen}
      onOpenChange={(open) => {
        setMatchingOpen(open);
        if (!open) setDatasetFilterOpen(false);
      }}
      filterOpen={datasetFilterOpen}
      onFilterOpenChange={setDatasetFilterOpen}
      ignoreOutside={fieldPanelHeaderId !== null || newFieldOpen || datasetPresetMenuOpen}
      children={<div className="w-full min-w-0 max-w-full space-y-0.5 overflow-x-hidden">
        <p className="agent-thread-card__codex-settings-title truncate whitespace-nowrap px-2 py-1.5">展示字段</p>
        <TableFieldList ids={fieldOrder} primaryId={document.dataset.schema.primary_field_id} activeId={fieldPanelHeaderId} disabled={!editable || saving}
          label={(id) => {
            const field = document.dataset.schema.fields.find((item) => item.id === id);
            return field ? fieldLabel(field, propertyFields, t) : BUILTIN_TABLE_FIELDS.find((item) => item.id === id)?.label ?? id;
          }} onReorder={saveFieldOrder} renderField={(id) => {
            const field = document.dataset.schema.fields.find((item) => item.id === id);
            if (field) return <div key={field.id} className="flex h-full w-full min-w-0 items-center gap-2 overflow-hidden px-1.5">
            <div className="min-w-0 flex-1 overflow-hidden">
              <TableFieldHeader
                field={field}
                label={fieldLabel(field, propertyFields, t)}
                compact
                hideTypeIcon
                saving={saving || !editable}
                open={fieldPanelHeaderId === field.id}
                pendingOption={field.id === groupField?.id ? pendingKanbanOption : null}
                focusOptionId={field.id === groupField?.id ? pendingKanbanOption?.id : null}
                onOptionFocusHandled={(optionId) => setPendingKanbanOption((current) => current?.id === optionId ? null : current)}
                typeChoices={FIELD_TYPE_CHOICES}
                customPresets={tablePresets.custom}
                systemPresets={tablePresets.system}
                isPresetAdded={presetAlreadyAdded}
                onRemovePreset={removePreset}
                t={t}
                typeLabel={(type) => fieldTypeLabel(type, t)}
                typeIconKind={fieldTypeIconKind}
                onOpenChange={(open) => setFieldPanelHeaderId(open ? field.id : null)}
                onSaveEdits={queueHeaderFieldEdits}
                onChangeType={changeFieldType}
                onApplyPreset={applyFieldPreset}
                onDelete={deleteField}
                onManagePresets={() => { void windows.openPreferences('noteSettings'); }}
                datasetMenu={field.type === 'primary' ? datasetFieldManagerMenu : undefined}
              />
            </div>
                {field.type !== 'primary' && datasetFieldVisibilityButton(field.id, fieldLabel(field, propertyFields, t), 'ml-auto')}
          </div>;
            const builtin = BUILTIN_TABLE_FIELDS.find((item) => item.id === id);
            if (!builtin) return null;
            const builtinField: TableField = builtinPresetTableField(builtin.id) ?? {
              id: builtin.id,
              type: builtin.iconKind === 'date' ? 'Date' : builtin.iconKind === 'number' ? 'Number' : 'Text',
              property_key: builtin.propertyKey ?? builtin.id,
            };
            return <div key={builtin.id} className="flex h-full w-full min-w-0 items-center gap-2 px-1.5 text-sm">
            <div className="min-w-0 flex-1 overflow-hidden">
              <TableFieldHeader
                field={builtinField}
                label={builtinTableFieldLabel(builtin, t)}
                trailingLabel={builtinPresetTableField(builtin.id) ? '预设' : '只读'}
                compact
                hideTypeIcon
                readOnly
                saving={saving || !editable}
                open={fieldPanelHeaderId === builtin.id}
                typeChoices={FIELD_TYPE_CHOICES}
                customPresets={tablePresets.custom}
                systemPresets={tablePresets.system}
                t={t}
                typeLabel={(type) => fieldTypeLabel(type, t)}
                typeIconKind={fieldTypeIconKind}
                onOpenChange={(open) => setFieldPanelHeaderId(open ? builtin.id : null)}
                onSaveEdits={queueHeaderFieldEdits}
                onChangeType={changeFieldType}
                onApplyPreset={applyFieldPreset}
                onDelete={deleteBuiltinField}
                onManagePresets={() => { void windows.openPreferences('noteSettings'); }}
              />
            </div>
            {datasetFieldVisibilityButton(builtin.id, builtinTableFieldLabel(builtin, t))}
          </div>;
          }} />
        {canCreateFields && <>
          <div role="separator" aria-hidden="true" className="mx-2 h-px bg-[var(--border)]" />
          <TablePresetMenu
            triggerLabel="预设属性"
            triggerIcon={<Info className="h-4 w-4" aria-hidden="true" />}
            triggerPadding="px-1.5"
            customPresets={tablePresets.custom}
            systemPresets={tablePresets.system}
            disabled={!editable || saving}
            open={datasetPresetMenuOpen}
            onOpenChange={setDatasetPresetMenuOpen}
            t={t}
            onSelect={(preset) => { setDatasetPresetMenuOpen(false); addField(preset); }}
            onRemove={removePreset}
            isAdded={presetAlreadyAdded}
            onManage={() => {
              setDatasetPresetMenuOpen(false);
              setMatchingOpen(false);
              void windows.openPreferences('noteSettings');
            }}
          />
          <button type="button" data-state={newFieldOpen ? 'open' : 'closed'} disabled={!editable || saving} className="flex h-8 w-full items-center gap-1.5 rounded-lg px-1.5 text-left text-sm hover:bg-[var(--hover-bg)] data-[state=open]:bg-[var(--hover-bg)] disabled:opacity-50" onClick={(event) => {
            setNewFieldType('Text');
            setNewFieldTypeMenuOpen(false);
            setNewFieldPropertyKey('');
            setNewFieldOptions([]);
            setNewFieldAnchorRect(event.currentTarget.getBoundingClientRect());
            setNewFieldOpen(true);
          }}><Plus className="h-4 w-4" />自定义属性</button>
        </>}
      </div>}
    />
  </div>;
  const beginRenameTableFile = () => {
    if (!editable || document?.collection.placement === 'folder' || saving || renamingTableFile || !notebookPath) return;
    setTableNameDraft(tableDisplayName);
    setEditingTableName(true);
  };
  const tableColumnCount = tableViewFields.length + visibleBuiltinFields.length + 1;
  const tableFieldWidths = tableViewFields.map((field) => ({
    fieldId: field.id,
    width: TABLE_FIELD_WIDTHS[field.type] ?? DEFAULT_TABLE_FIELD_WIDTH,
  }));
  tableFieldWidths.push(...visibleBuiltinFields.map((field) => ({ fieldId: field.id, width: field.width })));
  const orderedTableWidths = sortFields(tableFieldWidths, (field) => field.fieldId, fieldOrder);
  const tableMinWidth = tableFieldWidths.reduce((total, { width }) => total + width, TABLE_ACTION_COLUMN_MIN_WIDTH);
  return <div className="flex h-full min-h-0 flex-col bg-transparent" aria-readonly={!editable}>
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <nav className="multidimensional-table__view-nav sticky top-0 z-10 flex min-w-0 shrink-0 items-center gap-1 px-4 py-1" aria-label="表格视图">
        <div
          className="flex min-w-0 max-w-[40%] shrink-0 -translate-x-[2px] items-center gap-1.5 pr-2"
          title={tableDisplayName}
        >
            <NotebookTreeResourceIcon path={filePath} collectionType="table" className="h-5 w-5 shrink-0" />
            {editingTableName ? <input
              ref={tableNameInputRef}
              aria-label="多维表格文件名"
              value={tableNameDraft}
              disabled={renamingTableFile || saving}
              onChange={(event) => setTableNameDraft(event.currentTarget.value)}
              onBlur={(event) => void renameTableFile(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setEditingTableName(false);
                  setTableNameDraft(tableDisplayName);
                }
              }}
              className="box-border h-[22px] min-w-[2em] max-w-full flex-[0_1_auto] rounded px-0.5 py-1 [field-sizing:content] border-0 bg-[var(--muted)] text-sm font-medium leading-none text-[var(--foreground)] outline-none"
            /> : <button
              type="button"
              onDoubleClick={(event) => { event.preventDefault(); captureTableTitleCaret(event.currentTarget, event.clientX, event.clientY); beginRenameTableFile(); }}
              aria-label={`重命名多维表格：${tableDisplayName}`}
              title={`双击重命名：${tableDisplayName}`}
              disabled={!editable || document.collection.placement === 'folder' || saving || renamingTableFile || !notebookPath}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === 'F2') {
                  event.preventDefault();
                  beginRenameTableFile();
                }
              }}
              className="min-w-[2em] flex-[0_1_auto] truncate rounded px-0.5 py-1 text-left text-sm font-medium leading-none text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] disabled:opacity-100"
            >
              {tableDisplayName}
            </button>}
        </div>
        <span role="separator" aria-orientation="vertical" className="multidimensional-table__view-nav-separator" />
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
          <div className="flex w-max min-w-max shrink-0 items-center gap-1.5 pr-2">
          {document.views.items.map((view) => (
            <ContextMenu key={view.id}>
              {editingViewId === view.id ? (
                <div className="relative inline-flex shrink-0">
                  <input
                    ref={editingViewInputRef}
                    aria-label={t('multidimensionalTable.view.name')}
                    value={editingViewName}
                    disabled={!editable || saving}
                    onChange={(event) => setEditingViewName(event.currentTarget.value)}
                    onBlur={(event) => void renameView(view, event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                    }}
                    style={{ width: `${editingViewWidth}px` }}
                    className={`h-7 shrink-0 whitespace-nowrap rounded-md border border-[var(--primary)] bg-[var(--background)] px-2.5 text-sm text-[var(--foreground)] outline-none ${view.id === activeView?.id ? 'font-medium' : ''}`}
                  />
                  <span ref={editingViewMeasureRef} aria-hidden="true" className={`pointer-events-none invisible absolute left-0 top-0 -z-10 whitespace-pre px-2.5 text-sm ${view.id === activeView?.id ? 'font-medium' : ''}`}>
                    {editingViewName || ' '}
                  </span>
                </div>
              ) : (
                <ContextMenuTrigger asChild>
                  <button type="button" disabled={saving} onClick={() => { void selectView(view.id); }} onDoubleClick={() => beginRenameView(view)} className={`shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-sm disabled:opacity-50 ${view.id === activeView?.id ? 'bg-[var(--muted)] font-medium text-[var(--foreground)]' : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)]/60'}`}>
                    {view.name}
                  </button>
                </ContextMenuTrigger>
              )}
              <ContextMenuContent className="w-[160px] space-y-0.5 rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                <ContextMenuItem disabled={!editable || saving} onSelect={() => beginRenameView(view)}>{t('multidimensionalTable.view.rename')}</ContextMenuItem>
                <ContextMenuItem disabled={!editable || !canDeleteViews || saving || document.views.items.length <= 1} className="text-[var(--destructive)]" onSelect={() => void deleteView(view)}>{t('multidimensionalTable.view.delete')}</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
          <div className="shrink-0">
            <Popover open={viewAddOpen} onOpenChange={(open) => {
              setViewAddOpen(open);
              if (!open) {
                if (managingViewId) {
                  const viewBeingRenamed = document?.views.items.find((view) => view.id === managingViewId);
                  if (viewBeingRenamed) {
                    manageRenameCancelledRef.current = true;
                    void renameView(viewBeingRenamed, managingViewName);
                  }
                } else {
                  manageRenameCancelledRef.current = false;
                }
                setViewAddStep('kind');
                setPendingViewType(null);
                setManagingViewId(null);
                setManagingViewName('');
              }
            }}>
              <PopoverTrigger asChild>
                <button type="button" disabled={!editable || saving} aria-label="更多视图" title="更多视图" className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40">
                  <DotsThreeIcon size={16} weight="bold" aria-hidden="true" />
                </button>
              </PopoverTrigger>
              <PopoverContent key={viewAddStep} align="start" side="bottom" sideOffset={5} fitViewport className={`${viewAddStep === 'manage' ? 'w-[220px]' : 'w-[160px]'} rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]`}>
                {viewAddStep === 'kind' ? <div className="space-y-0.5">
                  <div className="px-2 py-1 text-xs text-[var(--muted-foreground)]">添加笔记视图</div>
                  <button type="button" disabled={saving} onClick={() => void createDataTableView()} className="flex h-8 w-full items-center rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">表格</button>
                  <button type="button" disabled={saving} onClick={() => { setPendingViewType('calendar'); setViewAddStep('field'); }} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                    日历<ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" aria-hidden="true" />
                  </button>
                  <button type="button" disabled={saving} onClick={() => { setPendingViewType('kanban'); setViewAddStep('field'); }} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                    看板<ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" aria-hidden="true" />
                  </button>
                  <button type="button" disabled={saving} onClick={() => void createGalleryView()} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                    画廊
                  </button>
                  {document.collection.placement === 'folder' && <>
                    <div className="px-2 py-1 text-xs text-[var(--muted-foreground)]">添加图/视频视图</div>
                    <button type="button" disabled={saving || !notebookPath || !notebookId} onClick={() => {
                      setViewAddOpen(false);
                      setFolderMediaSwitchConfirmOpen(true);
                    }} className="flex h-8 w-full items-center rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                      媒体库
                    </button>
                  </>}
                  <div role="separator" aria-hidden="true" className="mx-2 my-1 h-px bg-[var(--border)]" />
                  <button type="button" disabled={saving} onClick={() => setViewAddStep('manage')} className="flex h-8 w-full items-center rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                    管理视图
                  </button>
                </div> : viewAddStep === 'manage' ? <div className="space-y-0.5">
                  <div className="px-2 py-1 text-xs text-[var(--muted-foreground)]">管理视图</div>
                  <div className="max-h-[min(60vh,420px)] space-y-0.5 overflow-y-auto">
                    {document.views.items.map((view) => <div key={view.id} className="flex h-8 min-w-0 items-center gap-1 rounded-lg px-1 hover:bg-[var(--hover-bg)]">
                      {managingViewId === view.id ? <input
                        ref={manageViewRenameInputRef}
                        aria-label={`重命名视图：${view.name}`}
                        value={managingViewName}
                        disabled={!editable || saving}
                        onChange={(event) => setManagingViewName(event.currentTarget.value)}
                        onBlur={(event) => {
                          if (manageRenameCancelledRef.current) {
                            manageRenameCancelledRef.current = false;
                            return;
                          }
                          if (managingViewId === view.id) finishManageViewRename(view, event.currentTarget.value);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            event.currentTarget.blur();
                          } else if (event.key === 'Escape') {
                            event.preventDefault();
                            manageRenameCancelledRef.current = true;
                            setManagingViewId(null);
                          }
                        }}
                        className="h-7 min-w-0 flex-1 rounded-md border border-[var(--primary)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)] outline-none"
                      /> : <span className="min-w-0 flex-1 truncate px-1.5 text-sm text-[var(--foreground)]">{view.name}</span>}
                      <button type="button" aria-label={`重命名视图：${view.name}`} title="重命名" disabled={!editable || saving || managingViewId !== null} onClick={() => beginManageViewRename(view)} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40">
                        <PencilSimpleIcon size={15} aria-hidden="true" />
                      </button>
                      <button type="button" aria-label={`删除视图：${view.name}`} title={canDeleteViews ? '删除' : '此处不可删除视图'} disabled={!editable || !canDeleteViews || saving || document.views.items.length <= 1 || managingViewId !== null} onClick={() => void deleteView(view)} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--destructive)] disabled:opacity-40">
                        <TrashIcon size={15} aria-hidden="true" />
                      </button>
                    </div>)}
                  </div>
                </div> : <div className="space-y-0.5">
                  <div className="flex min-w-0 items-center gap-0.5 px-1.5 py-[0.35rem]">
                    <button type="button" aria-label="返回视图类型" className="inline-flex min-h-4 shrink-0 items-center gap-0.5 rounded px-0 text-xs leading-[1.2] text-[var(--muted-foreground)] hover:text-[var(--foreground)] focus-visible:outline-none" onClick={() => { setViewAddStep('kind'); setPendingViewType(null); }}>
                      <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                      <span className="min-w-0 truncate text-xs leading-[1.2] text-[var(--muted-foreground)]">{pendingViewType === 'calendar' ? '选择日期字段' : '选择单选字段'}</span>
                    </button>
                  </div>
                  {pendingViewType === 'kanban' && !statusField && <button type="button" disabled={saving} title="创建状态字段并建立看板视图" onClick={() => void createKanbanViewForStatus()} className="flex h-8 w-full items-center rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                    状态
                  </button>}
                  {pendingViewType === 'kanban' && statusField && statusField.type !== 'Select' && <p className="px-2 py-2 text-xs leading-5 text-[var(--muted-foreground)]">状态字段不是单选类型，请先修改字段类型或选择其他单选属性</p>}
                  {viewFieldChoices.map((field) => <button type="button" key={field.id} disabled={saving} onClick={() => void (field.property_key === 'status' ? createKanbanViewForStatus() : createViewForField(field))} className="flex h-8 w-full items-center rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                    {fieldLabel(field, propertyFields, t)}
                  </button>)}
                  {pendingViewType === 'kanban' && viewFieldChoices.length === 0 && !statusField && <p className="px-2 py-2 text-xs leading-5 text-[var(--muted-foreground)]">可添加单选属性，作为看板分组</p>}
                  {pendingViewType === 'calendar' && NOTE_CALENDAR_DATE_FIELDS.map((field) => <button type="button" key={field.id} disabled={saving} onClick={() => void createViewForField(field.id)} className="flex h-8 w-full items-center rounded-lg px-2 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50">
                    {field.label}
                  </button>)}
                </div>}
              </PopoverContent>
            </Popover>
          </div>
        </div>
        </div>
        {!embeddedInEditor && datasetAction}
        {trailingActions ? trailingActions(datasetAction) : embeddedInEditor ? datasetAction : null}
      </nav>
      <OverlayScrollbar horizontalScrollbar={activeView?.layout === 'table' || activeView?.layout === 'kanban'} className={`multidimensional-table__scrollbar--bottom-clearance min-h-0 ${activeView?.layout === 'table' && !embeddedInEditor ? 'flex flex-col flex-[0_1_auto]' : 'flex-1'}`} scrollerClassName={`min-h-0 flex flex-col ${activeView?.layout === 'table' && !embeddedInEditor ? 'flex-[0_1_auto]' : 'h-full'} ${activeView?.layout === 'kanban' ? 'pr-4' : ''}`} onScroll={() => {
        window.dispatchEvent(new Event('flowix:multidimensional-table-scroll'));
        setHeaderMenuFieldId(null);
        setNewFieldOpen(false);
        setNewFieldAnchorRect(null);
        setNewFieldTypeMenuOpen(false);
        setNewFieldPresetMenuOpen(false);
        setDatasetPresetMenuOpen(false);
        setNotePickerOpen(false);
        setNotePickerAnchorRect(null);
        setNotePickerRecordId(null);
        setNotePickerCalendarDate(null);
        closeCalendarAddPopover();
      }}>
      {activeView?.layout === 'table' && <div className={`min-w-0 w-full ${embeddedInEditor ? 'flex-1' : 'shrink-0'} pr-4 ${embeddedInEditor ? '' : 'pl-4'}`}>
        <table className="multidimensional-table table-fixed border-collapse text-sm" style={{ width: '100%', minWidth: tableMinWidth }}>
          <colgroup>
            {orderedTableWidths.map(({ fieldId, width }) => <col key={fieldId} style={{ width }} />)}
            {/* The unsized action column absorbs remaining space; tableMinWidth reserves the action column’s minimum width. */}
            <col />
          </colgroup>
          <thead className="sticky top-0 z-[1] bg-[var(--document-bg)] text-left text-sm text-[var(--muted-foreground)]">
            <tr>{sortFields([...tableViewFields.map((field) => <th key={field.id} aria-sort={tableSortDirection(activeView.sort, field.id) === 'asc' ? 'ascending' : tableSortDirection(activeView.sort, field.id) === 'desc' ? 'descending' : 'none'} className="group/table-column border-r border-[var(--border)] bg-[var(--document-bg)] p-0 text-left font-normal">
              <div data-state={headerMenuFieldId === field.id ? 'open' : 'closed'} className="multidimensional-table__column-header flex min-w-0 items-center transition-colors hover:bg-[var(--muted)] data-[state=open]:bg-[var(--muted)]">
                <div className="min-w-0 flex-1">
                  <TableFieldHeader
                    field={field}
                    label={fieldLabel(field, propertyFields, t)}
                    saving={saving || !editable}
                    open={headerMenuFieldId === field.id}
                    typeChoices={FIELD_TYPE_CHOICES}
                    customPresets={tablePresets.custom}
                    systemPresets={tablePresets.system}
                    isPresetAdded={presetAlreadyAdded}
                    onRemovePreset={removePreset}
                    t={t}
                    typeLabel={(type) => fieldTypeLabel(type, t)}
                    typeIconKind={fieldTypeIconKind}
                    onOpenChange={(open) => setHeaderMenuFieldId(open ? field.id : null)}
                    onSaveEdits={queueHeaderFieldEdits}
                    onChangeType={changeFieldType}
                    onApplyPreset={applyFieldPreset}
                    onHide={field.type === 'primary' ? undefined : () => hideTableField(field.id)}
                    onDelete={deleteField}
                    onManagePresets={() => { void windows.openPreferences('noteSettings'); }}
                datasetMenu={field.type === 'primary' ? datasetFieldManagerMenu : undefined}
                  />
                </div>
                <TableSortButton label={fieldLabel(field, propertyFields, t)} direction={tableSortDirection(activeView.sort, field.id)} disabled={!editable || saving} onClick={() => void toggleColumnSort(field.id)} />
              </div>
            </th>),
            ...visibleBuiltinFields.map((field) => {
              const builtinSchemaField: TableField = builtinPresetTableField(field.id) ?? {
                id: field.id,
                type: field.iconKind === 'date' ? 'Date' : field.iconKind === 'number' ? 'Number' : 'Text',
                property_key: field.propertyKey ?? field.id,
              };
              return <th key={field.id} aria-sort={tableSortDirection(activeView.sort, field.id) === 'asc' ? 'ascending' : tableSortDirection(activeView.sort, field.id) === 'desc' ? 'descending' : 'none'} className="group/table-column border-r border-[var(--border)] bg-[var(--document-bg)] p-0 text-left font-normal">
              <div data-state={headerMenuFieldId === field.id ? 'open' : 'closed'} className="multidimensional-table__column-header flex min-w-0 items-center transition-colors hover:bg-[var(--muted)] data-[state=open]:bg-[var(--muted)]">
                <div className="min-w-0 flex-1">
                  <TableFieldHeader
                    field={builtinSchemaField}
                    label={builtinTableFieldLabel(field, t)}
                    trailingLabel={builtinPresetTableField(field.id) ? '预设' : '只读'}
                    readOnly
                    saving={saving || !editable}
                    open={headerMenuFieldId === field.id}
                    typeChoices={FIELD_TYPE_CHOICES}
                    customPresets={tablePresets.custom}
                    systemPresets={tablePresets.system}
                    t={t}
                    typeLabel={(type) => fieldTypeLabel(type, t)}
                    typeIconKind={fieldTypeIconKind}
                    onOpenChange={(open) => setHeaderMenuFieldId(open ? field.id : null)}
                    onSaveEdits={queueHeaderFieldEdits}
                    onChangeType={changeFieldType}
                    onApplyPreset={applyFieldPreset}
                    onHide={() => hideTableField(field.id)}
                    onDelete={deleteBuiltinField}
                    onManagePresets={() => { void windows.openPreferences('noteSettings'); }}
                  />
                </div>
                <TableSortButton label={builtinTableFieldLabel(field, t)} direction={tableSortDirection(activeView.sort, field.id)} disabled={!editable || saving} onClick={() => void toggleColumnSort(field.id)} />
              </div>
            </th>;
            })], (cell) => String(cell.key), fieldOrder)}
            <th className="multidimensional-table__column-action-header border-r border-[var(--border)] bg-[var(--document-bg)] px-2 text-left" aria-label="表格操作">
              {canCreateFields && <button
                type="button"
                disabled={saving}
                aria-label="添加属性"
                title="添加属性"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40"
                onClick={(event) => {
                  setNewFieldType('Text');
                  setNewFieldTypeMenuOpen(false);
                  setNewFieldPresetMenuOpen(false);
                  setDatasetPresetMenuOpen(false);
                  setNewFieldPropertyKey('');
                  setNewFieldOptions([]);
                  setNewFieldAnchorRect(event.currentTarget.getBoundingClientRect());
                  setNewFieldOpen(true);
                }}
              ><Plus className="h-4 w-4" aria-hidden="true" /></button>}
            </th></tr>
          </thead>
          <tbody>{visibleTableRecords.map((record) => {
            const noteKey = noteKeyForRecord(record);
            const note = noteKey ? noteByKey.get(noteKey) : undefined;
            const noteStatus = !noteKey ? 'draft' : note ? 'linked' : notesLoadError ? 'unknown' : 'missing';
            return <TableRecordRow
              key={record.id}
              record={record}
              showBottomBorder
              imagePaths={imagePaths}
              notePropertyEditorValue={notePropertyEditorValue}
              fields={tableViewFields}
              builtinFields={visibleBuiltinFields}
              fieldOrder={fieldOrder}
              allowSwitchNote={document.collection.placement !== 'folder'}
              titleField={titleField}
              note={note}
              isRuleLinked={conditionRecordIds.has(record.id)}
              notebookPath={notebookPath}
              getAvailableNotes={getAvailableNotes}
              subscribeAvailableNotes={subscribeAvailableNotes}
              noteStatus={noteStatus}
              autoOpenPrimaryEditor={autoOpenPrimaryRecordId === record.id}
              imageUrls={imageUrls}
              saving={saving}
              cellStatuses={cellStatusesByRecord.get(record.id) ?? EMPTY_CELL_STATUSES}
              rowActionOpen={rowActionRecordId === record.id}
              onRetryNoteLookup={retryNoteLookup}
              onReplaceNote={replaceLinkedNote}
              onCreateAndLinkRecordNote={createAndLinkRecordNote}
              onAutoOpenHandled={handleAutoOpenHandled}
              onRenameNote={renameLinkedNote}
              onOpenNote={openLinkedNote}
              onDeleteNote={requestDeleteLinkedNote}
              onSelectImage={selectImageForCell}
              onUpdateCell={updateCell}
              onDeleteRecord={handleDeleteRecord}
              onRowActionOpenChange={handleRowActionOpenChange}
            />;
          })}
          {visibleRecords.length === 0 && (
            <tr>
              <td colSpan={tableColumnCount} className="border-b border-[var(--border)] px-4 py-3 text-center text-sm text-[var(--muted-foreground)]">
                添加数据后查看
              </td>
            </tr>
          )}
          </tbody>
        </table>
      </div>}
      {activeView?.layout === 'kanban' && groupField?.type === 'Select' && <TableKanbanView
        groupField={groupField}
        titleField={titleField ?? document.dataset.schema.fields[0]}
        records={secondaryViewRecords}
        groups={kanbanGroups}
        renderValue={displayFieldValue}
        recordStatus={noteStatusForRecord}
        onDropRecord={dropKanbanRecord}
        onReorderLane={reorderKanbanLane}
        onAddLane={editable ? addKanbanLane : undefined}
        onAddTask={addKanbanTask}
        onOpenRecord={openLinkedRecord}
        onRenameRecord={editable && !saving ? renameKanbanRecord : undefined}
        onDeleteRecord={editable && !saving ? handleDeleteRecord : undefined}
        canAddTask={editable && Boolean(noteField && resolvedNotebookId && notebookPath) && !saving}
        canAddLane={editable && !saving}
      />}
      {activeView?.layout === 'calendar' && calendarDateFieldId && <TableCalendarView
        embeddedInEditor={embeddedInEditor}
        cursor={calendarCursor}
        onCursorChange={setCalendarCursor}
        days={calendarDays}
        groups={calendarGroups}
        dateFieldId={calendarDateFieldId}
        dateFieldLabel={calendarDateMetadata?.label ?? (calendarField ? fieldLabel(calendarField, propertyFields, t) : '')}
        dateFieldOptions={calendarDateFieldOptions}
        onDateFieldChange={calendarController.canChangeDateField ? updateCalendarDateField : undefined}
        onCustomDateField={calendarController.canChangeDateField ? () => setMatchingOpen(true) : undefined}
        titleField={document.dataset.schema.fields.find((field) => field.id === calendarTitleFieldId) ?? noteField ?? document.dataset.schema.fields[0]}
        renderValue={displayFieldValue}
        dateValueForRecord={(record) => calendarDateMetadata
          ? calendarDateTimeForTimestamp(noteForRecord(record)?.[calendarDateMetadata.timestamp])
          : calendarField ? notePropertyEditorValue(noteForRecord(record), calendarField) : null}
        canMoveRecords={calendarController.canEditDateValues && calendarField?.type === 'Date'}
        dateFieldReadOnly={calendarReadOnly}
        dateFieldReadOnlyReason={calendarDateMetadata ? `日历按${calendarDateMetadata.label}展示，为只读状态` : '当前多维表格为只读状态'}
        weekStart={calendarWeekStart}
        onWeekStartChange={calendarController.canChangeDateField ? updateCalendarWeekStart : undefined}
        onMoveRecord={updateRecordField}
        onOpenRecord={openLinkedRecord}
        addingNoteDate={calendarAddOpen ? calendarAddDate?.date : null}
        onDoubleClickDate={(date, anchorRect) => {
          if (calendarDateMetadata) {
            toast.warning(`日历按${calendarDateMetadata.label}展示，为只读状态`);
            return;
          }
          if (!editable) {
            toast.warning('当前多维表格为只读状态');
            return;
          }
          openCalendarNotePopover(date, anchorRect, calendarDateFieldId);
        }}
      />}
      {activeView?.layout === 'gallery' && <TableGalleryView
        records={visibleGalleryRecords}
        titleField={titleField ?? document.dataset.schema.fields[0]}
        fields={galleryFields}
        renderValue={displayFieldValue}
        imageUrl={(record, field) => {
          const path = imagePaths(notePropertyEditorValue(noteForRecord(record), field))[0];
          return path ? imageUrls[`${record.id}:${field.id}:${path}`] ?? null : null;
        }}
        noteThumbnail={(record) => noteThumbnailUrl(noteForRecord(record)?.thumbnail)}
        onOpenRecord={(record, anchorRect) => {
          const note = noteForRecord(record);
          if (note) openLinkedNote(note);
          else if (notesLoadError) retryNoteLookup();
          else openNotePicker(anchorRect, record.id);
        }}
        onCreateBlankNote={createBlankGalleryNote}
        onChooseData={chooseGalleryData}
        recordStatus={noteStatusForRecord}
        noteIcon={(record) => noteForRecord(record)?.icon ?? null}
        canAddData={editable && Boolean(noteField && resolvedNotebookId) && !saving}
      />}
      {activeView?.layout === 'gallery' && galleryPageCount > 1 && <footer className="flex flex-wrap items-center justify-end gap-3 px-5 py-1.5 text-xs text-[var(--muted-foreground)]" aria-label="画廊分页">
        <span>{secondaryViewRecords.length} 条</span>
        <button
          type="button"
          disabled={galleryCurrentPage === 0}
          onClick={() => setGalleryPage(galleryCurrentPage - 1)}
          className="p-0 text-inherit hover:text-[var(--foreground)] disabled:opacity-40"
        >
          上一页
        </button>
        <span>{galleryCurrentPage + 1} / {galleryPageCount}</span>
        <button
          type="button"
          disabled={galleryCurrentPage >= galleryPageCount - 1}
          onClick={() => setGalleryPage(galleryCurrentPage + 1)}
          className="p-0 text-inherit hover:text-[var(--foreground)] disabled:opacity-40"
        >
          下一页
        </button>
      </footer>}
      </OverlayScrollbar>
      {activeView?.layout === 'table' && <div className={`flex w-full min-w-0 shrink-0 flex-wrap items-center justify-between gap-2 py-1.5 pr-4 ${embeddedInEditor ? '' : 'pl-4'}`}>
        {showAssociateNoteButton && (
          <button
            type="button"
            disabled={!editable || saving || !noteField}
            onClick={() => void addDraftRecordAndOpenNoteSelector()}
            className="flex items-center gap-0.5 rounded py-1 text-sm text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            添加笔记
          </button>
        )}
        {pageCount > 1 && (
          <footer className="flex flex-wrap items-center gap-3 text-xs text-[var(--muted-foreground)]" aria-label="表格分页">
            <span>{visibleRecords.length} 条</span>
            <button
              type="button"
              disabled={currentPage === 0}
              onClick={() => setTablePage(currentPage - 1)}
              className="p-0 text-inherit hover:text-[var(--foreground)] disabled:opacity-40"
            >
              上一页
            </button>
            <span>{currentPage + 1} / {pageCount}</span>
            <button
              type="button"
              disabled={currentPage >= pageCount - 1}
              onClick={() => setTablePage(currentPage + 1)}
              className="p-0 text-inherit hover:text-[var(--foreground)] disabled:opacity-40"
            >
              下一页
            </button>
          </footer>
        )}
      </div>}
    </div>
    <Popover open={newFieldOpen} onOpenChange={(open) => {
      setNewFieldOpen(open);
      if (!open) {
        setNewFieldAnchorRect(null);
        setNewFieldTypeMenuOpen(false);
        setNewFieldPresetMenuOpen(false);
        if (skipNewFieldSaveOnCloseRef.current) skipNewFieldSaveOnCloseRef.current = false;
        else addField();
      }
      }} anchorRect={newFieldAnchorRect}>
      <PopoverContent side="left" align="start" sideOffset={0} ignorePopoverOutside={newFieldTypeMenuOpen || newFieldPresetMenuOpen} style={{ zIndex: 160 }} className="max-h-[min(70vh,420px)] w-[213px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl p-1.5 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <TableFieldEditorForm
          name={newFieldPropertyKey}
          onNameChange={setNewFieldPropertyKey}
          onNameSubmit={() => addField()}
          type={newFieldType}
          typeChoices={FIELD_TYPE_CHOICES}
          onTypeChange={(type) => {
            setNewFieldType(type);
            setNewFieldOptions((current) => type === 'Select' || type === 'MultiSelect'
              ? current.length > 0 ? current : [{ id: `opt_${createUuidV7()}`, label: '' }]
              : []);
          }}
          typeMenuOpen={newFieldTypeMenuOpen}
          onTypeMenuOpenChange={(open) => {
            setNewFieldTypeMenuOpen(open);
            if (open) setNewFieldPresetMenuOpen(false);
          }}
          options={newFieldOptions}
          onOptionsChange={setNewFieldOptions}
          customPresets={tablePresets.custom}
          systemPresets={tablePresets.system}
          presetMenuOpen={newFieldPresetMenuOpen}
          onPresetMenuOpenChange={(open) => {
            setNewFieldPresetMenuOpen(open);
            if (open) setNewFieldTypeMenuOpen(false);
          }}
          isPresetAdded={presetAlreadyAdded}
          onSelectPreset={(preset) => {
            setNewFieldPresetMenuOpen(false);
            skipNewFieldSaveOnCloseRef.current = true;
            setNewFieldPropertyKey('');
            setNewFieldOptions([]);
            setNewFieldOpen(false);
            void addField(preset);
          }}
          onRemovePreset={removePreset}
          onManagePresets={() => {
            setNewFieldPresetMenuOpen(false);
            skipNewFieldSaveOnCloseRef.current = true;
            setNewFieldOpen(false);
            void windows.openPreferences('noteSettings');
          }}
          disabled={!editable || saving}
          t={t}
          typeLabel={(type) => fieldTypeLabel(type, t)}
          typeIconKind={fieldTypeIconKind}
        />
      </PopoverContent>
    </Popover>
    <Popover open={calendarAddOpen} onOpenChange={setCalendarAddOpen} anchorRect={calendarAddAnchorRect}>
      <PopoverContent side="bottom" align="start" sideOffset={6} fitViewport className="w-[240px] max-w-[calc(100vw-16px)] rounded-xl px-2 py-2 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <NoteCreatePicker
          value={calendarAddTitle} onChange={setCalendarAddTitle}
          notes={availableNotes} allowSelect={document.collection.placement !== 'folder'}
          disabled={saving || !editable || !resolvedNotebookId} error={notesLoadError}
          onCreate={createCalendarNote} onSelect={linkCalendarNote} onCancel={closeCalendarAddPopover}
        />
      </PopoverContent>
    </Popover>
    <Popover open={notePickerOpen} onOpenChange={(open) => {
      setNotePickerOpen(open);
      if (!open) {
        setNotePickerRecordId(null);
        setNotePickerCalendarDate(null);
      }
    }} anchorRect={notePickerAnchorRect}>
      <PopoverContent side="bottom" align="start" sideOffset={6} fitViewport className="w-[280px] max-w-[calc(100vw-16px)] rounded-xl px-2 py-2 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        <NoteCreatePicker
          value={newNoteTitle} onChange={setNewNoteTitle}
          notes={availableNotes} allowSelect={document.collection.placement !== 'folder'}
          disabled={saving || !editable || !resolvedNotebookId} error={notesLoadError}
          onCreate={createAndLinkNote}
          onSelect={(selectedNote) => linkSelectedNote(selectedNote.relativePath.replace(/\\/g, '/'))}
          onCancel={() => setNotePickerOpen(false)}
        />
      </PopoverContent>
    </Popover>
    <FolderCollectionSwitchConfirmDialog
      open={folderMediaSwitchConfirmOpen}
      onOpenChange={setFolderMediaSwitchConfirmOpen}
      confirmDisabled={saving}
      onConfirm={() => {
        setFolderMediaSwitchConfirmOpen(false);
        if (notebookPath && notebookId) {
          window.dispatchEvent(new CustomEvent('flowix:request-switch-folder-collection-type', {
            detail: { filePath, notebookPath, notebookId, type: 'media_library' },
          }));
        }
      }}
    />
  </div>;
}
