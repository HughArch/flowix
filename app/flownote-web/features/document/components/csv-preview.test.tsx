import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurfaceLifecycle } from '@features/workspace/public/surface-api';
import type { SurfacePresentationUpdate } from '@features/workspace/public/surface-api';
import { CsvPreview } from './csv-preview';
import type { CellComponent, ColumnComponent, ColumnDefinition } from 'tabulator-tables';

type TableOptions = { columns: ColumnDefinition[]; data: Record<string, unknown>[] };

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), addColumn: vi.fn(), options: null as TableOptions | null }));
vi.mock('@platform/tauri/client/memos', () => ({ externalDocuments: { read: mocks.read, write: mocks.write } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('tabulator-tables', () => ({ TabulatorFull: class {
  constructor(public element: HTMLElement, options: TableOptions) { mocks.options = options; }
  on() {}
  destroy() {}
  addColumn() { return mocks.addColumn(); }
} }));

let root: Root;
let host: HTMLDivElement;
let lifecycle: SurfaceLifecycle | null;
const register = (value: SurfaceLifecycle | null) => { lifecycle = value; };
let nextPath = 0;
let path: string;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function edit(value: string) {
  mocks.options!.columns.find((column) => column.field === 'c0')!.cellEdited!({
    getRow: () => ({ getData: () => ({ _rowId: 1 }) }),
    getField: () => 'c0', getValue: () => value,
  } as unknown as CellComponent);
}
async function mount(reportPresentation?: (update: SurfacePresentationUpdate) => void) {
  await act(async () => root.render(<CsvPreview filePath={path} scopePath="/book" onSurfaceLifecycleReady={register} reportPresentation={reportPresentation} />));
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue('header\noriginal');
  vi.stubGlobal('Worker', class {
    onmessage: ((event: unknown) => void) | null = null;
    postMessage({ id }: { id: number }) {
      this.onmessage?.({ data: { id, kind: 'parsed', data: { headers: ['header'], rows: [['original']], delimiter: ',' } } });
    }
    terminate() {}
  });
  path = `/book/lifecycle-${++nextPath}.csv`;
  host = document.createElement('div');
  root = createRoot(host);
  lifecycle = null;
  await mount();
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('CSV surface save barrier', () => {
  it('publishes load failure and retries through the shared surface action', async () => {
    await act(async () => root.unmount());
    root = createRoot(host);
    mocks.read.mockReset().mockRejectedValue(new Error('file is unavailable'));
    const updates: SurfacePresentationUpdate[] = [];
    await mount((update) => updates.push(update));

    const errors = updates.filter((update) => update.state?.status === 'error');
    const error = errors[errors.length - 1];
    expect(error?.title).toBe(path.split('/').pop());
    expect(error?.state?.status).toBe('error');
    if (error?.state?.status !== 'error') throw new Error('expected published CSV load error');
    const retry = error.state.actions?.find((action) => action.id === 'retry');
    expect(retry).toBeDefined();
    await act(async () => retry?.run());
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(updates.some((update) => update.state?.status === 'loading')).toBe(true);
  });

  it('waits for an asynchronous column edit before writing its new content', async () => {
    const addColumn = deferred<void>();
    mocks.addColumn.mockReturnValueOnce(addColumn.promise);
    mocks.write.mockImplementation(async ({ content }: { content: string }) => ({ status: 'saved', content }));
    act(() => mocks.options!.columns.find((column) => column.field === '_csvAction')!.headerClick!(
      new MouseEvent('click'), {} as ColumnComponent,
    ));
    const flush = lifecycle!.flush!();
    expect(mocks.write).not.toHaveBeenCalled();
    await act(async () => addColumn.resolve());
    await expect(flush).resolves.toBe(true);
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ content: 'header,\noriginal,' }));
  });

  it('waits for an ongoing write and revisions edited while that write is pending', async () => {
    const first = deferred<{ status: 'saved'; content: string }>();
    const second = deferred<{ status: 'saved'; content: string }>();
    mocks.write.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await act(async () => edit('first'));
    const flush = lifecycle!.flush!();
    let finished = false;
    void flush.then(() => { finished = true; });
    await act(async () => edit('second'));
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(finished).toBe(false);
    await act(async () => first.resolve({ status: 'saved', content: 'header\nfirst' }));
    expect(mocks.write).toHaveBeenCalledTimes(2);
    expect(mocks.write).toHaveBeenLastCalledWith(expect.objectContaining({
      content: 'header\nsecond', expectedContent: 'header\nfirst',
    }));
    expect(finished).toBe(false);
    await act(async () => second.resolve({ status: 'saved', content: 'header\nsecond' }));
    await expect(flush).resolves.toBe(true);
  });

  it('rejects navigation on conflict and restores the unsaved draft on remount', async () => {
    const write = deferred<{ status: 'conflict'; diskContent: string }>();
    mocks.write.mockReturnValue(write.promise);
    await act(async () => edit('draft'));
    const flush = lifecycle!.flush!();
    await act(async () => write.resolve({ status: 'conflict', diskContent: 'header\nother' }));
    await expect(flush).resolves.toBe(false);
    await act(async () => root.unmount());
    expect(lifecycle).toBeNull();
    root = createRoot(host);
    await mount();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.options!.data[1].c0).toBe('draft');
  });
});
