import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useImportNotebookSelection } from './use-import-notebook-selection';

type Props = {
  requestId: number | undefined;
  notebooks: { id: string }[];
  currentNotebookId?: string;
};
let root: Root;
let host: HTMLDivElement;
let selection: ReturnType<typeof useImportNotebookSelection>;
function Harness(props: Props) {
  selection = useImportNotebookSelection(props.requestId, props.notebooks, props.currentNotebookId);
  return <span>{selection[0]}</span>;
}
async function render(props: Props) {
  await act(async () => root.render(<Harness {...props} />));
}
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it('keeps a manual destination across notebook refreshes and current-notebook changes', async () => {
  await render({ requestId: 1, notebooks: [{ id: 'a' }, { id: 'b' }], currentNotebookId: 'a' });
  expect(selection[0]).toBe('a');
  await act(async () => selection[1]('b'));
  await render({ requestId: 1, notebooks: [{ id: 'b' }, { id: 'a' }], currentNotebookId: 'a' });
  expect(selection[0]).toBe('b');
  await render({ requestId: 1, notebooks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], currentNotebookId: 'c' });
  expect(selection[0]).toBe('b');
});

it('defaults each new batch to the current notebook instead of retaining the previous batch choice', async () => {
  const notebooks = [{ id: 'a' }, { id: 'b' }];
  await render({ requestId: 1, notebooks, currentNotebookId: 'a' });
  await act(async () => selection[1]('b'));
  await render({ requestId: 2, notebooks, currentNotebookId: 'a' });
  expect(selection[0]).toBe('a');
});

it('falls back only when the chosen notebook has been removed', async () => {
  await render({ requestId: 1, notebooks: [{ id: 'a' }, { id: 'b' }], currentNotebookId: 'a' });
  await act(async () => selection[1]('b'));
  await render({ requestId: 1, notebooks: [{ id: 'a' }], currentNotebookId: 'a' });
  expect(selection[0]).toBe('a');
  await render({ requestId: 1, notebooks: [{ id: 'c' }], currentNotebookId: 'a' });
  expect(selection[0]).toBe('c');
});

it('handles delayed notebook loading and clearing the active batch', async () => {
  await render({ requestId: 1, notebooks: [], currentNotebookId: 'b' });
  expect(selection[0]).toBe('');
  await render({ requestId: 1, notebooks: [{ id: 'a' }, { id: 'b' }], currentNotebookId: 'b' });
  expect(selection[0]).toBe('b');
  await render({ requestId: undefined, notebooks: [{ id: 'a' }, { id: 'b' }], currentNotebookId: 'a' });
  expect(selection[0]).toBe('');
});
