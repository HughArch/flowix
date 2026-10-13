import { ensureCollectionDisplay, type CollectionDisplayDescriptor } from '@/lib/collection-display-registry';
import { useWorkColumnStore } from '../store/work-column-store';
import { useWorkspaceRestoreStore } from '../store/workspace-restore-store';
import { useBrowserColumnStore } from '../store/browser-column-store';

/** Update presentation state in place. Never start navigation or reload data. */
export function setCollectionActiveView(
  location: { host: 'main-third' } | { host: 'browser-column'; tabId: string },
  expected: Pick<CollectionDisplayDescriptor, 'notebookId' | 'collectionId'>,
  viewId: string | null,
): boolean {
  const matches = (target: Pick<CollectionDisplayDescriptor, 'notebookId' | 'collectionId'>) =>
    target.notebookId === expected.notebookId && target.collectionId === expected.collectionId;
  if (location.host === 'main-third') {
    const state = useWorkColumnStore.getState();
    const target = state.navigation.target;
    if (state.navigation.phase === 'loading' || target.kind !== 'collection' || !matches(target)) return false;
    if (target.unavailableReason && target.unavailableReason !== '此视图已不存在，请重新选择视图') return false;
    if (target.viewId === viewId) return true;
    ensureCollectionDisplay({ ...target, viewId }, target.displayId);
    const { unavailableReason: _reason, ...rest } = target;
    const next = { ...rest, viewId };
    useWorkColumnStore.setState({ navigation: { ...state.navigation, target: next } });
    useWorkspaceRestoreStore.getState().setDesiredTarget(next);
    return true;
  }
  const state = useBrowserColumnStore.getState();
  const tab = state.tabs.find((candidate) => candidate.id === location.tabId);
  if (tab?.target.kind !== 'file-browser' || !tab.target.collectionDisplay || !matches(tab.target.collectionDisplay)) return false;
  if (tab.target.collectionUnavailableReason && tab.target.collectionUnavailableReason !== '此视图已不存在，请重新选择视图') return false;
  if (tab.target.collectionDisplay.viewId === viewId) return true;
  ensureCollectionDisplay({ ...tab.target.collectionDisplay, viewId }, tab.target.collectionDisplay.displayId);
  const target = tab.target;
  useBrowserColumnStore.setState({ tabs: state.tabs.map((candidate) => candidate.id === tab.id
    ? { ...tab, target: { ...target, collectionDisplay: { ...target.collectionDisplay!, viewId }, collectionUnavailableReason: undefined } }
    : candidate) });
  return true;
}
