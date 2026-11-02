import { expect, it } from 'vitest';
import { renameCollectionFilterField, type CollectionRuleFilter } from './rule-filter';

it('renames raw property references in nested groups, preserving field IDs and rule values', () => {
  const filter: CollectionRuleFilter = {
    all: [{ field: 'status', op: 'eq', value: 'status' }],
    any: [{ all: [{ field: 'fld_stable', op: 'contains', value: 'old' }], any: [{ field: 'status', op: 'eq', value: 'ready' }] }],
  };
  const before = JSON.stringify(filter);
  expect(renameCollectionFilterField(filter, 'status', 'workflow')).toEqual({
    all: [{ field: 'workflow', op: 'eq', value: 'status' }],
    any: [{ all: [{ field: 'fld_stable', op: 'contains', value: 'old' }], any: [{ field: 'workflow', op: 'eq', value: 'ready' }] }],
  });
  expect(JSON.stringify(filter)).toBe(before);
});
