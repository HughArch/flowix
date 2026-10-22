/** Keep the container mounted so the shared grid transition can run both ways. */
export function syncFrontmatterVisibility(root: HTMLElement, visible: boolean) {
  root.dataset.visible = String(visible);
  root.inert = !visible;
  root.setAttribute('aria-hidden', String(!visible));
}
