/**
 * Fenced-div line helpers shared by the columns and callout Markdown scanners.
 *
 * Flowix stores container blocks as CommonMark-style fenced divs:
 *
 * ```
 * ::: callout icon="💡"
 * content
 * :::
 * ```
 *
 * Nested containers may use longer fences (`:::: column`). A closing fence
 * closes the innermost opener only when it is at least as long as that opener
 * (CommonMark's rule), so the scanners must compare fence lengths rather than
 * counting bare `:::` lines.
 */

const FENCED_DIV_OPEN_RE = /^(:{3,})[ \t]+([A-Za-z][\w-]*)(.*)$/;
const FENCED_DIV_CLOSE_RE = /^(:{3,})[ \t]*$/;

export interface FencedDivOpen {
  /** Number of leading colons. */
  fenceLength: number;
  /** Container name (`callout`, `columns`, `column`, …). */
  name: string;
  /** Everything after the name, still unparsed (` icon="💡"`, ` width=100`). */
  rest: string;
}

function withoutCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** Parse an opening fence line; returns null for ordinary content. */
export function fencedDivOpen(line: string): FencedDivOpen | null {
  const match = FENCED_DIV_OPEN_RE.exec(withoutCarriageReturn(line));
  if (!match) return null;
  return {
    fenceLength: match[1].length,
    name: match[2],
    rest: match[3] ?? '',
  };
}

/** Parse a closing fence line; returns its colon count or null. */
export function fencedDivClose(line: string): number | null {
  const match = FENCED_DIV_CLOSE_RE.exec(withoutCarriageReturn(line));
  return match ? match[1].length : null;
}

/** CommonMark fence matching: the closing fence must be at least as long. */
export function closesFence(closeLength: number, openLength: number): boolean {
  return closeLength >= openLength;
}
