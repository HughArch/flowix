import { useCallback, useEffect, useReducer, useRef, type Dispatch, type SetStateAction } from 'react';
import { reviseCollection } from '@features/collection/model';
import type { MultidimensionalTableDocument, TableView } from './model';
import { NOTE_CREATED_AT_FIELD_ID, NOTE_UPDATED_AT_FIELD_ID } from './model';

interface CalendarAddDialogState {
  open: boolean;
  anchorRect: DOMRect | null;
  date: { fieldId: string; date: string } | null;
  title: string;
}

type CalendarAddDialogAction =
  | { type: 'open'; fieldId: string; date: string; anchorRect: DOMRect }
  | { type: 'close' }
  | { type: 'set-open'; open: boolean }
  | { type: 'set-title'; value: SetStateAction<string> };

const initialCalendarAddDialogState: CalendarAddDialogState = {
  open: false,
  anchorRect: null,
  date: null,
  title: '',
};

function calendarAddDialogReducer(state: CalendarAddDialogState, action: CalendarAddDialogAction): CalendarAddDialogState {
  switch (action.type) {
    case 'open':
      return { open: true, anchorRect: action.anchorRect, date: { fieldId: action.fieldId, date: action.date }, title: '' };
    case 'close':
      return initialCalendarAddDialogState;
    case 'set-open':
      return action.open ? { ...state, open: true } : initialCalendarAddDialogState;
    case 'set-title':
      return { ...state, title: typeof action.value === 'function' ? action.value(state.title) : action.value };

  }
}

export const NOTE_CALENDAR_DATE_FIELDS = [
  { id: NOTE_CREATED_AT_FIELD_ID, label: '创建时间', timestamp: 'createdAt' as const },
  { id: NOTE_UPDATED_AT_FIELD_ID, label: '更新时间', timestamp: 'updatedAt' as const },
];

export function useCalendarController({
  document,
  activeView,
  editable,
  saving,
  save,
}: {
  document: MultidimensionalTableDocument | null;
  activeView: TableView | undefined;
  editable: boolean;
  saving: boolean;
  save: (next: MultidimensionalTableDocument) => Promise<boolean>;
}) {
  const [addDialog, dispatchAddDialog] = useReducer(calendarAddDialogReducer, initialCalendarAddDialogState);
  const view = activeView?.layout === 'calendar' ? activeView : null;
  const dateFieldId = typeof view?.config.date_field === 'string' ? view.config.date_field : null;
  const dateMetadata = NOTE_CALENDAR_DATE_FIELDS.find((field) => field.id === dateFieldId) ?? null;
  const weekStart: 0 | 1 = view?.config.week_start === 1 ? 1 : 0;
  const dialogContextRef = useRef({ viewId: view?.id, dateFieldId });

  useEffect(() => {
    const previous = dialogContextRef.current;
    if (previous.viewId !== view?.id || previous.dateFieldId !== dateFieldId) {
      dispatchAddDialog({ type: 'close' });
      dialogContextRef.current = { viewId: view?.id, dateFieldId };
    }
  }, [dateFieldId, view?.id]);

  const updateWeekStart = useCallback(async (nextWeekStart: 0 | 1) => {
    if (!document || !editable || saving || !view || weekStart === nextWeekStart) return;
    const next: MultidimensionalTableDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      views: { ...document.views, items: document.views.items.map((item) => {
        if (item.id !== view.id) return item;
        const config = { ...item.config };
        if (nextWeekStart === 0) delete config.week_start;
        else config.week_start = 1;
        return { ...item, config };
      }) },
    };
    await save(next);
  }, [document, editable, save, saving, view, weekStart]);

  const updateDateField = useCallback(async (fieldId: string) => {
    if (!document || !editable || saving || !view || fieldId === view.config.date_field) return;
    dispatchAddDialog({ type: 'close' });
    const next: MultidimensionalTableDocument = {
      ...document,
      collection: reviseCollection(document.collection),
      views: { ...document.views, items: document.views.items.map((item) => item.id === view.id
        ? { ...item, config: { ...item.config, date_field: fieldId } }
        : item) },
    };
    await save(next);
  }, [document, editable, save, saving, view]);

  const openAddDialog = useCallback((date: string, anchorRect: DOMRect, fieldId: string) => {
    dispatchAddDialog({ type: 'open', fieldId, date, anchorRect });
  }, []);
  const closeAddDialog = useCallback(() => dispatchAddDialog({ type: 'close' }), []);
  const setAddDialogOpen = useCallback((open: boolean) => dispatchAddDialog({ type: 'set-open', open }), []);
  const setTitle = useCallback<Dispatch<SetStateAction<string>>>((value) => dispatchAddDialog({ type: 'set-title', value }), []);

  return {
    dateFieldId,
    dateMetadata,
    weekStart,
    canEditDateValues: editable && Boolean(dateFieldId) && !dateMetadata,
    canChangeDateField: editable && !saving,
    isReadOnly: !editable || Boolean(dateMetadata),
    updateWeekStart,
    updateDateField,
    addDialog,
    openAddDialog,
    closeAddDialog,
    setAddDialogOpen,
    setTitle,
  };
}
