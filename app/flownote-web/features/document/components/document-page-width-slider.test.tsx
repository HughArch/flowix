import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentPageWidthSlider } from './document-page-width-slider';

const mocks = vi.hoisted(() => ({ setPageWidthScale: vi.fn(), pageWidthScale: 75 }));
vi.mock('@/lib/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@features/preferences/public/page-width-api', () => ({
  useEditorPageWidthScale: () => ({
    pageWidthScale: mocks.pageWidthScale,
    setPageWidthScale: mocks.setPageWidthScale,
  }),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.pageWidthScale = 75;
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(<DocumentPageWidthSlider />));
});
afterEach(async () => { await act(async () => root.unmount()); });

function slider(): HTMLInputElement {
  const element = container.querySelector<HTMLInputElement>('input[type="range"]');
  if (!element) throw new Error('page width slider not rendered');
  return element;
}

describe('DocumentPageWidthSlider', () => {
  it('renders the current scale with the supported range', () => {
    expect(container.textContent).toContain('75%');
    expect(slider().value).toBe('75');
    expect(slider().min).toBe('50');
    expect(slider().max).toBe('100');
  });

  it('writes the selected scale through the settings API', async () => {
    await act(async () => {
      const element = slider();
      // React tracks the previous value on the DOM node; go through the
      // prototype setter so the synthetic change event is not swallowed.
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(element, '60');
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(mocks.setPageWidthScale).toHaveBeenCalledWith(60);
  });
});
