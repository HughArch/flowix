#!/usr/bin/env node
/**
 * Copy flag artwork into the callout emoji picker.
 *
 * Windows' system emoji font (Segoe UI Emoji) does not include national flag
 * sequences, so flags render as regional-indicator letters. Shipping the small
 * subset of Twemoji SVGs used by the Unicode "flags" group gives every platform
 * the same coloured flags.
 *
 * Source: @twemoji/svg (Twitter Twemoji, CC-BY 4.0).
 * Regenerate after bumping the package:
 *   npm run emoji:flags
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const twemojiDir = path.dirname(require.resolve('@twemoji/svg/package.json'))
const emojibaseDir = path.dirname(require.resolve('emojibase-data/package.json'))
const compact = JSON.parse(
  fs.readFileSync(path.join(emojibaseDir, 'en/compact.json'), 'utf8'),
)

const flags = compact.filter(
  (emoji) => emoji.group === 9 && typeof emoji.unicode === 'string' && emoji.unicode.length > 0,
)

const destination = path.join(
  repoRoot,
  'app/flowix-web/features/editor/extensions/callout/flag-assets',
)
fs.rmSync(destination, { recursive: true, force: true })
fs.mkdirSync(destination, { recursive: true })

const missing = []
let copied = 0
for (const flag of flags) {
  const key = flag.hexcode.toLowerCase()
  const source = path.join(twemojiDir, `${key}.svg`)
  if (!fs.existsSync(source)) {
    missing.push(key)
    continue
  }
  fs.copyFileSync(source, path.join(destination, `${key}.svg`))
  copied += 1
}

console.log(`flag assets: ${copied} copied, ${missing.length} missing`)
if (missing.length > 0) {
  // The catalog generator hides Emoji 16+ entries without artwork, so a
  // missing file is expected when emojibase is newer than Twemoji.
  console.warn(`missing Twemoji files (hidden from the picker):\n${missing.join('\n')}`)
}
