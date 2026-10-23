export const JSON_FOLD_LANGUAGES = ['json', 'jsonc', 'json5'] as const;

const MAX_JSON_FOLD_CHARS = 200_000;
const MAX_JSON_FOLD_RANGES = 2000;

export interface JsonFoldRange {
  /** Offset of the opening `{` or `[` in the code text. */
  openOffset: number;
  openChar: '{' | '[';
  closeOffset: number;
  /** Offset of the first character on the opener's line. */
  lineStart: number;
  /** Offset right after the opener line's newline. */
  hiddenStart: number;
  /** Offset of the closer line's first character. */
  hiddenEnd: number;
  depth: number;
}

export interface JsonFoldScan {
  valid: boolean;
  ranges: JsonFoldRange[];
}

export function isJsonFoldableLanguage(language: unknown): boolean {
  if (typeof language !== 'string') return false;
  return (JSON_FOLD_LANGUAGES as readonly string[]).includes(language.trim().toLowerCase());
}

/**
 * Scan JSON-family source for foldable container ranges.
 *
 * Only containers whose opener and closer sit on different lines are
 * returned. The hidden span starts after the opener's line and ends at the
 * closer line's first character, so both the `{` line and the `}` line stay
 * visible when folded. A closer followed by anything other than whitespace
 * or a comma on its line is not foldable — hiding it would also swallow
 * sibling values.
 */
export function scanJsonFoldRanges(text: string, language: string): JsonFoldScan {
  if (text.length === 0 || text.length > MAX_JSON_FOLD_CHARS) {
    return { valid: false, ranges: [] };
  }

  const ranges: JsonFoldRange[] = [];
  const stack: Array<{ char: '{' | '['; offset: number; lineStart: number; depth: number }> = [];
  let lineStart = 0;
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        lineStart = index + 1;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      } else if (char === '\n') {
        lineStart = index + 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      } else if (char === '\n') {
        return { valid: false, ranges: [] };
      }
      continue;
    }

    if (char === '\n') {
      lineStart = index + 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (char === '{' || char === '[') {
      stack.push({ char, offset: index, lineStart, depth: stack.length + 1 });
      continue;
    }

    if (char === '}' || char === ']') {
      const opener = stack.pop();
      const expected = char === '}' ? '{' : '[';
      if (!opener || opener.char !== expected) return { valid: false, ranges: [] };
      if (opener.lineStart === lineStart) continue;

      const openerLineEnd = text.indexOf('\n', opener.offset);
      if (openerLineEnd < 0) continue;

      const hiddenStart = openerLineEnd + 1;
      const hiddenEnd = lineStart;
      if (hiddenEnd <= hiddenStart) continue;

      const closerLineEnd = text.indexOf('\n', index + 1);
      const rest = text.slice(index + 1, closerLineEnd < 0 ? text.length : closerLineEnd).trim();
      if (rest !== '' && rest !== ',') continue;

      ranges.push({
        openOffset: opener.offset,
        openChar: opener.char,
        closeOffset: index,
        lineStart: opener.lineStart,
        hiddenStart,
        hiddenEnd,
        depth: opener.depth,
      });
    }
  }

  if (inString || inBlockComment || stack.length > 0) return { valid: false, ranges: [] };
  if (ranges.length > MAX_JSON_FOLD_RANGES) return { valid: false, ranges: [] };

  if (language.trim().toLowerCase() === 'json') {
    try {
      JSON.parse(text);
    } catch {
      return { valid: false, ranges: [] };
    }
  }

  return { valid: true, ranges: dedupeByLineStart(ranges) };
}

/** One toggle per line: keep the outermost container when several openers share a line. */
function dedupeByLineStart(ranges: JsonFoldRange[]): JsonFoldRange[] {
  const byLine = new Map<number, JsonFoldRange>();
  for (const range of ranges) {
    const current = byLine.get(range.lineStart);
    if (!current || range.depth < current.depth) byLine.set(range.lineStart, range);
  }
  return Array.from(byLine.values()).sort((a, b) => a.lineStart - b.lineStart);
}
