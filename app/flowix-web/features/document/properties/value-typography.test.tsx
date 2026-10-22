import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { MultiSelectValueInput } from './multi-select-value-input';
import { SelectValueInput } from './select-value-input';
import { TagValueInput } from './tag-value-input';
import { PropertyValueTypographyContext, propertyValueTypography } from './value-typography';

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

const controls: Array<[string, () => ReactElement]> = [
  ['tag', () => <TagValueInput value={['Work']} onChange={vi.fn()} />],
  ['select', () => <SelectValueInput value="Work" options={['Work']} variant="table" onChange={vi.fn()} />],
  ['multi-select', () => <MultiSelectValueInput value="Work" options={['Work']} variant="table" onChange={vi.fn()} />],
];

for (const baseFontSize of ['var(--font-size, 16px)', 'var(--editor-font-size, 16px)']) {
  it.each(controls)(`preserves table typography in the %s portal with ${baseFontSize}`, async (_name, control) => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const typography = propertyValueTypography(baseFontSize);
    await act(async () => {
      root?.render(
        <PropertyValueTypographyContext.Provider value={typography}>
          <div style={typography}>{control()}</div>
        </PropertyValueTypographyContext.Provider>,
      );
    });
    await act(async () => host?.querySelector('button')?.click());

    const popup = document.querySelector<HTMLElement>('[data-flowix-surface]');
    expect(popup).not.toBeNull();
    expect(host.contains(popup)).toBe(false);
    expect(popup?.style.getPropertyValue('--property-value-base-font-size')).toBe(baseFontSize);
    expect(popup?.style.getPropertyValue('--property-value-font-size')).toBe(
      `calc(${baseFontSize} * var(--document-tag-font-scale, 0.875))`,
    );
  });
}
