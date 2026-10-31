import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoListViewTab } from '@features/memo/components/memo-list-view-tabs';
import { ListColumnGuideCard } from './list-column-guide-card';

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe('ListColumnGuideCard', () => {
  let host: HTMLDivElement;
  let root: Root;
  let initialView: MemoListViewTab;

  beforeEach(() => {
    localStorage.clear();
    initialView = 'cards';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('wraps through all pages and offers Get Started after every page was visited', async () => {
    function Harness() {
      const [activeView, setActiveView] = useState(initialView);
      return <ListColumnGuideCard activeView={activeView} onViewChange={setActiveView} />;
    }

    await act(async () => root.render(<Harness />));
    expect(host.textContent).toContain('memo.guide.notes.title');

    const activate = async (label: string) => {
      const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
        .find((candidate) => candidate.textContent?.includes(label));
      expect(button).toBeDefined();
      await act(async () => {
        button!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
        button!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail: 1 }));
      });
    };

    // 三页向导（folders → conversations → cards）：selectPage 会把目标页一并
    // 记为已访问，从 cards 出发两次 next 后三页全部看遍，「完成」才出现。
    await activate('memo.guide.next');
    expect(host.textContent).toContain('memo.guide.fileTree.title');

    await activate('memo.guide.next');
    expect(host.textContent).toContain('memo.guide.conversations.title');
    expect(host.textContent).toContain('memo.guide.done');

    await activate('memo.guide.done');
    expect(host.querySelector('[aria-label="memo.guide.ariaLabel"]')).toBeNull();
  });
});
