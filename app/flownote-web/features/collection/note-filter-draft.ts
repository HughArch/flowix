import { normalizeNoteFilterCondition, type NoteFilterConfig, type NoteFilterCondition, type NoteFilterFieldType } from './note-filter';
import { NOTE_TITLE_FIELD_ID, LEGACY_NOTE_FILTER_PROPERTY_KEYS } from './note-filter-fields';

export type NoteFilterChoice = { value: string; label: string };
export type NoteFilterEditorField = { id: string; label: string; propertyKey?: string; type?: NoteFilterFieldType; options?: Array<{ id: string; label: string }> };
export type NoteFilterOption = { value: string; label: string; type?: NoteFilterFieldType; options?: NoteFilterChoice[] };

function findNoteFilterOption(value: string, options: NoteFilterOption[]) {
  return options.find((option) => option.value === value);
}

export function findConditionFilterOption(
  fieldId: string,
  fields: NoteFilterEditorField[],
  options: NoteFilterOption[],
) {
  const option = findNoteFilterOption(fieldId, options);
  if (option) return option;
  const field = fields.find((item) => item.id === fieldId);
  return options.find((item) => item.value === field?.propertyKey);
}

export function supportsOrdering(type: NoteFilterFieldType | undefined): boolean {
  return type === 'Number' || type === 'Date';
}

export function readNoteFilterDraft(defaultFieldId: string, fields: NoteFilterEditorField[], config: NoteFilterConfig | null, options: NoteFilterOption[]): NoteFilterCondition {
  const condition = config?.condition ?? {};
  const normalized = normalizeNoteFilterCondition(condition);
  return {
    ...condition,
    match: normalized.match,
    path: normalized.path,
    property_conditions: (condition.property_conditions ?? [{ field_id: defaultFieldId, operator: 'equals' as const, value: '' }]).map((item) => {
      const field = fields.find((fieldOption) => fieldOption.id === item.field_id);
      const legacyPropertyKey = LEGACY_NOTE_FILTER_PROPERTY_KEYS[item.field_id];
      const value = field?.type === 'primary'
        ? NOTE_TITLE_FIELD_ID
        : field?.propertyKey ?? legacyPropertyKey ?? item.field_id;
      const legacyLabelOptions = config?.field_reference_format === 'legacy-labels'
        ? options.filter((option) => option.label === item.field_id)
        : [];
      const legacyLabelOption = legacyLabelOptions.length === 1 ? legacyLabelOptions[0] : undefined;
      const fieldId = findNoteFilterOption(value, options)?.value
        ?? findNoteFilterOption(item.field_id, options)?.value
        ?? legacyLabelOption?.value
        ?? value;
      const selectedOption = findConditionFilterOption(fieldId, fields, options);
      return {
        ...item,
        field_id: fieldId,
        operator: (item.operator === 'gt' || item.operator === 'lt') && !supportsOrdering(selectedOption?.type)
          ? 'equals'
          : item.operator,
      };
    }),
    file_condition: {
      file_name_contains: '',
      path_contains: '',
      ...normalized.file_condition,
      file_type: normalized.file_condition?.file_type ?? '',
    },
  };
}

export function resolveNoteFilterDraft(
  condition: NoteFilterCondition,
  fields: NoteFilterEditorField[],
): NoteFilterCondition {
  const resolveField = (fieldId: string) => fields.find((item) => item.id === fieldId)
    ?? fields.find((item) => item.propertyKey === fieldId);
  const propertyConditions = condition.property_conditions?.map((item) => ({
    ...item,
    field_id: resolveField(item.field_id)?.id ?? item.field_id,
  }));
  return {
    ...condition,
    ...(propertyConditions ? { property_conditions: propertyConditions } : {}),
  };
}
