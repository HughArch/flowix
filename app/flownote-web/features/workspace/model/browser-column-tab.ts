import type { BrowserColumnTarget } from './browser-column-target';

export interface BrowserColumnTab {
  id: string;
  title: string;
  icon: string | null;
  target: BrowserColumnTarget;
}

export interface BrowserColumnSessionState {
  visible: boolean;
  splitRatio: number;
  tabs: BrowserColumnTab[];
  activeTabId: string | null;
}
