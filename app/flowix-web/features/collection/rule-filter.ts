export interface CollectionRuleFilter {
  all: CollectionRuleEntry[];
  any: CollectionRuleEntry[];
}

export type CollectionRuleEntry = CollectionRuleFilter | { field: string; op: string; value: unknown };

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

export function collectionFilterUsesField(filter: CollectionRuleFilter | null, field: string): boolean {
  if (!filter) return false;
  const uses = (entry: CollectionRuleEntry): boolean => isGroup(entry)
    ? collectionFilterUsesField(entry, field)
    : entry.field === field;
  return [...filter.all, ...filter.any].some(uses);
}

export function renameCollectionFilterField(filter: CollectionRuleFilter, previous: string, next: string): CollectionRuleFilter {
  const rename = (entry: CollectionRuleEntry): CollectionRuleEntry => isGroup(entry)
    ? renameCollectionFilterField(entry, previous, next)
    : entry.field === previous ? { ...entry, field: next } : entry;
  return { ...filter, all: filter.all.map(rename), any: filter.any.map(rename) };
}
