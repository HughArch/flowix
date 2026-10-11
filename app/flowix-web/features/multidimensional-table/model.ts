import { createCollectionMetadata, createCollectionId, createUuidV7, parseCollectionDocumentV2, serializeCollectionDocumentV2, validateCollectionMetadata, reviseCollection, hasOnlyKeys, type CollectionMetadata, type CollectionSource } from '@features/collection/model';
export { createUuidV7 } from '@features/collection/model';
import { isTablePropertyKind, type TablePropertyKind } from '@/lib/property-types';

export const NOTE_CREATED_AT_FIELD_ID = '__note_created_at__';
export const NOTE_UPDATED_AT_FIELD_ID = '__note_updated_at__';

export type TableFieldType = Exclude<TablePropertyKind, 'Note'> | 'primary';

export interface TableFieldOption {
  id: string;
  label: string;
}

export interface TableAutoCollectCondition {
  property_conditions?: TableAutoCollectPropertyCondition[];
  property_match?: 'union' | 'intersection';
  file_condition?: TableAutoCollectFileCondition;
}

export interface TableAutoCollectPropertyCondition {
  /**
   * A table field ID, or a raw note frontmatter property key when the
   * property is not configured as a table field.
   */
  field_id: string;
  operator: 'equals' | 'contains';
  value: string;
}

export type TableAutoCollectFileType = '' | 'markdown';

export interface TableAutoCollectFileCondition {
  file_name_contains?: string;
  file_type?: TableAutoCollectFileType;
  path_contains?: string;
}

export interface TableAutoCollectConfig {
  condition: TableAutoCollectCondition;
}

export interface TableField {
  id: string;
  type: TableFieldType;
  name?: string;
  /** Frontmatter property key shared by every view. */
  property_key?: string;
  options?: TableFieldOption[];
  multiple?: boolean;
}

export interface TableView {
  id: string;
  name: string;
  layout: TableViewType;
  filter: Record<string, unknown>;
  sort: Array<{ field: string; direction: 'asc' | 'desc' }>;
  config: Record<string, unknown>;
}

export type TableViewType = 'table' | 'kanban' | 'calendar' | 'gallery';

const VIEW_NAMES: Record<TableViewType, string> = {
  table: '表格', kanban: '看板', calendar: '日历', gallery: '画廊',
};

export interface TableRecord {
  id: string;
  updated_at: string;
  /** Notebook-relative note reference. Property values live in note frontmatter. */
  note_path: string;
}

export interface MultidimensionalTableDocument {
  collection: CollectionMetadata;
  dataset: {
    source: CollectionSource;
    schema: { primary_field_id: string; fields: TableField[] };
    records: { include: TableRecord[]; exclude: Array<{ note_path: string }> };
    filter: Record<string, unknown> | null;
  };
  views: { default_id: string; items: TableView[] };
}

export function tableAutoCollectConfig(document: MultidimensionalTableDocument): TableAutoCollectConfig | null {
  const filter = document.dataset.filter;
  if (!filter) return null;
  const all = Array.isArray(filter.all) ? filter.all as Record<string, unknown>[] : [];
  const any = Array.isArray(filter.any) ? filter.any as Record<string, unknown>[] : [];
  const grouped = any.find((rule) => Array.isArray(rule.all));
  const propertyRules = grouped ? grouped.all as Record<string, unknown>[] : all.length ? all : any;
  const property_conditions = propertyRules.flatMap((rule) => {
    if (typeof rule.field !== 'string' || ['kind', 'file_name', 'path'].includes(rule.field) || typeof rule.value !== 'string') return [];
    return [{ field_id: rule.field, operator: rule.op === 'contains' ? 'contains' as const : 'equals' as const, value: rule.value }];
  });
  const fileRules = [...all, ...any].filter((rule) => typeof rule.field === 'string');
  const file_condition: TableAutoCollectFileCondition = {};
  for (const rule of fileRules) {
    if (rule.field === 'file_name' && rule.op === 'contains' && typeof rule.value === 'string') file_condition.file_name_contains = rule.value;
    if (rule.field === 'path' && rule.op === 'contains' && typeof rule.value === 'string') file_condition.path_contains = rule.value;
    if (rule.field === 'kind' && rule.op === 'eq' && rule.value === 'note') file_condition.file_type = 'markdown';
  }
  const condition: TableAutoCollectCondition = {
    ...(property_conditions.length ? { property_conditions, property_match: grouped || all.length ? 'intersection' as const : 'union' as const } : {}),
    ...(Object.keys(file_condition).length ? { file_condition } : {}),
  };
  return { condition };
}

export function withTableAutoCollect(document: MultidimensionalTableDocument, config: TableAutoCollectConfig | null): MultidimensionalTableDocument {
  if (!config) return { ...document, dataset: { ...document.dataset, filter: null } };
  const properties = (config.condition.property_conditions ?? []).map((item) => ({ field: item.field_id.trim(), op: item.operator === 'contains' ? 'contains' : 'eq', value: item.value.trim() }));
  const file = config.condition.file_condition;
  const files: Record<string, unknown>[] = [];
  if (file?.file_name_contains) files.push({ field: 'file_name', op: 'contains', value: file.file_name_contains });
  if (file?.path_contains) files.push({ field: 'path', op: 'contains', value: file.path_contains });
  if (file?.file_type === 'markdown') files.push({ field: 'kind', op: 'eq', value: 'note' });
  const filter = properties.length && config.condition.property_match === 'intersection'
    ? files.length ? { all: [], any: [{ all: properties, any: [] }, ...files] } : { all: properties, any: [] }
    : { all: [], any: [...properties, ...files] };
  return { ...document, dataset: { ...document.dataset, filter } };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value).map(([key, entry]) => [key, key === 'op' && entry === 'equals' ? 'eq' : stableValue(entry)] as const);
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

/** The compact auto-collect form can edit only filters it can round-trip exactly. */
export function canEditTableAutoCollectFilter(document: MultidimensionalTableDocument): boolean {
  if (document.dataset.filter == null) return true;
  const roundTripped = withTableAutoCollect(document, tableAutoCollectConfig(document)).dataset.filter;
  return JSON.stringify(stableValue(document.dataset.filter)) === JSON.stringify(stableValue(roundTripped));
}

export const createTableId = createCollectionId;

export function createTableView(document: MultidimensionalTableDocument, type: TableViewType, fieldId?: string): TableView {
  const fields = document.dataset.schema.fields;
  const field = fields.find((item) => item.id === fieldId);
  if (type === 'kanban' && field?.type !== 'Select') throw new Error('看板需要单选属性');
  if (type === 'calendar' && fieldId && fieldId !== NOTE_CREATED_AT_FIELD_ID && fieldId !== NOTE_UPDATED_AT_FIELD_ID && field?.type !== 'Date') {
    throw new Error('日历需要日期属性');
  }
  const baseName = VIEW_NAMES[type];
  const names = new Set(document.views.items.map((view) => view.name));
  let name = baseName;
  for (let suffix = 2; names.has(name); suffix += 1) name = `${baseName} ${suffix}`;
  const config = type === 'table'
    ? { visible_fields: fields.map((item) => item.id) }
    : type === 'gallery'
      ? { visible_fields: fields.filter((item) => item.type !== 'primary').map((item) => item.id) }
      : type === 'calendar'
        ? { date_field: fieldId ?? NOTE_CREATED_AT_FIELD_ID, title_field: document.dataset.schema.primary_field_id }
        : { group_by: fieldId };
  return { id: `view_${createUuidV7()}`, name, layout: type, filter: { all: [], any: [] }, sort: [{ field: 'modified_at', direction: 'desc' }], config };
}

export function addTableView(document: MultidimensionalTableDocument, type: TableViewType, fieldId?: string): { document: MultidimensionalTableDocument; view: TableView } {
  const view = createTableView(document, type, fieldId);
  return {
    view,
    document: {
      ...document,
      collection: reviseCollection(document.collection),
      views: { ...document.views, items: [...document.views.items, view] },
    },
  };
}

/** Adds a shared note property only when the user explicitly chooses to create one. */
export function addKanbanField(document: MultidimensionalTableDocument): { document: MultidimensionalTableDocument; field: TableField } {
  const keys = new Set(document.dataset.schema.fields.map((field) => field.property_key?.toLocaleLowerCase()));
  let propertyKey = '状态';
  for (let suffix = 2; keys.has(propertyKey.toLocaleLowerCase()); suffix += 1) propertyKey = `状态 ${suffix}`;
  const field: TableField = {
    id: `fld_${createUuidV7()}`,
    type: 'Select',
    property_key: propertyKey,
    options: ['未开始', '进行中', '完成'].map((label) => ({ id: `opt_${createUuidV7()}`, label })),
  };
  return {
    field,
    document: {
      ...document,
      dataset: { ...document.dataset, schema: { ...document.dataset.schema, fields: [...document.dataset.schema.fields, field] } },
      views: { ...document.views, items: document.views.items.map((view) => view.layout === 'table'
        ? { ...view, config: { ...view.config, visible_fields: [...view.config.visible_fields as string[], field.id] } }
        : view) },
    },
  };
}

export function createTableDocument(initialViewType: TableViewType = 'table', name = '多维表格'): MultidimensionalTableDocument {
  const noteFieldId = `fld_${createUuidV7()}`;
  let document: MultidimensionalTableDocument = {
    collection: createCollectionMetadata('table', name),
    dataset: { source: { scope: 'notebook', depth: 'descendants' },
      schema: { primary_field_id: noteFieldId, fields: [{ id: noteFieldId, type: 'primary', property_key: 'note' }] },
      records: { include: [], exclude: [] }, filter: null },
    views: { default_id: '', items: [] },
  };
  let fieldId: string | undefined;
  if (initialViewType === 'kanban') {
    const added = addKanbanField(document);
    document = added.document;
    fieldId = added.field.id;
  } else if (initialViewType === 'calendar') {
    const dateField: TableField = {
      id: `fld_${createUuidV7()}`,
      type: 'Date',
      property_key: '日期',
    };
    document = {
      ...document,
      dataset: {
        ...document.dataset,
        schema: { ...document.dataset.schema, fields: [...document.dataset.schema.fields, dateField] },
      },
    };
    fieldId = dateField.id;
  }
  const view = createTableView(document, initialViewType, fieldId);
  document.views = { default_id: view.id, items: [view] };
  return document;
}

export function parseTableDocument(source: string): MultidimensionalTableDocument {
  const parsed = parseCollectionDocumentV2(source, 'table');
  return validateTableDocument({ collection: parsed.collection, dataset: parsed.payload.dataset, views: parsed.payload.views });
}

export function validateTableDocument(parsed: unknown): MultidimensionalTableDocument {
  if (!parsed || typeof parsed !== 'object') throw new Error('表格文件必须是 YAML 对象');
  const value = parsed as Partial<MultidimensionalTableDocument>;
  validateCollectionMetadata(value.collection, 'table');
  if (!value.dataset || !Array.isArray(value.dataset.schema?.fields)
      || !value.views || !Array.isArray(value.views.items) || !value.dataset.records || !Array.isArray(value.dataset.records.include)) {
    throw new Error('不支持的多维表格文件格式');
  }
  if (!hasOnlyKeys(value, ['collection', 'dataset', 'views'])) throw new Error('多维表格文件包含未知字段');
  const fieldIds = new Set<string>();
  const fieldKeys = new Set<string>();
  for (const field of value.dataset?.schema.fields) {
    if (!field || !hasOnlyKeys(field, ['id', 'type', 'name', 'property_key', 'options', 'multiple'])
      || !/^fld_[0-9a-f]{32}$/.test(field.id) || fieldIds.has(field.id) || !(field.type === 'primary' || (String(field.type) !== 'Note' && isTablePropertyKind(field.type)))) {
      throw new Error('表格字段 ID 或类型无效');
    }
    if (field.type !== 'primary' && (typeof field.property_key !== 'string' || !field.property_key.trim())) {
      throw new Error('表格字段缺少笔记属性键');
    }
    if (field.name !== undefined && (typeof field.name !== 'string' || !field.name.trim())) throw new Error('表格字段显示名无效');
    if (field.type === 'primary' && field.property_key !== 'note') throw new Error('主字段的属性键必须是 note');
    const fieldKey = field.property_key?.trim().toLocaleLowerCase();
    if (fieldKey) {
      if (fieldKeys.has(fieldKey)) throw new Error(`属性键重复：${field.property_key}`);
      fieldKeys.add(fieldKey);
    }
    const optionIds = new Set<string>();
    if (field.options !== undefined && !Array.isArray(field.options)) throw new Error('表格字段选项格式无效');
    for (const option of field.options ?? []) {
      if (!option || !hasOnlyKeys(option, ['id', 'label']) || !/^opt_[0-9a-f]{32}$/.test(option.id) || optionIds.has(option.id) || typeof option.label !== 'string' || !option.label.trim()) throw new Error(`字段“${field.property_key ?? '笔记文档'}”的选项定义无效`);
      optionIds.add(option.id);
    }
    fieldIds.add(field.id);
  }
  if (value.dataset?.schema.fields[0]?.type !== 'primary' || value.dataset?.schema.fields.filter((field) => field.type === 'primary').length !== 1) {
    throw new Error('多维表格首列必须是唯一的笔记引用字段');
  }
  if (value.dataset?.schema.primary_field_id !== value.dataset?.schema.fields[0].id) throw new Error('多维表格主字段必须是笔记引用字段');
  const viewIds = new Set<string>();
  if (value.views?.items.length === 0) throw new Error('多维表格至少需要一个视图');
  for (const view of value.views?.items) {
    if (!view || !hasOnlyKeys(view, ['id', 'name', 'layout', 'filter', 'sort', 'config']) || !/^view_[0-9a-f]{32}$/.test(view.id) || viewIds.has(view.id) || typeof view.name !== 'string' || !view.name.trim() || !['table', 'kanban', 'calendar', 'gallery'].includes(view.layout) || !view.config || typeof view.config !== 'object' || Array.isArray(view.config)) throw new Error('表格视图定义无效');
    viewIds.add(view.id);
    const referencedFields = [view.config.group_by, view.config.title_field]
      .filter((item): item is string => typeof item === 'string');
    if (typeof view.config.date_field === 'string'
      && view.config.date_field !== NOTE_CREATED_AT_FIELD_ID
      && view.config.date_field !== NOTE_UPDATED_AT_FIELD_ID) {
      referencedFields.push(view.config.date_field);
    }
    const visibleFields = view.config.visible_fields;
    if ((view.layout === 'table' || view.layout === 'gallery')
      && (!Array.isArray(visibleFields) || visibleFields.some((item) => typeof item !== 'string'))) {
      throw new Error(`视图“${view.name}”的显示字段配置无效`);
    }
    if (view.layout === 'table' || view.layout === 'gallery') referencedFields.push(...visibleFields as string[]);
    if (referencedFields.some((id) => !fieldIds.has(id))) throw new Error(`视图“${view.name}”引用了不存在的字段`);
    const allowedConfigKeys = view.layout === 'table' || view.layout === 'gallery'
      ? ['visible_fields']
      : view.layout === 'kanban' ? ['group_by'] : ['date_field', 'title_field', 'week_start'];
    if (!hasOnlyKeys(view.config, allowedConfigKeys)) throw new Error(`视图“${view.name}”包含未知配置`);
    if (view.layout === 'kanban') {
      const groupField = value.dataset?.schema.fields.find((field) => field.id === view.config.group_by);
      if (!groupField || groupField.type !== 'Select') throw new Error(`看板视图“${view.name}”需要单选属性`);
    }
    if (view.layout === 'calendar') {
      const dateFieldId = view.config.date_field;
      const dateField = typeof dateFieldId === 'string' ? value.dataset?.schema.fields.find((field) => field.id === dateFieldId) : undefined;
      if (dateFieldId !== NOTE_CREATED_AT_FIELD_ID && dateFieldId !== NOTE_UPDATED_AT_FIELD_ID && dateField?.type !== 'Date') {
        throw new Error(`日历视图“${view.name}”需要日期属性`);
      }
      if (typeof view.config.title_field !== 'string') throw new Error(`日历视图“${view.name}”的标题字段无效`);
      if (view.config.week_start !== undefined && view.config.week_start !== 1) throw new Error(`日历视图“${view.name}”的周起始日无效`);
    }
  }
  const recordIds = new Set<string>();
  const linkedNotes = new Set<string>();
  for (const record of value.dataset.records.include) {
    if (!record || !/^rec_[0-9a-f]{32}$/.test(record.id) || recordIds.has(record.id)
      || typeof record.updated_at !== 'string'
      || typeof record.note_path !== 'string'
      || Object.keys(record).some((key) => !['id', 'updated_at', 'note_path'].includes(key))) throw new Error('表格记录格式无效');
    recordIds.add(record.id);
    if (record.note_path) {
      const normalized = record.note_path.replace(/\\/g, '/');
      if (linkedNotes.has(normalized)) throw new Error(`笔记重复关联：${normalized}`);
      linkedNotes.add(normalized);
    }
  }
  return value as MultidimensionalTableDocument;
}

export function serializeTableDocument(document: MultidimensionalTableDocument): string {
  validateTableDocument(document);
  return serializeCollectionDocumentV2({ format: 'flowix.collection', schema_version: 2, collection: document.collection,
    payload: { schema_version: 2, dataset: document.dataset, views: document.views } });
}
