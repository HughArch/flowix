export type MessageDisposer = () => void;

const messageDisposers = new WeakMap<HTMLElement, Set<MessageDisposer>>();

export function registerMessageDisposer(
  element: HTMLElement,
  disposer: MessageDisposer,
): void {
  let disposers = messageDisposers.get(element);
  if (!disposers) {
    disposers = new Set();
    messageDisposers.set(element, disposers);
  }
  disposers.add(disposer);
}

/** Dispose listeners/observers owned by a message subtree before removing it. */
export function disposeAgentThreadCardMessageTree(root: Node): void {
  if (!(root instanceof HTMLElement)) return;
  for (const child of Array.from(root.children)) {
    disposeAgentThreadCardMessageTree(child);
  }
  const disposers = messageDisposers.get(root);
  if (!disposers) return;
  messageDisposers.delete(root);
  for (const dispose of disposers) dispose();
  disposers.clear();
}
