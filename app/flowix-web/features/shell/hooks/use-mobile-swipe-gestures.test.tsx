import { act, createElement, type ReactNode, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { useMobileSwipeGestures } from './use-mobile-swipe-gestures';

interface SwipeCallbacks {
  onSwipeDown: Mock<() => void>;
  onSwipeRight: Mock<() => void>;
  onSwipeLeft: Mock<() => void>;
}

// jsdom 无布局引擎: scrollWidth/clientWidth 恒为 0, 计算样式也拿不到样式表
// 规则。用属性覆盖 + getComputedStyle stub 模拟 "横向可滚动区域"。
const overflowXByElement = new Map<Element, string>();

function Host(props: {
  targetRef: RefObject<HTMLDivElement | null>;
  callbacks: SwipeCallbacks;
  children?: ReactNode;
}) {
  useMobileSwipeGestures({
    enabled: true,
    targetRef: props.targetRef,
    onSwipeDown: props.callbacks.onSwipeDown,
    onSwipeRight: props.callbacks.onSwipeRight,
    onSwipeLeft: props.callbacks.onSwipeLeft,
  });
  return createElement('div', { ref: props.targetRef, 'data-testid': 'gesture-target' }, props.children);
}

type TouchKind = 'touchstart' | 'touchmove' | 'touchend';

function fireTouch(target: Element, kind: TouchKind, x: number, y: number): TouchEvent {
  const event = new Event(kind, { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperty(event, 'touches', {
    value: [{ identifier: 1, target, clientX: x, clientY: y } as unknown as Touch],
  });
  target.dispatchEvent(event);
  return event;
}

function swipeLeft(from: Element): TouchEvent[] {
  fireTouch(from, 'touchstart', 200, 100);
  const moves = [fireTouch(from, 'touchmove', 160, 100), fireTouch(from, 'touchmove', 90, 100)];
  fireTouch(from, 'touchend', 90, 100);
  return moves;
}

function swipeRight(from: Element): TouchEvent[] {
  fireTouch(from, 'touchstart', 100, 100);
  const moves = [fireTouch(from, 'touchmove', 140, 100), fireTouch(from, 'touchmove', 210, 100)];
  fireTouch(from, 'touchend', 210, 100);
  return moves;
}

describe('useMobileSwipeGestures', () => {
  let container: HTMLElement;
  let root: Root | null = null;
  let targetRef: RefObject<HTMLDivElement | null>;

  beforeEach(() => {
    overflowXByElement.clear();
    vi.stubGlobal('getComputedStyle', (element: Element): CSSStyleDeclaration => ({
      overflowX: overflowXByElement.get(element) ?? 'visible',
    } as CSSStyleDeclaration));
    container = document.createElement('div');
    document.body.appendChild(container);
    targetRef = { current: null };
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    vi.unstubAllGlobals();
  });

  function mount(children?: ReactNode): SwipeCallbacks {
    const callbacks: SwipeCallbacks = {
      onSwipeDown: vi.fn(),
      onSwipeRight: vi.fn(),
      onSwipeLeft: vi.fn(),
    };
    root = createRoot(container);
    act(() => {
      root?.render(createElement(Host, { targetRef, callbacks }, children));
    });
    return callbacks;
  }

  function mountScrollableChild(overflowX = 'auto'): {
    callbacks: SwipeCallbacks;
    wrapper: HTMLElement;
  } {
    const callbacks = mount(createElement('div', { 'data-testid': 'table-wrap' }));
    const wrapper = targetRef.current!.querySelector('[data-testid="table-wrap"]') as HTMLElement;
    Object.defineProperty(wrapper, 'scrollWidth', { value: 900, configurable: true });
    Object.defineProperty(wrapper, 'clientWidth', { value: 300, configurable: true });
    overflowXByElement.set(wrapper, overflowX);
    return { callbacks, wrapper };
  }

  it('横向可滚动区域 (宽表格) 内左右滑不触发挥手, 也不 preventDefault (原生平移)', () => {
    const { callbacks, wrapper } = mountScrollableChild();

    const leftMoves = swipeLeft(wrapper);
    expect(callbacks.onSwipeLeft).not.toHaveBeenCalled();
    expect(leftMoves.some((event) => event.defaultPrevented)).toBe(false);

    const rightMoves = swipeRight(wrapper);
    expect(callbacks.onSwipeRight).not.toHaveBeenCalled();
    expect(rightMoves.some((event) => event.defaultPrevented)).toBe(false);
  });

  it('普通区域左右滑仍触发对应挥手', () => {
    const callbacks = mount();
    const target = targetRef.current!;

    swipeLeft(target);
    expect(callbacks.onSwipeLeft).toHaveBeenCalledTimes(1);

    swipeRight(target);
    expect(callbacks.onSwipeRight).toHaveBeenCalledTimes(1);
  });

  it('布局溢出但 overflow-x 不可手指滚动 (hidden) 时, 挥手照常触发', () => {
    const { callbacks, wrapper } = mountScrollableChild('hidden');

    swipeLeft(wrapper);
    expect(callbacks.onSwipeLeft).toHaveBeenCalledTimes(1);
  });

  it('横向可滚动区域内的下滑手势不受影响', () => {
    const { callbacks, wrapper } = mountScrollableChild();

    fireTouch(wrapper, 'touchstart', 100, 100);
    fireTouch(wrapper, 'touchmove', 101, 200);
    expect(callbacks.onSwipeDown).toHaveBeenCalledTimes(1);
  });
});
