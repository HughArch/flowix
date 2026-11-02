export interface CollectionRuleFilter {
  all: CollectionRuleEntry[];
  any: CollectionRuleEntry[];
}

export type CollectionRuleEntry = CollectionRuleFilter | { field: string; op: string; value: unknown };

export interface DatasetRuleFilter {
  /** Mandatory notebook-relative directory prefix; null means no extra path restriction. */
  path: string | null;
  match: 'all' | 'any';
  conditions: Array<{ field: string; op: string; value: unknown }>;
}

export type DatasetFilter = CollectionRuleFilter | DatasetRuleFilter;

function isGroup(entry: CollectionRuleEntry): entry is CollectionRuleFilter {
  return 'all' in entry && 'any' in entry;
}

/** The caller owns field lookup; all/any semantics are identical for notes and media. */
export function matchesCollectionFilter(
  filter: CollectionRuleFilter,
  matchesRule: (rule: Exclude<CollectionRuleEntry, CollectionRuleFilter>) => boolean,
): boolean {
  const matches = (entry: CollectionRuleEntry): boolean => isGroup(entry)
    ? matchesCollectionFilter(entry, matchesRule)
    : matchesRule(entry);
  return filter.all.every(matches) && (filter.any.length === 0 || filter.any.some(matches));
}

/** Dataset paths are mandatory; the remaining rules use one explicit match mode. */
export function matchesDatasetFilter(
  filter: DatasetFilter,
  matchesRule: (rule: { field: string; op: string; value: unknown }) => boolean,
): boolean {
  if ('conditions' in filter && 'match' in filter) {
    const pathMatches = filter.path === null
      || matchesRule({ field: 'path', op: 'contains', value: filter.path });
    if (!pathMatches) return false;
    if (filter.conditions.length === 0) return true;
    return filter.match === 'all'
      ? filter.conditions.every(matchesRule)
      : filter.conditions.some(matchesRule);
  }
  return matchesCollectionFilter(filter, matchesRule as (rule: Exclude<CollectionRuleEntry, CollectionRuleFilter>) => boolean);
}

export function collectionFilterUsesField(filter: DatasetFilter | null, field: string): boolean {
  if (!filter) return false;
  if ('conditions' in filter && 'match' in filter) {
    return filter.conditions.some((rule) => rule.field === field);
  }
  const uses = (entry: CollectionRuleEntry): boolean => isGroup(entry)
    ? collectionFilterUsesField(entry, field)
    : entry.field === field;
  return [...filter.all, ...filter.any].some(uses);
}

export function renameCollectionFilterField<T extends DatasetFilter>(filter: T, previous: string, next: string): T {
  if ('conditions' in filter && 'match' in filter) {
    return { ...filter, conditions: filter.conditions.map((rule) => rule.field === previous ? { ...rule, field: next } : rule) } as T;
  }
  const rename = (entry: CollectionRuleEntry): CollectionRuleEntry => isGroup(entry)
    ? renameCollectionFilterField(entry, previous, next)
    : entry.field === previous ? { ...entry, field: next } : entry;
  return { ...filter, all: filter.all.map(rename), any: filter.any.map(rename) } as T;
}
