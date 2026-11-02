# Flag artwork attribution

The SVG files under `flag-assets/` are **Twemoji** graphics, copied verbatim
from the `@twemoji/svg` package by `scripts/generate-flag-assets.mjs`.

- Project: https://github.com/jdecked/twemoji
- License: CC-BY 4.0 — https://creativecommons.org/licenses/by/4.0/
- Copyright 2020 Twitter, Inc and other contributors

They are used only for the Unicode *flags* group in the callout emoji picker.
Windows' Segoe UI Emoji has no national-flag glyphs, so those entries would
otherwise render as regional-indicator letters.

`1f1e8-1f1f6` (Sark) is not present in Twemoji 15. The catalog generator hides
Emoji 16+ entries that have neither a system glyph nor artwork, so it does not
appear in the picker until upstream support arrives.
