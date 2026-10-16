import { act, useEffect } from 'react';
import type { SurfaceState } from '@features/workspace/model/surface-contract';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSurfaceStateView } from './workspace-surface-state-view';

vi.mock('@shared/ui/centered-loading-spinner', () => ({
  CenteredLoadingSpinner: () => <div data-testid="surface-spinner" />,
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const appearance = {
  headerStyle: 'document' as const,
  contentBackground: 'document' as const,
  stateBackground: 'document' as const,
  emptyDecoration: 'none' as const,
};
let host: HTMLDivElement;
let root: Root;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
});

describe('WorkspaceSurfaceStateView', () => {
  it('preserves renderer identity and its effects through loading, failure and retry', async () => {
    host = document.createElement('div');
    root = createRoot(host);
    const mount = vi.fn();
    const dispose = vi.fn();
    function Content() {
      useEffect(() => { mount(); return dispose; }, []);
      return <input defaultValue="draft" />;
    }
    const render = async (state: SurfaceState) => {
      await act(async () => root.render(<WorkspaceSurfaceStateView appearance={appearance} state={state} keepContentMounted>
        <Content />
      </WorkspaceSurfaceStateView>));
    };
    await render({ status: 'ready' });
    const input = host.querySelector('input');
    await render({ status: 'loading', phase: 'content', retainContent: false });
    expect(host.querySelector('input')).toBe(input);
    expect(input!.closest('[inert]')).not.toBeNull();
    await render({ status: 'error', message: { key: 'error.unexpected' } });
    await render({ status: 'loading', phase: 'content', retainContent: true });
    await render({ status: 'ready' });
    expect(host.querySelector('input')).toBe(input);
    expect(input!.closest('[inert]')).toBeNull();
    expect(mount).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
  });
  it('keeps async content mounted beneath a retained loading state', async () => {
    host = document.createElement('div');
    root = createRoot(host);
    await act(async () => root.render(<WorkspaceSurfaceStateView
      appearance={appearance}
      state={{ status: 'loading', phase: 'content', message: { key: 'loading' }, retainContent: true }}>
      <div data-testid="async-content">mounted</div>
    </WorkspaceSurfaceStateView>));

    expect(host.querySelector('[data-testid="async-content"]')?.textContent).toBe('mounted');
    expect(host.querySelector('[data-testid="surface-spinner"]')).not.toBeNull();
  });

  it('shows domain error detail and its retry action in the shared state view', async () => {
    host = document.createElement('div');
    root = createRoot(host);
    const retry = vi.fn();
    await act(async () => root.render(<WorkspaceSurfaceStateView
      appearance={appearance}
      state={{ status: 'error', message: { key: 'error.unexpected', fallbackText: 'artifact missing' },
        actions: [{ id: 'retry', label: { key: 'error.retry' }, enabled: true, run: retry }] }} />));

    expect(host.textContent).toContain('artifact missing');
    await act(async () => host.querySelector('button')?.click());
    expect(retry).toHaveBeenCalledOnce();
  });
});
