import { canonicalPath } from './path';

export interface CollectionDisplayDescriptor {
  notebookId: string;
  collectionId: string;
  viewId: string | null;
  displayId: string;
}
interface DisplayRecord extends CollectionDisplayDescriptor { path: string | null; sequence: number }
const displays = new Map<string, DisplayRecord>();
const pins = new Map<string, number>();
const idsByTarget = new Map<string, string>();
const keyOf = (target: Omit<CollectionDisplayDescriptor, 'displayId'>) => JSON.stringify([target.notebookId, target.collectionId]);

/** One display per collection; viewId is presentation state. Allocate outside render. */
export function ensureCollectionDisplay(target: Omit<CollectionDisplayDescriptor, 'displayId'>, preferredId?: string): CollectionDisplayDescriptor {
  const key = keyOf(target);
  const existingId = idsByTarget.get(key);
  if (existingId) {
    // Older persisted targets allocated an ID per view. Retain those IDs as
    // aliases so mounted/restored surfaces can still resolve their location.
    if (preferredId && preferredId !== existingId) {
      const alias = displays.get(preferredId);
      if (alias && keyOf(alias) !== key) throw new Error('展示 ID 已绑定到另一集合');
      if (!alias) displays.set(preferredId, { ...displays.get(existingId)!, ...target, displayId: preferredId });
    }
    const record = displays.get(existingId)!;
    record.viewId = target.viewId;
    return { ...target, displayId: existingId };
  }
  const displayId = preferredId ?? `display:${crypto.randomUUID()}`;
  const existing = displays.get(displayId);
  if (existing && keyOf(existing) !== key) throw new Error('展示 ID 已绑定到另一集合');
  const record = { ...target, displayId, path: null, sequence: -1 };
  idsByTarget.set(key, displayId);
  displays.set(displayId, record);
  return { ...target, displayId };
}
export function bindCollectionDisplayPath(displayId: string, path: string, sequence?: number): boolean {
  const record = displays.get(displayId);
  if (!record || (sequence !== undefined && sequence < record.sequence)) return false;
  record.path = canonicalPath(path);
  if (sequence !== undefined) record.sequence = sequence;
  return true;
}
export function findCollectionDisplayPath(displayId: string): string | null {
  return displays.get(displayId)?.path ?? null;
}
export function collectionDisplays(notebookId?: string, collectionId?: string): CollectionDisplayDescriptor[] {
  return [...displays.values()].filter((record) => (!notebookId || record.notebookId === notebookId) && (!collectionId || record.collectionId === collectionId));
}
export function reconcileCollectionDisplays(retained: Iterable<CollectionDisplayDescriptor>): void {
  const ids = new Set<string>();
  for (const descriptor of retained) {
    const canonical = ensureCollectionDisplay(descriptor, descriptor.displayId);
    ids.add(descriptor.displayId);
    ids.add(canonical.displayId);
  }
  for (const [id, record] of displays) {
    if (!ids.has(id) && !pins.has(id)) { displays.delete(id); if (idsByTarget.get(keyOf(record)) === id) idsByTarget.delete(keyOf(record)); }
  }
}

export function pinCollectionDisplay(displayId: string): (() => void) | null {
  if (!displays.has(displayId)) return null;
  pins.set(displayId, (pins.get(displayId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (pins.get(displayId) ?? 1) - 1;
    if (count > 0) pins.set(displayId, count); else pins.delete(displayId);
  };
}

export function collectionDisplayDescriptor(displayId: string): CollectionDisplayDescriptor | null {
  const record = displays.get(displayId);
  return record ? { notebookId: record.notebookId, collectionId: record.collectionId, viewId: record.viewId, displayId } : null;
}
