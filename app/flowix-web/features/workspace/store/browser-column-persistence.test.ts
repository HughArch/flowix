import { beforeEach, expect, it } from 'vitest';
import { restoreBrowserColumnSession } from './browser-column-persistence';
import { BROWSER_COLUMN_DEFAULT_SPLIT_RATIO } from '../model/browser-column-layout';
import type { BrowserColumnSessionState, BrowserColumnTab } from '../model/browser-column-tab';

const current: BrowserColumnSessionState = { visible: false, splitRatio: BROWSER_COLUMN_DEFAULT_SPLIT_RATIO, tabs: [], activeTabId: null };
const tab = (id: string, url: string): BrowserColumnTab => ({ id, title: id, icon: null, target: { kind: 'web', url } });
beforeEach(() => localStorage.removeItem('flowix.workspace.fourth-column.split-ratio'));

it('keeps the default ratio when there is no legacy value, and migrates a valid legacy value', () => {
  expect(restoreBrowserColumnSession(undefined, current).splitRatio).toBe(BROWSER_COLUMN_DEFAULT_SPLIT_RATIO);
  expect(restoreBrowserColumnSession({}, current).splitRatio).toBe(BROWSER_COLUMN_DEFAULT_SPLIT_RATIO);
  localStorage.setItem('flowix.workspace.fourth-column.split-ratio', '');
  expect(restoreBrowserColumnSession({}, current).splitRatio).toBe(BROWSER_COLUMN_DEFAULT_SPLIT_RATIO);
  localStorage.setItem('flowix.workspace.fourth-column.split-ratio', '0.6');
  expect(restoreBrowserColumnSession({}, current).splitRatio).toBe(0.6);
});

it('deduplicates target and tab identities even after replacing a duplicate with the active entry', () => {
  const restored = restoreBrowserColumnSession({ visible: true, activeTabId: 'active', tabs: [
    tab('first', 'https://one.example/'),
    tab('active', 'https://one.example/'),
    tab('active', 'https://two.example/'),
    tab('last', 'https://last.example/'),
  ] }, current);
  expect(restored.tabs.map((tab) => tab.id)).toEqual(['active', 'last']);
  expect(restored.activeTabId).toBe('active');
  expect(new Set(restored.tabs.map((tab) => tab.id)).size).toBe(restored.tabs.length);
});

it('drops malformed targets and recovers selection without changing the surviving order', () => {
  const restored = restoreBrowserColumnSession({ visible: true, activeTabId: 'invalid', tabs: [
    tab('second', 'https://two.example/'),
    { ...tab('invalid', 'https://invalid.example/'), target: { kind: 'unknown' } },
    tab('first', 'https://one.example/'),
  ] }, current);
  expect(restored.tabs.map((tab) => tab.id)).toEqual(['second', 'first']);
  expect(restored.activeTabId).toBe('second');
});

it('ignores an incomplete collection identity while retaining the recoverable file address', () => {
  const restored = restoreBrowserColumnSession({ activeTabId: 'table', tabs: [{
    id: 'table', title: 'Table', icon: null,
    target: { kind: 'file-browser', activeFilePath: '/book/example.table.yaml', notebookId: 'book',
      collectionDisplay: { notebookId: 'book', collectionId: '', displayId: 'display' } },
  }] }, current);
  expect(restored.tabs[0].target).toMatchObject({ kind: 'file-browser', activeFilePath: '/book/example.table.yaml' });
  expect('collectionDisplay' in restored.tabs[0].target).toBe(false);
});
