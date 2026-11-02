export const HTML_TABLE_RE = /<table\b/i;

export function isStandaloneHtmlTable(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const tables = Array.from(doc.body.querySelectorAll('table'));
  if (tables.length !== 1) return false;

  const body = doc.body.cloneNode(true) as HTMLElement;
  body.querySelectorAll('table, style, script, meta, link').forEach((node) => node.remove());
  return body.textContent?.trim().length === 0;
}
