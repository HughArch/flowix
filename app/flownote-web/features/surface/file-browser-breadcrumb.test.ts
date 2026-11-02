import { describe, expect, it } from 'vitest';
import {
  resolveFileBrowserBreadcrumbItems,
  resolveFileBrowserBreadcrumbs,
} from './file-browser-breadcrumb';

describe('resolveFileBrowserBreadcrumbs', () => {
  it('uses the root directory name and relative file path', () => {
    expect(resolveFileBrowserBreadcrumbs(
      '/Users/rop/Desktop/vibe/flownote-main',
      '/Users/rop/Desktop/vibe/flownote-main/app/src/index.ts',
    )).toEqual(['flownote-main', 'app', 'src', 'index.ts']);
  });

  it('normalizes Windows separators', () => {
    expect(resolveFileBrowserBreadcrumbs(
      'C:\\work\\flownote-main',
      'C:\\work\\flownote-main\\app\\src\\index.ts',
    )).toEqual(['flownote-main', 'app', 'src', 'index.ts']);
  });

  it('shows only the root before a file is selected', () => {
    expect(resolveFileBrowserBreadcrumbs('/workspace/flownote-main', null))
      .toEqual(['flownote-main']);
  });

  it('keeps the exact folder path for each clickable breadcrumb', () => {
    expect(resolveFileBrowserBreadcrumbItems(
      '/workspace/flownote-main',
      '/workspace/flownote-main/app/src/index.ts',
    )).toEqual([
      { label: 'flownote-main', path: '/workspace/flownote-main', type: 'folder' },
      { label: 'app', path: '/workspace/flownote-main/app', type: 'folder' },
      { label: 'src', path: '/workspace/flownote-main/app/src', type: 'folder' },
      { label: 'index.ts', path: '/workspace/flownote-main/app/src/index.ts', type: 'file' },
    ]);
  });
});
