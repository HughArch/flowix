'use client';

import type { Editor } from '@tiptap/core';
import type { CSSProperties } from 'react';
import { useI18n, type I18nKey } from '@/lib/i18n';
import {
  FLOWIX_TEXT_COLORS,
  isFlowixTextColor,
  type FlowixTextColor,
  type FlowixTextMarkAttributes,
  setFlowixTextStyle,
} from '@features/editor/extensions/flowix-text-mark';
import {
  getFlowixBlockBackground,
  hasFlowixBlockBackgroundTargets,
  setFlowixBlockBackground,
} from '@features/editor/extensions/flowix-block-background';

interface FlowixHighlightPaletteProps {
  editor: Editor;
}

const flowixColorLabelKeys: Record<FlowixTextColor, I18nKey> = {
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

export function FlowixHighlightPalette({
  editor,
}: FlowixHighlightPaletteProps) {
  const { t } = useI18n();
  const attrs = editor.getAttributes('highlight') as FlowixTextMarkAttributes;
  const currentBg = isFlowixTextColor(attrs.flowixBg) ? attrs.flowixBg : null;
  const currentFg = isFlowixTextColor(attrs.flowixFg) ? attrs.flowixFg : null;
  const blockBackgroundAvailable = hasFlowixBlockBackgroundTargets(editor, { preferBlockSelection: false });
  const currentBlockBg = blockBackgroundAvailable
    ? getFlowixBlockBackground(editor, { preferBlockSelection: false })
    : null;

  const apply = (patch: { bg?: FlowixTextColor | null; fg?: FlowixTextColor | null }) => {
    setFlowixTextStyle(editor, patch);
  };

  const applyBlockBackground = (color: FlowixTextColor | null) => {
    // The bubble-menu palette always describes the current text selection,
    // even if the drag handle still holds an older multi-block selection.
    setFlowixBlockBackground(editor, color, { preferBlockSelection: false });
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
          {FLOWIX_TEXT_COLORS.map((color) => (
            <button
              key={`background-${color}`}
              className="editor-highlight-palette__swatch editor-highlight-palette__swatch--background"
              data-active={currentBg === color}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => apply({ bg: currentBg === color ? null : color })}
              style={{ '--flowix-swatch-color': `var(--flowix-text-${color})` } as CSSProperties}
              aria-pressed={currentBg === color}
              aria-label={t(flowixColorLabelKeys[color])}
              title={t(flowixColorLabelKeys[color])}
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
            {FLOWIX_TEXT_COLORS.map((color) => (
              <button
                key={`line-background-${color}`}
                className="editor-highlight-palette__swatch editor-highlight-palette__swatch--line-background"
                data-active={currentBlockBg === color}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => applyBlockBackground(currentBlockBg === color ? null : color)}
                style={{ '--flowix-swatch-color': `var(--flowix-text-${color})` } as CSSProperties}
                aria-pressed={currentBlockBg === color}
                aria-label={t(flowixColorLabelKeys[color])}
                title={t(flowixColorLabelKeys[color])}
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
          {FLOWIX_TEXT_COLORS.map((color) => (
            <button
              key={`foreground-${color}`}
              className="editor-highlight-palette__swatch editor-highlight-palette__swatch--foreground"
              data-active={currentFg === color}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => apply({ fg: currentFg === color ? null : color })}
              style={{ '--flowix-swatch-color': `var(--flowix-text-${color})` } as CSSProperties}
              aria-pressed={currentFg === color}
              aria-label={t(flowixColorLabelKeys[color])}
              title={t(flowixColorLabelKeys[color])}
            >
              <span>A</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
