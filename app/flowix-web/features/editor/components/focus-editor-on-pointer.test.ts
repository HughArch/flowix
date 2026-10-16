import { afterEach, expect, it, vi } from 'vitest';
import { focusEditorOnPointer } from './focus-editor-on-pointer';

let root: HTMLDivElement;
afterEach(() => { root?.remove(); vi.restoreAllMocks(); });
function setup(html = '<p>First paragraph</p>') {
  root = document.createElement('div');
  root.contentEditable = 'true';
  // jsdom does not reflect the contentEditable property into this attribute.
  root.setAttribute('contenteditable', 'true');
  root.innerHTML = html;
  document.body.append(root);
  const view = { dom: root, editable: true, hasFocus: () => document.activeElement === root };
  const focus = vi.spyOn(root, 'focus');
  return { view, focus };
}
function press(view: ReturnType<typeof setup>['view'], target: Element, options: MouseEventInit = {}) {
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...options });
  root.addEventListener('mousedown', (e) => focusEditorOnPointer(view, e), { once: true });
  target.dispatchEvent(event);
  return event;
}

it.each(['<p>First paragraph</p>', '<p><br></p><p>Second paragraph</p>'])('pre-focuses visible text hosts without cancelling native selection: %s', (html) => {
  const { view, focus } = setup(html);
  const event = press(view, root.querySelector('p')!);
  expect(focus).toHaveBeenCalledOnce();
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(event.defaultPrevented).toBe(false);
});

it.each(['<div contenteditable="false"><span>Property</span></div>', '<div contenteditable="true"><span>Agent composer</span></div>', '<button><span>Action</span></button>', '<a href="#heading"><span>Link</span></a>'])('leaves nested focus owners untouched: %s', (html) => {
  const { view, focus } = setup(html);
  press(view, root.querySelector('span')!);
  expect(focus).not.toHaveBeenCalled();
});

it('preserves existing focus and read-only/modifier gestures', () => {
  const { view, focus } = setup();
  const paragraph = root.querySelector('p')!;
  press({ ...view, editable: false }, paragraph);
  press(view, paragraph, { button: 2 });
  press(view, paragraph, { metaKey: true });
  expect(focus).not.toHaveBeenCalled();
  root.focus(); focus.mockClear();
  press(view, paragraph);
  expect(focus).not.toHaveBeenCalled();
});
