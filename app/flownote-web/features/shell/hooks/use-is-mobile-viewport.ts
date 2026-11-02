import { useEffect, useState } from 'react';

/**
 * 手机宽度阈值 (CSS px)。平板上双栏仍可用, 因此只在窄视口切换单栏。
 */
export const MOBILE_VIEWPORT_MAX_WIDTH = 767;

function readIsMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.innerWidth <= MOBILE_VIEWPORT_MAX_WIDTH;
}

/**
 * 窄视口 (手机) 时为 true。shell 据此在「列表」与「文档」之间做单栏切换。
 */
export function useIsMobileViewport(): boolean {
  const [isMobile, setIsMobile] = useState(readIsMobileViewport);

  useEffect(() => {
    const handleResize = () => setIsMobile(readIsMobileViewport());
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return isMobile;
}
