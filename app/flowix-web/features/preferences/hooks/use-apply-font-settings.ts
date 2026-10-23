'use client';

import { useEffect } from 'react';
import {
  DOCUMENT_WIDTH_FULL_THRESHOLD,
  PAGE_WIDTH_SCALE_MAX,
  normalizePageWidthScale,
  type FormatConfig,
} from '@/lib/constants';
import {
  ensureDownloadedFontRegistered,
  getFontOptionById,
  getFontOptionByValue,
  isDownloadableFont,
} from '@features/preferences/font-cache';

/**
 * 将用户在「Preferences → Format」中选择的字体/字号/行间距/文档宽度写入 :root
 * 的 CSS 变量。
 *
 * 变量写入 :root 是为了 hook 点稳定, 但消费方 (css/editor.css 的
 * .markdown-editor .ProseMirror) 是唯一应用这些变量的地方 ——
 * 不再写到 body / html, 因此这些设置只影响 Tiptap 编辑器内容区,
 * 不会泄漏到 MemoList、shadcn 按钮等其它 UI 文本。
 *
 * 与之配套的变量定义在 css/index.css :
 *   --editor-font-family
 *   --editor-font-size
 *   --editor-line-height
 *   --editor-document-width
 *   --editor-document-max-width (documentWidth × pageWidthScale 的最终值)
 *
 * 调用方: app.tsx (主窗口 + 偏好设置窗口都会挂载, 因此跨窗口都会立即响应)。
 */

/**
 * 把「文档宽度」与「页面宽度比例」合成最终的内容列 `max-width`。
 *
 * 比例的基准就是当前文档宽度本身：100% 完全不改变现状（可能是固定 px，
 * 也可能是全宽），低于 100% 时按比例收窄。全宽档位用 `100%` 作为基准参与
 * `calc()` —— CSS 不允许 `none` 参与运算，所以不能把 `none` 直接传下去。
 */
export function resolveEditorDocumentMaxWidth(
  documentWidth: number,
  pageWidthScale: number | undefined,
): string {
  const base = documentWidth > DOCUMENT_WIDTH_FULL_THRESHOLD ? '100%' : `${documentWidth}px`;
  const scale = normalizePageWidthScale(pageWidthScale);
  // 100% 时输出基准值本身, 让浏览器拿到和旧实现完全相同的 max-width。
  return scale >= PAGE_WIDTH_SCALE_MAX ? base : `calc(${base} * ${scale / 100})`;
}

export function useApplyFontSettings(format: FormatConfig | undefined) {
  useEffect(() => {
    if (!format) return;
    const font = getFontOptionById(format.fontId) ?? getFontOptionByValue(format.fontFamily);
    if (!font || !isDownloadableFont(font)) return;
    ensureDownloadedFontRegistered(font.id).catch((error) => {
      console.warn('Failed to register downloaded font:', error);
    });
  }, [format?.fontId, format?.fontFamily]);

  useEffect(() => {
    if (!format) return;
    const root = document.documentElement;
    if (format.fontFamily) {
      // Emoji must be considered before platform emoji fonts even when a user
      // selects a custom document font. This face only covers emoji codepoints,
      // so placing it first leaves ordinary text to the selected font stack.
      root.style.setProperty('--editor-font-family', `'Flowix Small Emoji', ${format.fontFamily}`);
    }
    if (typeof format.fontSize === 'number' && !Number.isNaN(format.fontSize)) {
      root.style.setProperty('--editor-font-size', `${format.fontSize}px`);
    }
    if (typeof format.lineHeight === 'number' && !Number.isNaN(format.lineHeight)) {
      root.style.setProperty('--editor-line-height', String(format.lineHeight));
    }
    if (typeof format.documentWidth === 'number' && !Number.isNaN(format.documentWidth)) {
      root.style.setProperty(
        '--editor-document-width',
        format.documentWidth > DOCUMENT_WIDTH_FULL_THRESHOLD ? 'none' : `${format.documentWidth}px`,
      );
      root.style.setProperty(
        '--editor-document-max-width',
        resolveEditorDocumentMaxWidth(format.documentWidth, format.pageWidthScale),
      );
    }
  }, [format?.fontFamily, format?.fontSize, format?.lineHeight, format?.documentWidth, format?.pageWidthScale]);
}
