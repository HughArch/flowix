import { reviseCollection } from '@features/collection/model';
import type { MultidimensionalTableDocument, TableField, TableFieldType, TableView } from './model';
import { collectionFilterUsesField, type CollectionRuleFilter } from '@features/collection/rule-filter';

export function viewsRequiringField(document: MultidimensionalTableDocument, fieldId: string): TableView[] {
  return document.views.items.filter((view) =>
    (view.layout === 'kanban' && view.config.group_by === fieldId)
    || (view.layout === 'calendar' && view.config.date_field === fieldId));
}

export function viewsIncompatibleWithFieldType(document: MultidimensionalTableDocument, fieldId: string, type: TableFieldType): TableView[] {
  return viewsRequiringField(document, fieldId).filter((view) =>
    (view.layout === 'kanban' && type !== 'Select') || (view.layout === 'calendar' && type !== 'Date'));
}

export function renameField(document: MultidimensionalTableDocument, fieldId: string, name: string): MultidimensionalTableDocument {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('列名称不能为空');
  if (!document.dataset.schema.fields.some((field) => field.id === fieldId && field.type !== 'primary')) throw new Error('无法重命名此列');
  return {
    ...document,
    collection: reviseCollection(document.collection),
    dataset: { ...document.dataset, schema: { ...document.dataset.schema, fields: document.dataset.schema.fields.map((field) => field.id === fieldId ? { ...field, name: trimmed } : field) } },
  };
}

export function changeFieldType(
  document: MultidimensionalTableDocument,
  fieldId: string,
  type: TableFieldType,
  options?: TableField['options'],
  multiple?: boolean,
): MultidimensionalTableDocument {
  if (type === 'primary') throw new Error('不能改变主字段类型');
  const field = document.dataset.schema.fields.find((item) => item.id === fieldId);
  if (!field || field.type === 'primary') throw new Error('无法改变此列类型');
  if (viewsIncompatibleWithFieldType(document, fieldId, type).length) throw new Error('请先调整依赖此属性的视图');
  const nextField: TableField = { ...field, type };
  if (options) nextField.options = options;
  else delete nextField.options;
  if (type === 'Image') nextField.multiple = Boolean(multiple);
  else delete nextField.multiple;
  return {
    ...document,
    collection: reviseCollection(document.collection),
    dataset: { ...document.dataset, schema: { ...document.dataset.schema, fields: document.dataset.schema.fields.map((item) => item.id === fieldId ? nextField : item) } },
  };
}

/** Removing a column never removes its underlying note frontmatter property. */
export function removeField(document: MultidimensionalTableDocument, fieldId: string): MultidimensionalTableDocument {
  const field = document.dataset.schema.fields.find((item) => item.id === fieldId);
  if (!field || field.type === 'primary') throw new Error('不能移除主字段');
  if (viewsRequiringField(document, fieldId).length) throw new Error('请先调整依赖此属性的视图');
  if (collectionFilterUsesField(document.dataset.filter as unknown as CollectionRuleFilter | null, fieldId)) {
    throw new Error('请先调整引用此属性的笔记条件匹配');
  }
  const views = document.views.items.map((view) => {
    const config = { ...view.config };
    for (const key of ['group_by', 'date_field', 'title_field']) if (config[key] === fieldId) delete config[key];
    if (view.layout === 'table' || view.layout === 'gallery') {
      config.visible_fields = (config.visible_fields as string[]).filter((id) => id !== fieldId);
    }
    return { ...view, config };
  });
  return {
    ...document,
    collection: reviseCollection(document.collection),
    dataset: { ...document.dataset, schema: { ...document.dataset.schema, fields: document.dataset.schema.fields.filter((item) => item.id !== fieldId) } },
    views: { ...document.views, items: views },
  };
}
