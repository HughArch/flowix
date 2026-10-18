import { beforeEach, describe, expect, it, vi } from 'vitest';
import { propertyPresets } from '@platform/tauri/client/properties';
import { notebooks, notes } from '@platform/tauri/client';
import { compareAndPatchDocumentProperties, removeDocumentProperty } from '@features/document/public/path-properties';
import { usePropertyPresetStore, persistPropertyRegistry } from './property-preset-store';
import { bindTablePresetsFromSnapshot, migrateNotePropertyKey, removeNoteProperty, updatePresetFromTable } from './property-preset-service';
import { createTableDocument, parseTableDocument, serializeTableDocument } from '@features/multidimensional-table/model';
import { hydrateTablePresets, tableFieldFromPreset } from '@features/multidimensional-table/table-preset-bindings';
import { patchDocumentProperties } from '@features/document/public/path-properties';
import { resolvePropertyType } from '@features/document/properties/property-type';
import { parseDocument } from 'yaml';
import type { PropertyFieldConfig } from '@/lib/constants';

vi.mock('@platform/tauri/client/properties', () => ({ propertyPresets: { get: vi.fn(), patch: vi.fn() } }));
vi.mock('@platform/tauri/client', () => ({
  externalDocuments: { read: vi.fn(), write: vi.fn() },
  collections: { list: vi.fn() },
  notebooks: { getAll: vi.fn() },
  notes: { list: vi.fn() },
}));
vi.mock('@features/document/public/path-properties', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@features/document/public/path-properties')>()),
  compareAndPatchDocumentProperties: vi.fn(),
  removeDocumentProperty: vi.fn(),
}));

const preset: PropertyFieldConfig = {
  id: 'fld_' + 'a'.repeat(32), key: 'topics', type: 'Tag', revision: 3, position: 0,
};
const table = () => {
  const document = createTableDocument();
  document.dataset.schema.preset_fields = [];
  document.dataset.schema.fields.push(tableFieldFromPreset(preset));
  document.dataset.schema.field_order.push(preset.id!);
  document.views.items[0]!.config.visible_fields = document.dataset.schema.field_order;
  return document;
};
beforeEach(() => {
  vi.clearAllMocks();
  usePropertyPresetStore.setState({ registry: { fields: [{ ...preset }], systemFields: [], deletedFields: [] }, loaded: true });
});

describe('DB-owned property presets and local table edits', () => {
  it('sends only the changed ID instead of replacing an entire cached registry', async () => {
    const untouched = { ...preset, id: 'fld_' + 'b'.repeat(32), key: 'other', position: 1 };
    usePropertyPresetStore.setState({ registry: { fields: [preset, untouched] } });
    vi.mocked(propertyPresets.patch).mockResolvedValue({ fields: [{ ...preset, name: 'Topics', revision: 4 }, untouched] });
    await persistPropertyRegistry([{ ...preset, name: 'Topics' }, untouched]);
    expect(propertyPresets.patch).toHaveBeenCalledWith([
      expect.objectContaining({ scope: 'user', expectedRevision: 3, field: expect.objectContaining({ id: preset.id, name: 'Topics' }) }),
    ]);
  });

  it('ignores newer ordinary file snapshots without modifying the authoritative definition', async () => {
    const document = table();
    document.dataset.schema.fields[1] = { ...document.dataset.schema.fields[1]!, type: 'Text', preset_revision: 999 };
    const bound = await bindTablePresetsFromSnapshot(document);
    expect(bound.dataset.schema.fields[1]?.type).toBe('Tag');
    expect(bound.dataset.schema.fields[1]?.preset_revision).toBe(3);
    expect(propertyPresets.patch).not.toHaveBeenCalled();
  });

  it('preserves a saved local rename when DB synchronization fails, and retries on reopen', async () => {
    const document = table();
    document.dataset.schema.fields[1] = { ...document.dataset.schema.fields[1]!, property_key: 'topics-renamed', preset_pending: true };
    const saved = serializeTableDocument(document);
    vi.mocked(propertyPresets.patch).mockRejectedValue(new Error('DB unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const reopened = await bindTablePresetsFromSnapshot(parseTableDocument(saved));
      expect(reopened.dataset.schema.fields[1]).toMatchObject({ property_key: 'topics-renamed', preset_pending: true });
      expect(propertyPresets.patch).toHaveBeenCalledWith([expect.objectContaining({ expectedRevision: 3 })]);
      vi.mocked(propertyPresets.patch).mockResolvedValue({ fields: [{ ...preset, key: 'topics-renamed', revision: 4 }] });
      const synced = await bindTablePresetsFromSnapshot(reopened);
      expect(synced.dataset.schema.fields[1]).toMatchObject({ property_key: 'topics-renamed', preset_revision: 4 });
      expect(synced.dataset.schema.fields[1]?.preset_pending).toBeUndefined();
    } finally { warn.mockRestore(); }
  });

  it('moves a renamed key across notes and reports target conflicts', async () => {
    vi.mocked(notebooks.getAll).mockResolvedValue([{ id: 'nb1', path: '/nb1' } as never]);
    vi.mocked(notes.list).mockResolvedValue([
      { relativePath: 'a.md', properties: { topics: ['work'] } },
      { relativePath: 'b.md', properties: { topics: ['life'], 'topics-new': ['x'] } },
      { relativePath: 'c.md', properties: {} },
    ] as never);
    vi.mocked(compareAndPatchDocumentProperties).mockResolvedValue(true);
    const result = await migrateNotePropertyKey('topics', 'topics-new');
    expect(result).toEqual({ moved: 1, failed: 1 });
    expect(compareAndPatchDocumentProperties).toHaveBeenCalledWith(
      '/nb1/a.md',
      expect.objectContaining({ topics: { exists: true, value: ['work'] }, 'topics-new': { exists: false } }),
      expect.objectContaining({ topics: { exists: false, value: undefined }, 'topics-new': { exists: true, value: ['work'] } }),
    );
  });

  it('removes a deleted property from every note that carries it', async () => {
    vi.mocked(notebooks.getAll).mockResolvedValue([{ id: 'nb1', path: '/nb1' } as never]);
    vi.mocked(notes.list).mockResolvedValue([
      { relativePath: 'a.md', properties: { topics: ['work'] } },
      { relativePath: 'b.md', properties: { other: 1 } },
    ] as never);
    vi.mocked(removeDocumentProperty).mockResolvedValue(true);
    const result = await removeNoteProperty('topics');
    expect(result).toEqual({ moved: 1, failed: 0 });
    expect(removeDocumentProperty).toHaveBeenCalledWith('/nb1/a.md', 'topics');
  });

  it('does not discard a local snapshot on a stale-version conflict', async () => {
    const field = { ...tableFieldFromPreset(preset), property_key: 'topics-renamed', preset_revision: 2, preset_pending: true };
    vi.mocked(propertyPresets.patch).mockRejectedValue(new Error('属性预设已被修改'));
    await expect(updatePresetFromTable(field, { ...preset, key: 'topics-renamed' })).rejects.toThrow('已被修改');
    expect(field.property_key).toBe('topics-renamed');
    expect(propertyPresets.patch).toHaveBeenCalledWith([expect.objectContaining({ expectedRevision: 2 })]);
  });

  it('allows editing options on a system Select preset while preserving its fixed identity', async () => {
    const systemPreset: PropertyFieldConfig = {
      id: 'fld_' + 'c'.repeat(32), key: 'status', name: '状态', type: 'Select', revision: 4,
      options: [{ id: 'opt_' + 'a'.repeat(32), label: '待办' }],
    };
    usePropertyPresetStore.setState({ registry: { fields: [], systemFields: [systemPreset], deletedFields: [] }, loaded: true });
    vi.mocked(propertyPresets.patch).mockResolvedValue({ fields: [], systemFields: [{ ...systemPreset, revision: 5 }] });
    const field = { ...tableFieldFromPreset(systemPreset), preset_revision: 4 };

    await updatePresetFromTable(field, {
      ...systemPreset,
      name: undefined,
      options: [{ id: 'opt_' + 'b'.repeat(32), label: '进行中' }],
    });

    expect(propertyPresets.patch).toHaveBeenCalledWith([expect.objectContaining({
      scope: 'system', expectedRevision: 4,
      field: expect.objectContaining({ id: systemPreset.id, key: 'status', type: 'Select', options: [{ id: 'opt_' + 'b'.repeat(32), label: '进行中' }] }),
    })]);
  });

  it('hides a retired field but preserves its note value and type on the next note save', () => {
    const document = table();
    usePropertyPresetStore.setState({ registry: { fields: [], deletedFields: [preset] } });
    expect(hydrateTablePresets(document).dataset.schema.fields).toHaveLength(1);
    expect(resolvePropertyType('topics', ['work']).kind).toBe('Tag');
    const content = patchDocumentProperties('---\ntopics: [work]\n---\nBody', { other: 'value' });
    const properties = parseDocument(content.split('---')[1]!).toJS();
    expect(properties.topics).toEqual(['work']);
    expect(properties.flowix_property_types.topics).toBe('Tag');
  });
});
