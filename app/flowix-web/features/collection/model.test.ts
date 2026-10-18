import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { parseCollectionDocumentV2 } from './model';
import { createTableDocument, parseTableDocument, serializeTableDocument } from '../multidimensional-table/model';
import { createMediaLibrary, createMediaLibraryRecord, parseMediaLibrary, serializeMediaLibrary } from '../media-library/model';
vi.mock('@platform/tauri/client', () => ({ files: {} }));

describe('collection file identity and properties', () => {
  it('stores common metadata and typed properties alongside the v2 dataset and views', () => {
    const table = createTableDocument('table', '项目');
    table.collection.properties = { owner: { type: 'Text', name: '负责人', value: '张三' } };
    const tableFile = YAML.parse(serializeTableDocument(table));
    expect(tableFile).toMatchObject({ format: 'flowix.collection', schema_version: 2, collection: { id: table.collection.id, type: 'notes', properties: table.collection.properties }, payload: { schema_version: 2, dataset: { records: { include: [] } }, views: { items: [{ layout: 'table' }] } } });
    expect(tableFile.payload.dataset).not.toHaveProperty('id');
    expect(parseTableDocument(serializeTableDocument(table))).toEqual(table);
    const library = createMediaLibrary('照片');
    library.dataset.records.include.push(createMediaLibraryRecord('notebook-1', 'attachments/photo.png'));
    library.collection.properties = table.collection.properties;
    expect(parseMediaLibrary(serializeMediaLibrary(library))).toEqual(library);
    expect(library.collection.id).toMatch(/^col_[0-9a-f]{32}$/);
  });
  it('rejects unknown header/payload versions and incompatible property values', () => {
    const source = serializeTableDocument(createTableDocument());
    expect(() => parseCollectionDocumentV2(source.replace('schema_version: 2', 'schema_version: 3'))).toThrow('版本');
    const parsed = YAML.parse(source);
    parsed.payload.schema_version = 2;
    parsed.payload.schema_version = 3;
    expect(() => parseCollectionDocumentV2(YAML.stringify(parsed))).toThrow('版本');
    parsed.payload.schema_version = 2;
    parsed.collection.properties = { deadline: { type: 'Date', value: '2026-02-30' } };
    expect(() => parseCollectionDocumentV2(YAML.stringify(parsed))).toThrow('属性');
    parsed.collection.properties = { count: { type: 'Number', value: '3' } };
    expect(() => parseCollectionDocumentV2(YAML.stringify(parsed))).toThrow('属性');
  });
});
