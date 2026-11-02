import { expect, it } from 'vitest';
import { resolveDatasetFilterForLocation } from './dataset-filter-location';
import { matchesMediaCollectionFilter, createMediaLibrary, mediaCollectionFilterForSave } from '../media-library/model';

it('follows a moved folder index without changing conditions or the stored document', () => {
  const filter = { path: 'Old', match: 'any', conditions: [{ field: 'file_name', op: 'contains', value: 'photo' }] };
  const effective = resolveDatasetFilterForLocation(filter, 'folder', '/book/New/.index.yaml', '/book');
  expect(matchesMediaCollectionFilter('New/photo.png', 'image', effective)).toBe(true);
  expect(matchesMediaCollectionFilter('Old/photo.png', 'image', effective)).toBe(false);
  expect(matchesMediaCollectionFilter('New/other.png', 'image', effective)).toBe(false);
  expect(filter.path).toBe('Old');
  expect(resolveDatasetFilterForLocation(filter, 'standalone', '/book/New/file.index.yaml', '/book')).toBe(filter);
});

it('resolves legacy path rules and notebook root locations', () => {
  const filter = { all: [{ field: 'path', op: 'contains', value: 'Old' }], any: [] };
  const effective = resolveDatasetFilterForLocation(filter, 'folder', '/book/New/.index.yaml', '/book');
  expect(matchesMediaCollectionFilter('New/photo.png', 'image', effective)).toBe(true);
  expect(resolveDatasetFilterForLocation({ path: 'Old', match: 'all', conditions: [] }, 'folder', '/book/.index.yaml', '/book')?.path).toBe('');
});

it('checks the latest media filter before replacing it and synchronizes folder paths on save', () => {
  const document = createMediaLibrary('Media');
  const before = document.dataset.filter;
  expect(mediaCollectionFilterForSave(document, { file_name_contains: 'photo' }, '/book/media.index.yaml', '/book')).toMatchObject({ path: null });
  document.dataset.filter = { all: [], any: [{ field: 'file_name', op: 'contains', value: 'external' }] };
  expect(() => mediaCollectionFilterForSave(document, { file_name_contains: 'photo' }, '/book/media.index.yaml', '/book')).toThrow('已取消保存');
  expect(document.dataset.filter.any).toHaveLength(1);
  document.dataset.filter = before;
  document.collection.placement = 'folder';
  expect(mediaCollectionFilterForSave(document, {}, '/book/New/.index.yaml', '/book')).toEqual({ path: 'New', match: 'all', conditions: [] });
});
