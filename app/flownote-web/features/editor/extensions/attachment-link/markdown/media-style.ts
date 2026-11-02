export const FLOWNOTE_MEDIA_STYLE_VERSION = 1;

export interface FlownoteMediaStyleSuffix {
  raw: string;
  style: Record<string, unknown>;
}

const FLOWNOTE_MEDIA_STYLE_COMMENT_RE = /^<!--[ \t]*flownote:media[ \t]+(\{[^\r\n]*\})[ \t]*-->(?:\r?\n)+/;

function readJsonObject(source: string): { raw: string; value: unknown } | null {
  if (!source.startsWith('{')) return null;

  let depth = 0;
  let escaped = false;
  let inString = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth !== 0) continue;

      const raw = source.slice(0, index + 1);
      try {
        return { raw, value: JSON.parse(raw) };
      } catch {
        return null;
      }
    }
  }

  return null;
}

export function parseFlownoteMediaStyleSuffix(source: string): FlownoteMediaStyleSuffix | null {
  const parsed = readJsonObject(source);
  if (!parsed || !parsed.value || typeof parsed.value !== 'object') return null;

  const metadata = parsed.value as {
    flownote?: unknown;
    version?: unknown;
    style?: unknown;
  };
  if (
    metadata.flownote !== 'media' ||
    metadata.version !== FLOWNOTE_MEDIA_STYLE_VERSION ||
    !metadata.style ||
    typeof metadata.style !== 'object' ||
    Array.isArray(metadata.style)
  ) {
    return null;
  }

  return {
    raw: parsed.raw,
    style: metadata.style as Record<string, unknown>,
  };
}

export function parseFlownoteMediaStyleComment(source: string): FlownoteMediaStyleSuffix | null {
  const match = FLOWNOTE_MEDIA_STYLE_COMMENT_RE.exec(source);
  if (!match) return null;

  const parsed = parseFlownoteMediaStyleSuffix(match[1]);
  return parsed ? { raw: match[0], style: parsed.style } : null;
}

export function renderFlownoteMediaStyleComment(style: Record<string, unknown>): string {
  if (Object.keys(style).length === 0) return '';

  const metadata = JSON.stringify({
    flownote: 'media',
    version: FLOWNOTE_MEDIA_STYLE_VERSION,
    style,
  });
  return `<!-- flownote:media ${metadata} -->\n`;
}
