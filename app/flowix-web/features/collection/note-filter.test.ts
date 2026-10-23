import { describe, expect, it } from 'vitest';
import { readNoteFilterDraft, resolveNoteFilterDraft } from './note-filter-draft';
import { compileNoteFilter, normalizeNoteFilterCondition, noteFilterTitleQuery } from './note-filter';
import { NOTE_TITLE_FIELD_ID } from './note-filter-fields';
import { noteMatchesCollectionFilter } from './note-filter-matcher';

const title = { field_id: NOTE_TITLE_FIELD_ID, operator: 'contains' as const, value: '发布' };
const status = { field_id: 'status', operator: 'equals' as const, value: 'ready' };

describe('shared note filter contract', () => {
  it('uses all by default and preserves explicit legacy union/intersection', () => {
    for (const condition of [{}, { property_match: 'union' as const }, { property_match: 'intersection' as const }]) {
      expect(compileNoteFilter(condition).match).toBe(normalizeNoteFilterCondition(condition).match);
    }
    expect(compileNoteFilter({}).match).toBe('all');
    expect(compileNoteFilter({ property_match: 'union' }).match).toBe('any');
  });

  it('normalizes once without retaining blank draft rows or legacy path fields', () => {
    const normalized = normalizeNoteFilterCondition({ property_match: 'union',
      property_conditions: [title, { ...status, value: ' ' }],
      file_condition: { path_contains: '/项目/', file_name_contains: ' release ' },
    });
    expect(normalizeNoteFilterCondition(normalized)).toEqual(normalized);
    expect(normalized).toEqual({ match: 'any', path: '项目', property_conditions: [title],
      file_condition: { file_name_contains: 'release' } });
  });

  it('pushes title conjunctions and complete title disjunctions, preserving mixed OR semantics', () => {
    expect(noteFilterTitleQuery({ match: 'all', property_conditions: [title, status] }))
      .toEqual({ match: 'all', conditions: [{ op: 'contains', value: '发布' }] });
    expect(noteFilterTitleQuery({ match: 'any', property_conditions: [title, status] })).toBeUndefined();
    expect(noteFilterTitleQuery({ match: 'any', property_conditions: [title] })?.match).toBe('any');
  });

  it('matches an indexed filename title without requiring table fields', () => {
    const note = { title: '项目发布', relativePath: '目录/项目发布.md', properties: {}, createdAt: 0, updatedAt: 0 };
    expect(noteMatchesCollectionFilter(note, [], '', compileNoteFilter({ property_conditions: [title] }))).toBe(true);
    expect(noteMatchesCollectionFilter(note, [], '', compileNoteFilter({ property_conditions: [{ ...title, value: '.md' }] }))).toBe(false);
  });
});


it('uses IDs during editing and saving, resolving labels only for explicitly marked legacy drafts', () => {
  const fields = [{ id: 'fld_status', label: 'Status', propertyKey: 'workflow', type: 'Text' as const }];
  const options = [{ value: 'workflow', label: 'Status', type: 'Text' as const }];
  const condition = { property_conditions: [{ field_id: 'Status', operator: 'equals' as const, value: 'ready' }] };
  expect(readNoteFilterDraft('', fields, { condition }, options).property_conditions?.[0].field_id).toBe('Status');
  expect(readNoteFilterDraft('', fields, { condition, field_reference_format: 'legacy-labels' }, options)
    .property_conditions?.[0].field_id).toBe('workflow');
  expect(resolveNoteFilterDraft(condition, fields).property_conditions?.[0].field_id).toBe('Status');
  expect(resolveNoteFilterDraft({ property_conditions: [{ ...condition.property_conditions[0], field_id: 'workflow' }] }, fields)
    .property_conditions?.[0].field_id).toBe('fld_status');
});


it('preserves raw property keys that happen to equal readonly labels', () => {
  const options = [{ value: NOTE_TITLE_FIELD_ID, label: '标题', type: 'Text' as const }];
  const condition = { property_conditions: [{ field_id: '标题', operator: 'equals' as const, value: '内部属性' }] };
  const draft = readNoteFilterDraft('', [], { condition }, options);
  expect(draft.property_conditions?.[0].field_id).toBe('标题');
  const note = { title: '磁盘文件名', relativePath: '磁盘文件名.md', properties: { 标题: '内部属性' }, createdAt: 0, updatedAt: 0 };
  expect(noteMatchesCollectionFilter(note, [], '', compileNoteFilter(resolveNoteFilterDraft(draft, [])))).toBe(true);
  const markedLegacy = readNoteFilterDraft('', [], { condition, field_reference_format: 'legacy-labels' }, options);
  expect(markedLegacy.property_conditions?.[0].field_id).toBe(NOTE_TITLE_FIELD_ID);
});
