'use client';

import type { Editor } from '@tiptap/core';
import type { CSSProperties } from 'react';
import { useI18n, type I18nKey } from '@/lib/i18n';
import {
  FLOWNOTE_TEXT_COLORS,
  isFlownoteTextColor,
  type FlownoteTextColor,
  type FlownoteTextMarkAttributes,
  setFlownoteTextStyle,
} from '@features/editor/extensions/flownote-text-mark';
import {
  getFlownoteBlockBackground,
  hasFlownoteBlockBackgroundTargets,
  setFlownoteBlockBackground,
} from '@features/editor/extensions/flownote-block-background';

interface FlownoteHighlightPaletteProps {
  editor: Editor;
}

const flownoteColorLabelKeys: Record<FlownoteTextColor, I18nKey> = {
  red: 'editor.highlight.red',
  orange: 'editor.highlight.orange',
  yellow: 'editor.highlight.yellow',
  green: 'editor.highlight.green',
  cyan: 'editor.highlight.cyan',
  blue: 'editor.highlight.blue',
  purple: 'editor.highlight.purple',
  pink: 'editor.highlight.pink',
  gray: 'editor.highlight.gray',
};

export function FlownoteHighlightPalette({
  editor,
}: FlownoteHighlightPaletteProps) {
  const { t } = useI18n();
  const attrs = editor.getAttributes('highlight') as FlownoteTextMarkAttributes;
  const currentBg = isFlownoteTextColor(attrs.flownoteBg) ? attrs.flownoteBg : null;
  const currentFg = isFlownoteTextColor(attrs.flownoteFg) ? attrs.flownoteFg : null;
  const blockBackgroundAvailable = hasFlownoteBlockBackgroundTargets(editor, { preferBlockSelection: false });
  const currentBlockBg = blockBackgroundAvailable
    ? getFlownoteBlockBackground(editor, { preferBlockSelection: false })
    : null;

  const apply = (patch: { bg?: FlownoteTextColor | null; fg?: FlownoteTextColor | null }) => {
    setFlownoteTextStyle(editor, patch);
  };

  const applyBlockBackground = (color: FlownoteTextColor | null) => {
    // The bubble-menu palette always describes the current text selection,
    // even if the drag handle still holds an older multi-block selection.
    setFlownoteBlockBackground(editor, color, { preferBlockSelection: false });
  };

  return (
    <div className="editor-highlight-palette">
      <div className="editor-highlight-palette__section">
        <div className="editor-highlight-palette__heading">
          <div className="editor-highlight-palette__label">{t('editor.highlight.background')}</div>
        </div>
        <div className="editor-highlight-palette__swatches">
          <button
            className="editor-highlight-palette__swatch editor-highlight-palette__swatch--default"
            data-active={currentBg === null}
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => apply({ bg: null })}
            aria-pressed={currentBg === null}
            aria-label={t('editor.highlight.default')}
            title={t('editor.highlight.default')}
          />
          {FLOWNOTE_TEXT_COLORS.map((color) => (
            <button
              key={`background-${color}`}
              className="editor-highlight-palette__swatch editor-highlight-palette__swatch--background"
              data-active={currentBg === color}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => apply({ bg: currentBg === color ? null : color })}
              style={{ '--flownote-swatch-color': `var(--flownote-text-${color})` } as CSSProperties}
              aria-pressed={currentBg === color}
              aria-label={t(flownoteColorLabelKeys[color])}
              title={t(flownoteColorLabelKeys[color])}
            />
          ))}
        </div>
      </div>
      {blockBackgroundAvailable && (
        <div className="editor-highlight-palette__section">
          <div className="editor-highlight-palette__heading">
            <div className="editor-highlight-palette__label">{t('editor.highlight.lineBackground')}</div>
          </div>
          <div className="editor-highlight-palette__swatches">
            <button
              className="editor-highlight-palette__swatch editor-highlight-palette__swatch--default"
              data-active={currentBlockBg === null}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => applyBlockBackground(null)}
              aria-pressed={currentBlockBg === null}
              aria-label={t('editor.highlight.defaultLineBackground')}
              title={t('editor.highlight.defaultLineBackground')}
            />
            {FLOWNOTE_TEXT_COLORS.map((color) => (
              <button
                key={`line-background-${color}`}
                className="editor-highlight-palette__swatch editor-highlight-palette__swatch--line-background"
                data-active={currentBlockBg === color}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => applyBlockBackground(currentBlockBg === color ? null : color)}
                style={{ '--flownote-swatch-color': `var(--flownote-text-${color})` } as CSSProperties}
                aria-pressed={currentBlockBg === color}
                aria-label={t(flownoteColorLabelKeys[color])}
                title={t(flownoteColorLabelKeys[color])}
              />
            ))}
          </div>
        </div>
      )}
      <div className="editor-highlight-palette__section">
        <div className="editor-highlight-palette__heading">
          <div className="editor-highlight-palette__label">{t('editor.highlight.foreground')}</div>
        </div>
        <div className="editor-highlight-palette__swatches">
          <button
            className="editor-highlight-palette__swatch editor-highlight-palette__swatch--default"
            data-active={currentFg === null}
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => apply({ fg: null })}
            aria-pressed={currentFg === null}
            aria-label={t('editor.highlight.inherit')}
            title={t('editor.highlight.inherit')}
          />
          {FLOWNOTE_TEXT_COLORS.map((color) => (
            <button
              key={`foreground-${color}`}
              className="editor-highlight-palette__swatch editor-highlight-palette__swatch--foreground"
              data-active={currentFg === color}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => apply({ fg: currentFg === color ? null : color })}
              style={{ '--flownote-swatch-color': `var(--flownote-text-${color})` } as CSSProperties}
              aria-pressed={currentFg === color}
              aria-label={t(flownoteColorLabelKeys[color])}
              title={t(flownoteColorLabelKeys[color])}
            >
              <span>A</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
