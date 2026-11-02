'use client';

import { useCallback, useRef } from 'react';

// 入场动画使用浏览器 Web Animations API，只作用于新卡片的视觉层。

const ENTRANCE_DURATION = 300;
// 二次缓出。
const ENTRANCE_EASE = 'cubic-bezier(0.22, 0.61, 0.36, 1)';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface PendingInsert {
  newId: string;
  readyToAnimate: boolean;
}

function runEntrance(animEl: HTMLElement) {
  // 取消该元素上已有动画。
  animEl.getAnimations().forEach((animation) => animation.cancel());
  animEl.animate(
    [
      { opacity: 0, transform: 'translateX(-36px) scale(0.985)' },
      { opacity: 1, transform: 'translateX(0) scale(1)' },
    ],
    {
      duration: ENTRANCE_DURATION,
      easing: ENTRANCE_EASE,
    },
  );
}

/**
 * 虚拟列表负责滚动与行定位，入场动画只作用于卡片内的 wrapper。
 * 列表提交后播放一次；若新卡片尚未挂载，则在注册时播放。
 */
export function useMemoInsertAnimation() {
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const pendingRef = useRef<PendingInsert | null>(null);

  const registerCard = useCallback((id: string) => (el: HTMLDivElement | null) => {
    if (el) {
      cardRefs.current.set(id, el);
      if (pendingRef.current?.newId === id && pendingRef.current.readyToAnimate) {
        pendingRef.current = null;
        if (!prefersReducedMotion()) {
          runEntrance((el.querySelector('[data-insert-anim]') as HTMLElement | null) ?? el);
        }
      }
    } else cardRefs.current.delete(id);
  }, []);

  // 虚拟列表负责滚动定位, 此处只记录新卡片的入场请求。
  const prepareForInsert = useCallback((newId: string) => {
    pendingRef.current = { newId, readyToAnimate: false };
  }, []);

  const onListRendered = useCallback((scroller: HTMLElement | null) => {
    const pending = pendingRef.current;
    if (!pending) return;

    // 列表已提交，允许已挂载或随后挂载的新卡片播放动画。
    if (!scroller) return;
    pending.readyToAnimate = true;
    const newEl = cardRefs.current.get(pending.newId);
    if (!newEl) return; // registerCard completes the entrance when it mounts.
    pendingRef.current = null;

    // 优先取 row 内部的 [data-insert-anim] wrapper, 让 transform/x/scale
    // 全部作用在视觉层; 找不到 (旧结构 / 单测 / Storybook) 时退回 row 本身。
    const animEl = (newEl.querySelector('[data-insert-anim]') as HTMLElement | null) ?? newEl;

    if (prefersReducedMotion()) return;

    runEntrance(animEl);
  }, []);

  return { registerCard, prepareForInsert, onListRendered };
}
