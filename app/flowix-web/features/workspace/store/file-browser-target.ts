import { canonicalPath } from '@/lib/path';
export type { FileBrowserContext, FileBrowserTarget } from '../model/surface-target';

/** Longest directory-boundary match; preserve filesystem case semantics. */
export function resolveFileBrowserRoot(path: string | null, folders: readonly string[]): string | null {
  if (!path) return null;
  const normalize = (value: string) => {
    const canonical = canonicalPath(value);
    const segments: string[] = [];
    for (const segment of canonical.split('/')) {
      if (segment === '.' || segment === '') continue;
      if (segment === '..') segments.pop();
      else segments.push(segment);
    }
    return `${canonical.startsWith('/') ? '/' : ''}${segments.join('/')}`;
  };
  const normalized = normalize(path);
  return folders.filter((folder) => folder.trim() !== '').map(normalize).filter((folder) => {
    const root = folder.replace(/\/+$/, '') || '/';
    return normalized === root || normalized.startsWith(root === '/' ? '/' : `${root}/`);
  }).sort((a, b) => b.length - a.length)[0] ?? null;
}
