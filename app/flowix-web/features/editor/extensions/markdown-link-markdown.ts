import { Extension, type MarkdownParseHelpers, type MarkdownToken, type PasteRuleMatch, type InputRuleMatch } from '@tiptap/core';
import { isVideoUrl } from '@features/editor/extensions/attachment-link/markdown/asset-markdown';
import { sanitizeLinkHref } from '@/lib/safe-link';

interface ParsedMarkdownLink {
  raw: string;
  text: string;
  href: string;
  title: string | null;
}

const ASSET_URL_RE = /^(asset:\/\/|https?:\/\/asset\.localhost\/)/i;
const MARKDOWN_LINK_RE = /!?\[([^\]\n]+)\]\(([^)\n]+)\)/g;
const FLOWIX_MEMO_URL_RE = /^flowix:\/\/memo\/.*$/i;

export function normalizePlainLinkHref(url: string | null | undefined): string {
  const safeHref = sanitizeLinkHref(url);
  if (!safeHref) return '';
  const trimmed = safeHref.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) return `http:${trimmed}`;
  if (trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed.startsWith('?')) return trimmed;
  return `http://${trimmed}`;
}

function stripAngleBracketDestination(destination: string): string {
  return destination.startsWith('<') && destination.endsWith('>')
    ? destination.slice(1, -1).trim()
    : destination;
}

function normalizeMarkdownDestination(url: string | null | undefined): string {
  const safeHref = sanitizeLinkHref(url);
  if (!safeHref) return '';
  const destination = stripAngleBracketDestination(safeHref);
  if (!destination || /^[a-z][a-z0-9+.-]*:/i.test(destination) || destination.startsWith('//')) {
    return normalizePlainLinkHref(destination);
  }
  return destination;
}

export function isPlainMarkdownLinkUrl(url: string | null | undefined): boolean {
  if (!url || FLOWIX_MEMO_URL_RE.test(url) || ASSET_URL_RE.test(url) || isVideoUrl(url)) return false;
  return true;
}

function stripOptionalTitle(destination: string): { href: string; title: string | null } {
  const trimmed = destination.trim();
  const bracketTitleMatch = /^<(.+)>\s+["']([^"']*)["']$/.exec(trimmed);
  if (bracketTitleMatch) {
    return { href: normalizeMarkdownDestination(bracketTitleMatch[1]), title: bracketTitleMatch[2] || null };
  }
  const titleMatch = /^(\S+)\s+["']([^"']*)["']$/.exec(trimmed);
  if (!titleMatch) return { href: normalizeMarkdownDestination(trimmed), title: null };
  return { href: normalizeMarkdownDestination(titleMatch[1]), title: titleMatch[2] || null };
}

function parseMarkdownLinkMatch(match: RegExpExecArray): ParsedMarkdownLink | null {
  const raw = match[0];
  if (raw.startsWith('!')) return null;
  const text = match[1]?.trim();
  const { href, title } = stripOptionalTitle(match[2] ?? '');
  if (!text || !isPlainMarkdownLinkUrl(href)) return null;
  return { raw, text, href, title };
}

export function findLastMarkdownLink(text: string): InputRuleMatch | null {
  let found: InputRuleMatch | null = null;
  MARKDOWN_LINK_RE.lastIndex = 0;
  for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
    if (match.index === undefined) continue;
    const parsed = parseMarkdownLinkMatch(match);
    if (!parsed || match.index + parsed.raw.length !== text.length) continue;
    found = {
      index: match.index,
      text: parsed.raw,
      replaceWith: parsed.text,
      data: { href: parsed.href, title: parsed.title },
    };
  }
  return found;
}

export function findMarkdownLinkPasteMatches(text: string): PasteRuleMatch[] {
  const matches: PasteRuleMatch[] = [];
  MARKDOWN_LINK_RE.lastIndex = 0;
  for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
    if (match.index === undefined) continue;
    const parsed = parseMarkdownLinkMatch(match);
    if (!parsed) continue;
    matches.push({
      index: match.index,
      text: parsed.raw,
      replaceWith: parsed.text,
      data: { href: parsed.href, title: parsed.title },
    });
  }
  return matches;
}

export const markdownLinkMarkdownSpec = {
  parseMarkdown(token: MarkdownToken, helpers: MarkdownParseHelpers) {
    if (!isPlainMarkdownLinkUrl(token.href)) return null;
    return helpers.applyMark('link', helpers.parseInline(token.tokens || []), {
      href: normalizeMarkdownDestination(token.href),
      title: token.title || null,
    });
  },
};

// @ts-expect-error The Markdown runtime accepts null to let subsequent handlers process non-link tokens.
export const MarkdownLinkParserExtension = Extension.create({
  name: 'link',
  priority: 50,
  ...markdownLinkMarkdownSpec,
});
