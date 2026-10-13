import { reviseCollection } from '@features/collection/model';
import { canonicalizePropertyKey } from '@features/document/properties/property-key';
import type { PropertyPreset } from '@features/document/properties/presets';
import { createUuidV7, type MultidimensionalTableDocument, type TableField, type TableFieldType, type TableView } from './model';
import { collectionFilterUsesField, type CollectionRuleFilter } from '@features/collection/rule-filter';
import { BUILTIN_TABLE_FIELDS, builtinPresetTableField } from './builtin-fields';

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
    const sort = view.sort.filter((item) => item.field !== fieldId && item.field !== field.property_key);
    return { ...view, config, sort };
  });
  return {
    ...document,
    collection: reviseCollection(document.collection),
    dataset: { ...document.dataset, schema: { ...document.dataset.schema, fields: document.dataset.schema.fields.filter((item) => item.id !== fieldId), field_order: document.dataset.schema.field_order.filter((id) => id !== fieldId) } },
    views: { ...document.views, items: views },
  };
}

function appendFieldToDataset(document: MultidimensionalTableDocument, field: TableField): MultidimensionalTableDocument {
  return {
    ...document,
    collection: reviseCollection(document.collection),
    dataset: { ...document.dataset, schema: {
      ...document.dataset.schema,
      fields: [...document.dataset.schema.fields, field],
      field_order: [...document.dataset.schema.field_order, field.id],
    } },
    views: { ...document.views, items: document.views.items.map((view) => view.layout === 'table'
      ? { ...view, config: { ...view.config, visible_fields: [...new Set([...view.config.visible_fields as string[], field.id])] } }
      : view) },
  };
}

/** Adds an editable schema field and includes it in each table view. */
export function addTableField(document: MultidimensionalTableDocument, field: TableField): MultidimensionalTableDocument {
  const propertyKey = canonicalizePropertyKey(field.property_key ?? '').toLocaleLowerCase();
  const builtinKey = BUILTIN_TABLE_FIELDS.some((item) => {
    const key = builtinPresetTableField(item.id)?.property_key;
    return key !== undefined && canonicalizePropertyKey(key).toLocaleLowerCase() === propertyKey;
  });
  if (!propertyKey || builtinKey || ['flowix_key', 'key'].includes(propertyKey)
    || document.dataset.schema.fields.some((item) => item.property_key
    && canonicalizePropertyKey(item.property_key).toLocaleLowerCase() === propertyKey)) {
    throw new Error('属性键已存在或属于保留名称');
  }
  return appendFieldToDataset(document, field);
}

export function addPresetField(document: MultidimensionalTableDocument, preset: PropertyPreset): MultidimensionalTableDocument {
  const propertyKey = canonicalizePropertyKey(preset.key).toLocaleLowerCase();
  const builtin = BUILTIN_TABLE_FIELDS.find((field) => builtinPresetTableField(field.id)?.property_key === propertyKey);
  if (preset.source === 'builtin' && builtin) {
    if (document.dataset.schema.fields.some((field) => field.property_key
      && canonicalizePropertyKey(field.property_key).toLocaleLowerCase() === propertyKey)) {
      throw new Error('属性键已存在或属于保留名称');
    }
    if (document.dataset.schema.preset_fields.includes(builtin.id)) return document;
    return {
      ...document,
      collection: reviseCollection(document.collection),
      dataset: { ...document.dataset, schema: {
        ...document.dataset.schema,
        preset_fields: [...document.dataset.schema.preset_fields, builtin.id],
        field_order: [...document.dataset.schema.field_order, builtin.id],
      } },
      views: { ...document.views, items: document.views.items.map((view) => view.layout === 'table'
        ? { ...view, config: { ...view.config, visible_fields: [...new Set([...view.config.visible_fields as string[], builtin.id])] } }
        : view) },
    };
  }
  if (builtin) throw new Error('预设属性键已存在');
  const optionLabels = [...new Set((preset.options ?? []).map((label) => label.trim()).filter(Boolean))];
  const options = (preset.kind === 'Select' || preset.kind === 'MultiSelect')
    ? optionLabels.map((label) => ({ id: `opt_${createUuidV7()}`, label }))
    : undefined;
  return addTableField(document, {
    id: `fld_${createUuidV7()}`,
    type: preset.kind,
    property_key: preset.key,
    ...(options?.length ? { options } : {}),
  });
}

/** Removes a preset only after all table views have hidden its field. */
export function removePresetField(document: MultidimensionalTableDocument, preset: PropertyPreset): MultidimensionalTableDocument {
  const propertyKey = canonicalizePropertyKey(preset.key).toLocaleLowerCase();
  const schemaField = document.dataset.schema.fields.find((field) => field.property_key
    && canonicalizePropertyKey(field.property_key).toLocaleLowerCase() === propertyKey);
  const builtin = schemaField ? undefined : BUILTIN_TABLE_FIELDS.find((field) => builtinPresetTableField(field.id)?.property_key === propertyKey);
  const fieldId = schemaField?.id ?? builtin?.id;
  if (!fieldId) return document;
  const tableViews = document.views.items.filter((view) => view.layout === 'table');
  if (tableViews.some((view) => (view.config.visible_fields as string[]).includes(fieldId))) {
    throw new Error('仅支持移除隐藏字段');
  }
  if (!builtin) return removeField(document, fieldId);
  if (viewsRequiringField(document, fieldId).length) throw new Error('请先调整依赖此属性的视图');
  if (!document.dataset.schema.preset_fields.includes(builtin.id)) return document;
  return {
    ...document,
    collection: reviseCollection(document.collection),
    dataset: { ...document.dataset, schema: {
      ...document.dataset.schema,
      preset_fields: document.dataset.schema.preset_fields.filter((id) => id !== builtin.id),
      field_order: document.dataset.schema.field_order.filter((id) => id !== builtin.id),
    } },
    views: { ...document.views, items: document.views.items.map((view) => ({
      ...view,
      ...(view.layout === 'table' || view.layout === 'gallery'
        ? { config: { ...view.config, visible_fields: (view.config.visible_fields as string[]).filter((id) => id !== builtin.id) } }
        : {}),
      sort: view.sort.filter((item) => item.field !== builtin.id),
    })) },
  };
}

/** Removes a built-in preset or read-only field from the dataset and its views. */
export function removeBuiltinField(document: MultidimensionalTableDocument, fieldId: string): MultidimensionalTableDocument {
  if (!BUILTIN_TABLE_FIELDS.some((field) => field.id === fieldId)) return document;
  if (fieldId === document.dataset.schema.primary_field_id) throw new Error('不能移除标题字段');
  if (viewsRequiringField(document, fieldId).length) throw new Error('请先调整依赖此属性的视图');
  return {
    ...document,
    collection: reviseCollection(document.collection),
    dataset: { ...document.dataset, schema: {
      ...document.dataset.schema,
      preset_fields: document.dataset.schema.preset_fields.filter((id) => id !== fieldId),
      field_order: document.dataset.schema.field_order.filter((id) => id !== fieldId),
    } },
    views: { ...document.views, items: document.views.items.map((view) => ({
      ...view,
      ...(view.layout === 'table' || view.layout === 'gallery'
        ? { config: { ...view.config, visible_fields: (view.config.visible_fields as string[]).filter((id) => id !== fieldId) } }
        : {}),
      sort: view.sort.filter((item) => item.field !== fieldId),
    })) },
  };
}

/** The dataset panel manages table columns independently of the active layout. */
export function toggleDatasetTableFieldVisibility(document: MultidimensionalTableDocument, fieldId: string): MultidimensionalTableDocument {
  if (fieldId === document.dataset.schema.primary_field_id) return document;
  const tableViews = document.views.items.filter((view) => view.layout === 'table');
  if (!tableViews.length) return document;
  const visible = !tableViews.every((view) => (view.config.visible_fields as string[]).includes(fieldId));
  return {
    ...document,
    collection: reviseCollection(document.collection),
    views: { ...document.views, items: document.views.items.map((view) => {
      if (view.layout !== 'table') return view;
      const fields = view.config.visible_fields as string[];
      const nextFields = visible ? fields.includes(fieldId) ? fields : [...fields, fieldId] : fields.filter((id) => id !== fieldId);
      return { ...view, config: { ...view.config, visible_fields: nextFields } };
    }) },
  };
}
