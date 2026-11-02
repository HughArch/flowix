import { useCallback, useEffect, useState } from 'react';

type UseResizablePanelsOptions = {
  documentPanelMinWidth: number;
  layoutWidth: number;
  memoListVisible: boolean;
  noteNavigationWidth: number;
};

const MEMO_LIST_DEFAULT_WIDTH = 320;
const MEMO_LIST_MIN_WIDTH = 255;
const MEMO_LIST_MAX_WIDTH = 500;
const PANEL_DIVIDER_WIDTH = 1;

export function useResizablePanels({
  documentPanelMinWidth,
  layoutWidth,
  memoListVisible,
  noteNavigationWidth,
}: UseResizablePanelsOptions) {
  const [memoColWidth, setMemoColWidth] = useState(MEMO_LIST_DEFAULT_WIDTH);
  const [isDraggingListDivider, setIsDraggingListDivider] = useState(false);

  const isMemoListHidden = !memoListVisible;
  const memoListWidth = isMemoListHidden ? 0 : memoColWidth;

  const visibleDividerWidth =
    (noteNavigationWidth > 0 ? PANEL_DIVIDER_WIDTH : 0) +
    (!isMemoListHidden ? PANEL_DIVIDER_WIDTH : 0);
  const sidePanelsAvailableWidth = Math.max(
    0,
    layoutWidth - noteNavigationWidth - documentPanelMinWidth - visibleDividerWidth,
  );

  const getMemoListMaxWidth = useCallback(() => (
    Math.min(
      MEMO_LIST_MAX_WIDTH,
      Math.max(MEMO_LIST_MIN_WIDTH, sidePanelsAvailableWidth),
    )
  ), [sidePanelsAvailableWidth]);

  const clampMemoListWidth = useCallback((width: number) => (
    Math.min(getMemoListMaxWidth(), Math.max(MEMO_LIST_MIN_WIDTH, width))
  ), [getMemoListMaxWidth]);

  useEffect(() => {
    setMemoColWidth((width) => clampMemoListWidth(width));
  }, [clampMemoListWidth]);

  const resizeMemoList = useCallback((width: number) => {
    setMemoColWidth(clampMemoListWidth(width));
  }, [clampMemoListWidth]);

  return {
    resizeMemoList,
    setIsDraggingListDivider,
    isDraggingListDivider,
    isMemoListHidden,
    memoColWidth,
    memoListWidth,
  };
}
