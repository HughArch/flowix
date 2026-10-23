#!/usr/bin/env node
/**
 * Generate the callout emoji picker catalog from `emojibase-data`.
 *
 * Source: https://github.com/iamcal/emoji-data (emojibase-data, MIT), built from
 * Unicode CLDR annotations. We ship a trimmed catalog (Unicode character,
 * English/Chinese labels, search keywords) as a lazily imported module so the
 * startup bundle stays untouched.
 *
 * Regenerate after bumping `emojibase-data`:
 *   npm run emoji:catalog
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = path.join(
  repoRoot,
  'app/flowix-web/features/editor/extensions/callout/emoji-catalog.ts',
)

function readData(relativePath) {
  const packageDir = path.dirname(require.resolve('emojibase-data/package.json'))
  return JSON.parse(fs.readFileSync(path.join(packageDir, relativePath), 'utf8'))
}

const en = readData('en/compact.json')
const zh = readData('zh/compact.json')
const full = readData('en/data.json')
const meta = readData('meta/groups.json')
const enMessages = readData('en/messages.json')
const zhMessages = readData('zh/messages.json')

/**
 * Current system fonts top out around Emoji 15.1. Entries newer than that are
 * only kept when we ship artwork for them; otherwise they render as tofu on
 * Windows. They come back automatically once Twemoji (or the OS font) catches
 * up — the check below is data-driven, not a hand-maintained list.
 */
const MAX_SYSTEM_EMOJI_VERSION = 15.1
const emojiVersions = new Map(full.map((emoji) => [emoji.hexcode, Number(emoji.version)]))
const twemojiDir = path.dirname(require.resolve('@twemoji/svg/package.json'))

function twemojiKey(unicode) {
  return Array.from(unicode)
    .map((codepoint) => codepoint.codePointAt(0).toString(16))
    .join('-')
}

function hasTwemojiArtwork(unicode) {
  const key = twemojiKey(unicode)
  const withoutVariationSelectors = key.split('-').filter((part) => part !== 'fe0f').join('-')
  return fs.existsSync(path.join(twemojiDir, `${key}.svg`))
    || fs.existsSync(path.join(twemojiDir, `${withoutVariationSelectors}.svg`))
}

function isRenderable(emoji) {
  const version = emojiVersions.get(emoji.hexcode) ?? 0
  if (version <= MAX_SYSTEM_EMOJI_VERSION) return true
  return typeof emoji.unicode === 'string' && hasTwemojiArtwork(emoji.unicode)
}

const zhByHexcode = new Map(zh.map((emoji) => [emoji.hexcode, emoji]))
const enGroupNames = new Map(enMessages.groups.map((group) => [group.key, group.message]))
const zhGroupNames = new Map(zhMessages.groups.map((group) => [group.key, group.message]))

/** Short tab labels; the CLDR names are accurate but too long for chips. */
const GROUP_LABEL_OVERRIDES = {
  'smileys-emotion': { zh: '表情', en: 'Smileys' },
  'people-body': { zh: '动作', en: 'People' },
  'animals-nature': { zh: '动物', en: 'Animals' },
  'food-drink': { zh: '食物', en: 'Food' },
  'travel-places': { zh: '旅行', en: 'Travel' },
  activities: { zh: '活动', en: 'Activities' },
  objects: { zh: '物品', en: 'Objects' },
  symbols: { zh: '符号', en: 'Symbols' },
  flags: { zh: '旗帜', en: 'Flags' },
}

// `meta.groups` is `{ "0": "smileys-emotion", … }`. Component (skin tones,
// hair) and the group-less regional-indicator letters are not picker material.
const groups = Object.entries(meta.groups)
  .map(([id, key]) => ({ id: Number(id), key }))
  .filter((group) => group.key !== 'component')
  .sort((left, right) => left.id - right.id)

const MAX_TAGS = 12
const MAX_SEARCH_TEXT = 240

function uniqueTags(values, excluded) {
  const seen = new Set()
  const tags = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const tag = value.trim()
    if (!tag) continue
    const normalized = tag.toLowerCase()
    if (excluded.has(normalized) || seen.has(normalized)) continue
    seen.add(normalized)
    tags.push(tag)
    if (tags.length >= MAX_TAGS) break
  }
  return tags
}

function toEntry(emoji, isFlag) {
  const localized = zhByHexcode.get(emoji.hexcode)
  const enLabel = typeof emoji.label === 'string' ? emoji.label : ''
  const zhLabel = typeof localized?.label === 'string' ? localized.label : enLabel
  const excluded = new Set([enLabel.toLowerCase(), zhLabel.toLowerCase()])
  // Chinese tags first: they are what most users type. English tags keep the
  // picker searchable for English UI users.
  const tags = uniqueTags([...(localized?.tags ?? []), ...(emoji.tags ?? [])], excluded)

  return {
    u: emoji.unicode,
    n: enLabel,
    z: zhLabel,
    k: tags.join(' ').toLowerCase().slice(0, MAX_SEARCH_TEXT),
    // Flags render as local Twemoji SVGs: Windows' emoji font has no national
    // flag glyphs. The key matches the generated flag asset filename.
    ...(isFlag ? { f: emoji.hexcode.toLowerCase() } : {}),
  }
}

const catalog = groups.map((group) => {
  const emojis = en
    .filter((emoji) => (
      emoji.group === group.id
      && typeof emoji.unicode === 'string'
      && emoji.unicode.length > 0
      && isRenderable(emoji)
    ))
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    .map((emoji) => toEntry(emoji, group.key === 'flags'))

  const overrides = GROUP_LABEL_OVERRIDES[group.key]

  return {
    id: group.key,
    nameEn: overrides?.en ?? enGroupNames.get(group.key) ?? group.key,
    nameZh: overrides?.zh ?? zhGroupNames.get(group.key) ?? enGroupNames.get(group.key) ?? group.key,
    emojis,
  }
})

const total = catalog.reduce((sum, group) => sum + group.emojis.length, 0)
const hidden = en.filter((emoji) => (
  emoji.group != null
  && emoji.group !== 2
  && typeof emoji.unicode === 'string'
  && emoji.unicode.length > 0
  && !isRenderable(emoji)
)).length

const header = `// Generated by scripts/generate-emoji-catalog.mjs — do not edit by hand.
// Source: emojibase-data@${readData('package.json').version} (MIT),
// derived from Unicode CLDR annotations. Regenerate with: npm run emoji:catalog
/* eslint-disable */

export interface CalloutEmojiEntry {
  /** Unicode emoji character. */
  u: string;
  /** English label. */
  n: string;
  /** Chinese label. */
  z: string;
  /** Lowercased search keywords from both locales. */
  k: string;
  /** Flag artwork key (lowercase hexcode); flags render as local SVGs. */
  f?: string;
}

export interface CalloutEmojiGroup {
  id: string;
  nameEn: string;
  nameZh: string;
  emojis: CalloutEmojiEntry[];
}

/** ${total} emoji across ${catalog.length} groups, sorted by group/order. */
export const CALLOUT_EMOJI_GROUPS: CalloutEmojiGroup[] = `

fs.writeFileSync(outputPath, `${header}${JSON.stringify(catalog)}\n`)
const bytes = fs.statSync(outputPath).size
console.log(
  `emoji catalog: ${total} emoji, ${catalog.length} groups, ${hidden} newer emoji hidden (no system glyph or artwork), ${(bytes / 1024).toFixed(1)} KB -> ${path.relative(repoRoot, outputPath)}`,
)
